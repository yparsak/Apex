// Global, CO-scoped cross-repo document search (see ROADMAP.md Phase 8):
// "every delivery doc for this CO, across every repo I can access." Only the
// requirements log is organized by CO internally (see
// requirementsLogFormat.js) - the Spec/Communication Protocol doc is
// repo-level, not CO-scoped, so it's out of scope for this search (it's
// browsable on each repo's own Documents page instead).
const db = require('../db');
const { parseSections } = require('./requirementsLogFormat');

async function searchByCoNumber(coNumber, userId) {
  const [repos] = await db.query(
    `SELECT r.id, r.name, rg.name AS repo_group_name, o.name AS org_name
     FROM repos r
     JOIN repo_groups rg ON rg.id = r.repo_group_id
     JOIN orgs o ON o.id = rg.org_id
     JOIN user_repo_group_permissions p ON p.repo_group_id = rg.id
     WHERE p.user_id = ?
     ORDER BY o.name, rg.name, r.name`,
    [userId]
  );

  const results = [];
  for (const repo of repos) {
    const [[doc]] = await db.query(
      "SELECT content FROM repo_documents WHERE repo_id = ? AND doc_type = 'requirements_log' AND co_number = ''",
      [repo.id]
    );
    if (!doc) continue;

    const section = parseSections(doc.content).find((s) => s.co === coNumber);
    if (section) {
      results.push({ repo, body: section.body.trim() });
    }
  }
  return results;
}

module.exports = { searchByCoNumber };
