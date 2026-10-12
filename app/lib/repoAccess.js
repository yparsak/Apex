const db = require('./db');

// getAccessibleRepo(repoId, userId) -> null (repo doesn't exist) |
// { forbidden: true } (exists, user lacks user_repo_group_permissions) |
// { repo, org, repoGroup }.
async function getAccessibleRepo(repoId, userId) {
  const [[repo]] = await db.query(
    `SELECT r.id, r.name, r.description, r.default_branch_name, r.repo_group_id,
            r.on_demand_docs_enabled,
            rg.name AS repo_group_name, o.id AS org_id, o.name AS org_name
     FROM repos r
     JOIN repo_groups rg ON rg.id = r.repo_group_id
     JOIN orgs o ON o.id = rg.org_id
     WHERE r.id = ?`,
    [repoId]
  );
  if (!repo) return null;

  const [[perm]] = await db.query(
    'SELECT id FROM user_repo_group_permissions WHERE user_id = ? AND repo_group_id = ?',
    [userId, repo.repo_group_id]
  );
  if (!perm) return { forbidden: true };

  return {
    repo: {
      id: repo.id,
      name: repo.name,
      description: repo.description,
      default_branch_name: repo.default_branch_name,
      repo_group_id: repo.repo_group_id,
      // Boolean, not MySQL's 0/1, because the branch view decides whether to
      // render the on-demand panel at all from it (see ROADMAP.md Phase 25).
      // It is the UX half of that gate only - the run route re-reads the column
      // itself (docRunService.isEnabledForRepo), since this object is as old as
      // whatever page is holding it.
      on_demand_docs_enabled: !!repo.on_demand_docs_enabled,
    },
    org: { id: repo.org_id, name: repo.org_name },
    repoGroup: { id: repo.repo_group_id, name: repo.repo_group_name },
  };
}

module.exports = { getAccessibleRepo };
