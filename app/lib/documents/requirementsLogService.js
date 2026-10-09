// Requirements log: one cumulative repo_documents row per repo
// (doc_type='requirements_log', co_number='' sentinel - see ROADMAP.md
// Phase 8), organized internally by a heading per CO (see
// requirementsLogFormat.js). Updated synchronously, inline, whenever a
// session completes - no queue, no cron (contrast with the Spec/
// Communication Protocol doc - see docService.js).
const db = require('../db');
const { parseSections, renderSections } = require('./requirementsLogFormat');

function appendEntry(content, coNumber, entry) {
  const sections = parseSections(content);
  const existing = sections.find((s) => s.co === coNumber);
  if (existing) {
    existing.body = `${existing.body.trim()}\n\n${entry}`;
  } else {
    sections.push({ co: coNumber, body: entry });
  }
  return renderSections(sections);
}

// recordCompletedSession({ repo, branch, session, requirements }) -
// `requirements` is this session's confirmed_proceed session_requirements
// rows, same set codegen implemented.
async function recordCompletedSession({ repo, branch, session, requirements }) {
  const [[existing]] = await db.query(
    "SELECT content FROM repo_documents WHERE repo_id = ? AND doc_type = 'requirements_log' AND co_number = ''",
    [repo.id]
  );

  const entry = [
    `### ${branch.branch_name} — session #${session.id} (${new Date().toISOString().slice(0, 10)})`,
    ...requirements.map((r) => `- ${r.requirement_text}`),
  ].join('\n');

  const content = appendEntry(existing ? existing.content : '', branch.co_number, entry);

  await db.query(
    `INSERT INTO repo_documents (repo_id, doc_type, co_number, content) VALUES (?, 'requirements_log', '', ?)
     ON DUPLICATE KEY UPDATE content = VALUES(content)`,
    [repo.id, content]
  );
}

module.exports = { recordCompletedSession };
