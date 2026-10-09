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
const structuralIndex = require('./structuralIndex');

const MAX_FILE_FETCHES = 5;

const SYSTEM_PROMPT = [
  "You are Apex's clarification assistant. An engineer is about to implement a Change",
  'Order (CO) in the repo below, and your job is to ask clarifying questions - grounded in',
  'the actual repo contents, not generic ones - before implementation starts.',
  '',
  "You are given the repo's file tree, with each file's size and length. You do not have",
  "any file's contents unless you ask for them, and a file larger than the read limit comes",
  'back partial - the reply will say so when that happens.',
  '',
  'Respond using exactly ONE of these modes, and nothing else:',
  '',
  '1. Ask a clarifying question: just write the question in plain text.',
  '2. Request a file: write a single line, exactly `FETCH_FILE: <path>`, and nothing else on',
  '   that turn. The tree below may not list every file in the repo - it says so when it is',
  '   abridged - so a path you have good reason to believe exists is worth requesting.',
  '3. Request part of a file: a single line, exactly `FETCH_RANGE: <path>:<start>-<end>`, with',
  '   1-based inclusive line numbers. Use this instead of FETCH_FILE on a large file - you',
  '   have very few requests available, so spend them on the regions that matter.',
  "4. Request a file's structure: a single line, exactly `FETCH_OUTLINE: <path>`. Returns the",
  "   file's declaration lines with their line ranges, when Apex has an outline for it.",
  '5. Finalize: once the engineer has answered enough that an implementer could act without',
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

function toModelMessages(map, index, conversation, instructions) {
  const treeBlock = repoContext.renderTree(map, index);
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

// Resolves FETCH_* round-trips inline against a scratch copy of the message
// list; only the final question or finalize payload is returned for the caller
// to persist.
//
// Reads here are served from GitHub, not from a container - clarification runs
// before any pipeline run, so there is no container to read from (see
// ROADMAP.md Phase 21: the index-bearing half of Apex starts at codegen). That
// is sound in a way the codegen side would not have been: nothing in this loop
// writes, so the branch tip cannot move out from under a line number
// mid-conversation the way a ranged read and an anchored write could drift
// apart.
//
// The model comes from `session.model`, stamped when the session was created
// (see db/schema.sql Phase 22) - so a whole clarification conversation stays on
// one model even if the user changes their selection partway through it.
async function runModelLoop(messages, org, repo, branch, session, index) {
  const scratch = messages.slice();

  for (let attempt = 0; attempt < MAX_FILE_FETCHES; attempt++) {
    const result = await modelAdapter.generate(scratch, { model: session.model });
    const reply = result.text.trim();
    usageService
      .recordUsage({
        callSite: 'clarification',
        sessionId: session.id,
        repoId: repo.id,
        provider: result.provider,
        model: result.model,
        usage: result.usage,
        price: result.price,
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

    // Phase 21. The win is the same one codegen gets - read the 200 lines that
    // matter instead of the first 8000 characters of a file that happens to
    // start with its licence header - and it matters more here, because this
    // loop gets at most MAX_FILE_FETCHES requests for the entire turn.
    const rangeMatch = reply.match(/^FETCH_RANGE:\s*(.+)$/);
    if (rangeMatch) {
      const spec = repoContext.parseRangeSpec(rangeMatch[1]);
      scratch.push({ role: 'assistant', content: reply });
      if (!spec) {
        scratch.push({
          role: 'user',
          content: 'Malformed FETCH_RANGE. The line must be exactly `FETCH_RANGE: <path>:<start>-<end>`.',
        });
        continue;
      }
      // Read whole, slice here: the contents API has no range form, so the
      // request cost is identical either way and only the *context* cost
      // differs - which is the cost this phase is about.
      const record = await repoContext.readFileForModel(org.name, repo.name, spec.path, branch.branch_name);
      if (record.status !== 'ok') {
        scratch.push({
          role: 'user',
          content: repoContext.formatFileForModel(spec.path, record, { ref: branch.branch_name }),
        });
        continue;
      }
      // Caveat worth naming: `record.content` is already clipped at
      // MAX_FILE_CHARS by the GitHub read, so a range beyond that point in a
      // very large file reads as past the end of the file. extractRange says
      // so rather than returning the wrong lines, and the codegen side - where
      // the container serves the real file - has no such ceiling.
      const range = repoContext.extractRange(record.content, spec.start, spec.end);
      scratch.push({ role: 'user', content: repoContext.formatRangeForModel(spec.path, range) });
      continue;
    }

    // Outlines are whatever an earlier codegen run left behind for this exact
    // commit (see structuralIndex.js on the asymmetry): clarification has no
    // container, so it cannot build one. A repo with no successful run yet
    // simply gets told there is no outline, which costs a turn and nothing else.
    const outlineMatch = reply.match(/^FETCH_OUTLINE:\s*(.+)$/);
    if (outlineMatch) {
      const path = outlineMatch[1].trim();
      scratch.push({ role: 'assistant', content: reply });
      scratch.push({
        role: 'user',
        content:
          structuralIndex.renderOutline(index, path) ||
          `No outline is available for ${path}. Read it directly instead, e.g. \`FETCH_RANGE: ${path}:1-200\`.`,
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
  // Sequenced after the tree, not alongside it: the index is keyed on the
  // commit sha the tree just resolved. No sha (a degraded, empty map) means no
  // index, which is the correct answer rather than a missing one.
  const index = tree.sha ? await structuralIndex.loadIndex(repo.id, tree.sha) : structuralIndex.emptyIndex();
  const messages = toModelMessages(tree, index, conversation, instructions);

  const result = await runModelLoop(messages, org, repo, branch, session, index);

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
