// LLM-driven Q&A against repo context (see notes.md / ROADMAP.md Phase 5).
// Context retrieval is targeted: the repo's file tree (paths only) is fetched
// up front, and the model requests specific file contents by path as needed
// via a FETCH_FILE directive, resolved inline before the model's next turn is
// shown to the user - so file-fetch round-trips never appear in the
// conversation transcript itself. When the model decides a requirement is
// fully clarified, it emits FINALIZE_REQUIREMENT, which triggers overlap
// detection and writes a session_requirements row.
const db = require('./db');
const githubApi = require('./github/githubApi');
const modelAdapter = require('./model/modelAdapter');
const overlapService = require('./overlapService');
const auditLog = require('./auditLog');
const repoClarificationInstructions = require('./repoClarificationInstructions');

const MAX_FILE_FETCHES = 5;
const MAX_TREE_PATHS = 500;
const MAX_FILE_CHARS = 8000;

const SYSTEM_PROMPT = [
  "You are Apex's clarification assistant. An engineer is about to implement a Change",
  'Order (CO) in the repo below, and your job is to ask clarifying questions - grounded in',
  'the actual repo contents, not generic ones - before implementation starts.',
  '',
  "You are given the repo's file tree (paths only). You do not have any file's contents",
  'unless you ask for them.',
  '',
  'Respond using exactly ONE of these three modes, and nothing else:',
  '',
  '1. Ask a clarifying question: just write the question in plain text.',
  '2. Request a file: write a single line, exactly `FETCH_FILE: <path>`, where <path> is one',
  '   path from the tree below, and nothing else on that turn.',
  '3. Finalize: once the engineer has answered enough that an implementer could act without',
  '   further clarification, write `FINALIZE_REQUIREMENT:` followed by a newline and a',
  '   concise, complete restatement of the requirement that folds in everything learned.',
  '',
  'Ask about acceptance criteria, edge cases, and where in the codebase the change belongs',
  'when those are unclear. Do not finalize prematurely.',
].join('\n');

async function fetchRepoTree(org, repo, branch) {
  try {
    const paths = await githubApi.getTree(org.name, repo.name, branch.branch_name);
    return paths.slice(0, MAX_TREE_PATHS);
  } catch (err) {
    return []; // degrade to no tree context rather than blocking the clarification loop
  }
}

async function getConversation(sessionId) {
  const [rows] = await db.query('SELECT * FROM conversations WHERE session_id = ? ORDER BY id ASC', [sessionId]);
  return rows;
}

function toModelMessages(tree, conversation, instructions) {
  const treeBlock = tree.length ? tree.join('\n') : '(tree unavailable)';
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
async function runModelLoop(messages, org, repo, branch) {
  const scratch = messages.slice();

  for (let attempt = 0; attempt < MAX_FILE_FETCHES; attempt++) {
    const reply = (await modelAdapter.generate(scratch)).trim();

    const fetchMatch = reply.match(/^FETCH_FILE:\s*(.+)$/);
    if (fetchMatch) {
      const path = fetchMatch[1].trim();
      let content;
      try {
        content = await githubApi.getFileContent(org.name, repo.name, path, branch.branch_name);
      } catch (err) {
        content = null;
      }
      scratch.push({ role: 'assistant', content: reply });
      scratch.push({
        role: 'user',
        content:
          content === null
            ? `${path} was not found in this repo at ${branch.branch_name}.`
            : `Contents of ${path}:\n\`\`\`\n${content.slice(0, MAX_FILE_CHARS)}\n\`\`\``,
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
  const overlap = await overlapService.checkOverlap({ org, repo, branch, newRequirementText: text });

  const [result] = await db.query(
    'INSERT INTO session_requirements (session_id, requirement_text, overlap_flag_requirement_id, confirm_status) VALUES (?, ?, ?, ?)',
    [session.id, text, overlap ? overlap.matchedRequirementId : null, overlap ? 'pending_confirm' : 'confirmed_proceed']
  );

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
    fetchRepoTree(org, repo, branch),
    getConversation(session.id),
    repoClarificationInstructions.getInstructions(repo.id),
  ]);
  const messages = toModelMessages(tree, conversation, instructions);

  const result = await runModelLoop(messages, org, repo, branch);

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
