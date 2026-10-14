const db = require('./db');

// What each access_state permits (see ROADMAP.md Phase 27). A strict ladder:
// each step down removes exactly one capability, and reading is never one of
// them - every state returns the repo for need 'read', so no engineer loses
// sight of a repo they could see yesterday.
//
// 'docs' exists as a third need rather than being folded into 'write' because
// an on-demand document run changes rows but is explicitly permitted under
// read_only - a repo Apex should keep describing but stop changing.
const PERMITS = {
  enabled: { read: true, docs: true, write: true },
  read_only: { read: true, docs: true, write: false },
  disabled: { read: true, docs: false, write: false },
};

// getAccessibleRepo(repoId, userId, need) -> null (repo doesn't exist) |
// { forbidden: true } (exists, user lacks user_repo_group_permissions) |
// { denied: <access_state>, note } (has permission, repo's state refuses this
//   need - the caller answers 403) |
// { repo, org, repoGroup }.
//
// `need` is REQUIRED and a missing or unrecognized value throws. No default is
// safe: defaulting to 'write' breaks every GET the day someone forgets it, and
// defaulting to 'read' silently lets a write through, which is the failure this
// gate exists to prevent. Every call site funnels through loadAccess in
// app/routes/repos.js, so stating intent at each is cheap and reviewable.
//
// Admins get no bypass. The state describes the repo, not the viewer; an admin
// who can still create branches on a disabled repo turns every report of the
// feature not working into "works for me". Admin management of the state lives
// on /admin/repos.
async function getAccessibleRepo(repoId, userId, need) {
  if (!Object.prototype.hasOwnProperty.call(PERMITS.enabled, need)) {
    throw new Error(`getAccessibleRepo: need must be one of read, docs, write (got ${JSON.stringify(need)}).`);
  }

  const [[repo]] = await db.query(
    `SELECT r.id, r.name, r.description, r.default_branch_name, r.repo_group_id,
            r.on_demand_docs_enabled, r.access_state, r.access_state_note,
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

  // Falls back to the most restrictive rung for a value this code doesn't know,
  // which the ENUM makes unreachable today and a fourth ENUM value would not:
  // a new state should arrive refusing things until it is taught here, not
  // permitting everything because the lookup missed.
  const permits = PERMITS[repo.access_state] || PERMITS.disabled;
  if (!permits[need]) {
    return { denied: repo.access_state, note: repo.access_state_note };
  }

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
      // Carried through on every success, not just the non-enabled ones: the
      // views render the state banner and hide write controls from these two
      // fields, and a 'read' call on a read_only repo is the main case where
      // they have to be present (see ROADMAP.md Phase 27).
      access_state: repo.access_state,
      access_state_note: repo.access_state_note,
    },
    org: { id: repo.org_id, name: repo.org_name },
    repoGroup: { id: repo.repo_group_id, name: repo.repo_group_name },
  };
}

// The sentence a denied request gets, with the note quoted when there is one.
// Lives here rather than in the route because it is the prose half of the table
// above and should be read next to it; the engineer-facing banner in
// views/partials/repo-state-banner.ejs says the same thing in page prose, and
// deliberately does not share this string - one is a bare 403 body reached by a
// stale tab, the other is a paragraph on a rendered page.
function accessStateMessage(state, note) {
  const reason =
    state === 'read_only'
      ? 'This repo is read-only: it can be read and its documents keep updating, but no new branch or pipeline work can be started.'
      : 'This repo is disabled: it can be read, and every document it already has stays readable, but nothing new is generated or started.';
  return note ? `${reason}\n\n${note}` : reason;
}

module.exports = { getAccessibleRepo, accessStateMessage };
