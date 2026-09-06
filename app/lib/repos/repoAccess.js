// Permission-scoped repo queries - every lookup here is filtered through
// user_repo_group_permissions so a user only ever sees repos in a group
// they've been granted access to. There's no admin UI for that table yet
// (Phase 6); until then, permission rows are inserted directly (see
// Phase2_test.md).
//
// GitHub owner derivation: the `repos` table (db/schema.sql) stores only a
// bare `name` column, with no explicit GitHub owner/org field. `orgs.name`
// (reached via repos -> repo_groups -> orgs) is the closest existing column
// that maps onto a GitHub owner login, and github.notes.txt confirms the
// same GitHub App install works identically against either a GitHub org or
// a personal account - so "orgs.name is the GitHub owner login" holds
// either way. Documented here, at the query that produces it, the same way
// githubAppTokenProvider.js documents its own scoping assumptions inline.
const db = require('../db');

const REPO_SELECT = `
  SELECT r.id, r.name, r.default_branch_name AS defaultBranchName,
         rg.id AS repoGroupId, rg.name AS repoGroupName,
         o.id AS orgId, o.name AS githubOwner
  FROM repos r
  JOIN repo_groups rg ON rg.id = r.repo_group_id
  JOIN orgs o ON o.id = rg.org_id
`;

async function listReposForUser(userId) {
  return db.query(
    `${REPO_SELECT}
     JOIN user_repo_group_permissions p ON p.repo_group_id = rg.id
     WHERE p.user_id = ?
     ORDER BY r.name`,
    [userId]
  );
}

async function getRepoForUser({ repoId, userId }) {
  const rows = await db.query(
    `${REPO_SELECT}
     JOIN user_repo_group_permissions p ON p.repo_group_id = rg.id
     WHERE p.user_id = ? AND r.id = ?`,
    [userId, repoId]
  );
  return rows[0] || null;
}

module.exports = { listReposForUser, getRepoForUser };
