// LLM-driven Q&A against repo context (see notes.md / ROADMAP.md Phase 5).
// Context retrieval is targeted: the repo's file tree (paths only) is fetched
// up front, and the model requests specific file contents by path as needed
// via a FETCH_FILE directive, resolved inline before the model's next turn is
// shown to the user - so file-fetch round-trips never appear in the
// conversation transcript itself. When the model decides a requirement is
// fully clarified, it emits FINALIZE_REQUIREMENT, which triggers overlap
// detection and writes a session_requirements row.
const db = require('./db');
const modelAdapter = require('./model/modelAdapter');
const usageService = require('./model/usageService');
const overlapService = require('./overlapService');
const auditLog = require('./auditLog');
const repoClarificationInstructions = require('./repoClarificationInstructions');
const repoContext = require('./repoContext');

const MAX_FILE_FETCHES = 5;

const SYSTEM_PROMPT = [
  "You are Apex's clarification assistant. An engineer is about to implement a Change",
  'Order (CO) in the repo below, and your job is to ask clarifying questions - grounded in',
  'the actual repo contents, not generic ones - before implementation starts.',
  '',
  "You are given the repo's file tree, with each file's size and approximate length. You",
  "do not have any file's contents unless you ask for them, and a file larger than the",
  'read limit comes back partial - the reply will say so when that happens.',
  '',
  'Respond using exactly ONE of these three modes, and nothing else:',
  '',
  '1. Ask a clarifying question: just write the question in plain text.',
  '2. Request a file: write a single line, exactly `FETCH_FILE: <path>`, and nothing else on',
  '   that turn. The tree below may not list every file in the repo - it says so when it is',
  '   abridged - so a path you have good reason to believe exists is worth requesting.',
  '3. Finalize: once the engineer has answered enough that an implementer could act without',
  '   further clarification, write `FINALIZE_REQUIREMENT:` followed by a newline and a',
  '   concise, complete restatement of the requirement that folds in everything learned.',
  '',
  'Ask about acceptance criteria, edge cases, and where in the codebase the change belongs',
  'when those are unclear. Do not finalize prematurely.',
].join('\n');

async function getConversation(sessionId) {
  const [rows] = await db.query('SELECT * FROM conversations WHERE session_id = ? ORDER BY id ASC', [sessionId]);
  return rows;
}

