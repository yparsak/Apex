const db = require('./db');

// Cap enforced at save time (see ROADMAP.md Phase 6) - this doc is re-sent in
// full on every clarification turn, so an unbounded doc would compete for
// context against the file tree, conversation history, and FETCH_FILE'd
// content.
const MAX_INSTRUCTIONS_LENGTH = 6000;

async function getInstructions(repoId) {
  const [rows] = await db.query('SELECT instructions FROM repo_clarification_instructions WHERE repo_id = ?', [repoId]);
  return rows[0] ? rows[0].instructions : null;
}

module.exports = { getInstructions, MAX_INSTRUCTIONS_LENGTH };