function toModelMessages(map, conversation, instructions) {
  const treeBlock = repoContext.renderTree(map);
  // Admin-authored guidance is a separate block from the file tree/FETCH_FILE
  // path - it's authoritative instruction, not repo content the model asked
  // for (see ROADMAP.md Phase 6).
  const instructionsBlock = instructions
    ? `\n\n=== ADMIN CLARIFICATION INSTRUCTIONS (authoritative) ===\n${instructions}`
    : '';
  return [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n=== FILE TREE ===\n${treeBlock}${instructionsBlock}` },
    ...conversation.map((row) => ({ role: row.role, content: row.content })),
  ];
}

// Resolves FETCH_FILE round-trips inline against a scratch copy of the
// message list; only the final question or finalize payload is returned for
// the caller to persist.
async function runModelLoop(messages, org, repo, branch, session) {
  const scratch = messages.slice();

  for (let attempt = 0; attempt < MAX_FILE_FETCHES; attempt++) {
    const result = await modelAdapter.generate(scratch);
    const reply = result.text.trim();
    usageService
      .recordUsage({
        callSite: 'clarification',
        sessionId: session.id,
        repoId: repo.id,
        provider: result.provider,
        model: result.model,
        usage: result.usage,
      })
      .catch(() => {});

    const fetchMatch = reply.match(/^FETCH_FILE:\s*(.+)$/);
    if (fetchMatch) {
      const path = fetchMatch[1].trim();
      // Truncation is announced here exactly as it is in codegen (see
      // ROADMAP.md Phase 19): this loop carried its own duplicate copy of the
      // same 8000-char cap and the same unmarked slice, so a clipped file read
      // as complete here too - and a requirement clarified against 6% of a
      // file is clarified against the wrong file.
      const record = await repoContext.readFileForModel(org.name, repo.name, path, branch.branch_name);
      scratch.push({ role: 'assistant', content: reply });
      scratch.push({
        role: 'user',
        content: repoContext.formatFileForModel(path, record, { ref: branch.branch_name }),
      });
      continue;
    }

    const finalizeMatch = reply.match(/^FINALIZE_REQUIREMENT:\s*([\s\S]+)$/);
    if (finalizeMatch) {
      return { kind: 'finalize', text: finalizeMatch[1].trim() };
    }

    return { kind: 'question', text: reply };
  }

  return {
    kind: 'question',
    text: "I wasn't able to gather enough context automatically - could you clarify further?",
  };
}

async function finalizeRequirement({ session, branch, org, repo, user, text }) {
  const overlap = await overlapService.checkOverlap({ org, repo, branch, newRequirementText: text, session });

  const [result] = await db.query(
    'INSERT INTO session_requirements (session_id, requirement_text, overlap_flag_requirement_id, confirm_status) VALUES (?, ?, ?, ?)',
    [session.id, text, overlap ? overlap.matchedRequirementId : null, overlap ? 'pending_confirm' : 'confirmed_proceed']
  );

  // Approval is never "locked in" (see ROADMAP.md Phase 8): a newly finalized
  // requirement - confirmed outright or pending a human's overlap call -
  // drops an already-approved, still-queued session back out of the approval
  // gate, since the scope of work it was approved for just changed. Only
  // 'queued' (not yet picked up by worker.js) reverts this way - a session
  // that's already 'running' is too late to un-approve.
  if (session.status === 'queued') {
    await db.query("UPDATE sessions SET status = 'awaiting_approval', approved_at = NULL WHERE id = ?", [session.id]);
    await auditLog.logAction({
      sessionId: session.id,
      userId: user.id,
      action: 'approval_reset',
      detail: 'A new requirement was finalized after approval - re-approval is required.',
    });
  }

  await auditLog.logAction({
    sessionId: session.id,
    userId: user.id,
    action: overlap ? 'overlap_detected' : 'requirement_finalized',
    detail: { requirementText: text, overlapFlagRequirementId: overlap ? overlap.matchedRequirementId : null },
  });

  return {
    id: result.insertId,
    session_id: session.id,
    requirement_text: text,
    overlap_flag_requirement_id: overlap ? overlap.matchedRequirementId : null,
    confirm_status: overlap ? 'pending_confirm' : 'confirmed_proceed',
  };
}

// submitMessage(...) -> { type: 'question', text } | { type: 'finalized', requirement }
async function submitMessage({ session, branch, org, repo, user, text }) {
  await db.query("INSERT INTO conversations (session_id, role, content) VALUES (?, 'user', ?)", [session.id, text]);
  await auditLog.logAction({ sessionId: session.id, userId: user.id, action: 'clarification_message', detail: text });

  const [tree, conversation, instructions] = await Promise.all([
    repoContext.fetchTree(org, repo, branch.branch_name),
    getConversation(session.id),
    repoClarificationInstructions.getInstructions(repo.id),
  ]);
  const messages = toModelMessages(tree, conversation, instructions);

  const result = await runModelLoop(messages, org, repo, branch, session);

  if (result.kind === 'question') {
    await db.query("INSERT INTO conversations (session_id, role, content) VALUES (?, 'assistant', ?)", [
      session.id,
      result.text,
    ]);
    await auditLog.logAction({ sessionId: session.id, userId: user.id, action: 'clarification_question', detail: result.text });
    return { type: 'question', text: result.text };
  }

  const requirement = await finalizeRequirement({ session, branch, org, repo, user, text: result.text });
  await db.query("INSERT INTO conversations (session_id, role, content) VALUES (?, 'assistant', ?)", [
    session.id,
    `Requirement recorded: ${result.text}`,
  ]);
  return { type: 'finalized', requirement };
}

module.exports = { submitMessage, getConversation };
