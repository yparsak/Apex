const express = require('express');
const db = require('../../lib/db');
const { logAdminAction } = require('../../lib/adminAudit');

const router = express.Router();

// The three values repos.access_state can hold, labelled by what they DO rather
// than by the enum value (see ROADMAP.md Phase 27). "Disabled" read on its own
// means *gone*, and under this design it emphatically does not - the repo is
// still there and still readable - so the admin making the choice should not
// have to remember a table to know that.
const ACCESS_STATES = [
  { value: 'enabled', label: 'Enabled' },
  { value: 'read_only', label: 'Read-only — documents still update' },
  { value: 'disabled', label: 'Disabled — view only, documents frozen' },
];

async function renderRepos(req, res, error) {
  const [repos] = await db.query(
    `SELECT r.id, r.name, r.description, r.default_branch_name, r.repo_group_id,
            r.on_demand_docs_enabled, r.access_state, r.access_state_note,
            rg.name AS repo_group_name, o.name AS org_name
     FROM repos r
     JOIN repo_groups rg ON rg.id = r.repo_group_id
     JOIN orgs o ON o.id = rg.org_id
     ORDER BY o.name, rg.name, r.name`
  );
  // Queued sessions per repo. A session queued on a repo that is not `enabled`
  // stays queued and is skipped by worker.js rather than failed, so the work can
  // sit invisibly - this is where it becomes visible, and what the confirm
  // dialog on a state change counts. One grouped query for the whole page rather
  // than one per row.
  const [queuedRows] = await db.query(
    `SELECT b.repo_id, COUNT(*) AS queued
     FROM sessions s JOIN branches b ON b.id = s.branch_id
     WHERE s.status = 'queued'
     GROUP BY b.repo_id`
  );
  const queuedByRepo = Object.fromEntries(queuedRows.map((r) => [r.repo_id, Number(r.queued)]));
  for (const repo of repos) repo.queued_sessions = queuedByRepo[repo.id] || 0;
  const [repoGroups] = await db.query(
    `SELECT rg.id, rg.name, o.name AS org_name
     FROM repo_groups rg JOIN orgs o ON o.id = rg.org_id
     ORDER BY o.name, rg.name`
  );
  res.render('admin/repos', { user: req.session.user, repos, repoGroups, accessStates: ACCESS_STATES, error });
}

router.get('/', async (req, res) => {
  await renderRepos(req, res, null);
});

router.post('/', async (req, res) => {
  const name = (req.body.name || '').trim();
  const repoGroupId = Number(req.body.repo_group_id);
  const description = (req.body.description || '').trim() || null;
  const defaultBranchName = (req.body.default_branch_name || '').trim() || 'main';
  if (!name || !repoGroupId) return renderRepos(req, res, 'Repo group and name are required.');

  try {
    const [result] = await db.query(
      'INSERT INTO repos (repo_group_id, name, description, default_branch_name) VALUES (?, ?, ?, ?)',
      [repoGroupId, name, description, defaultBranchName]
    );
    await logAdminAction({
      adminUserId: req.session.user.id,
      action: 'repo.create',
      detail: { repoId: result.insertId, repoGroupId, name },
    });
    res.redirect('/admin/repos');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return renderRepos(req, res, 'That repo group already has a repo with this name.');
    throw err;
  }
});

router.post('/:id/update', async (req, res) => {
  const name = (req.body.name || '').trim();
  const repoGroupId = Number(req.body.repo_group_id);
  const description = (req.body.description || '').trim() || null;
  const defaultBranchName = (req.body.default_branch_name || '').trim() || 'main';
  // Part of the row form, so an unchecked box is an absent field (see
  // ROADMAP.md Phase 25). Absent therefore has to mean off, which is only safe
  // because this is the full-row save - there is no partial update of a repo
  // that could clear the flag as a side effect.
  const onDemandDocsEnabled = req.body.on_demand_docs_enabled ? 1 : 0;
  if (!name || !repoGroupId) return renderRepos(req, res, 'Repo group and name are required.');

  try {
    await db.query(
      `UPDATE repos SET repo_group_id = ?, name = ?, description = ?, default_branch_name = ?,
         on_demand_docs_enabled = ? WHERE id = ?`,
      [repoGroupId, name, description, defaultBranchName, onDemandDocsEnabled, req.params.id]
    );
    await logAdminAction({
      adminUserId: req.session.user.id,
      action: 'repo.update',
      detail: { repoId: Number(req.params.id), repoGroupId, name, onDemandDocsEnabled },
    });
    res.redirect('/admin/repos');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return renderRepos(req, res, 'That repo group already has a repo with this name.');
    throw err;
  }
});

// Phase 27: the three-position state switch. Its own route rather than a field
// on /:id/update above, mirroring POST /admin/models/:id/enabled - read the
// value off req.body, guard, write, logAdminAction, redirect. The lifecycle
// state is the operation an admin comes to this page to perform, and folding it
// into the full-row save would mean renaming a repo and freezing it could only
// happen together.
router.post('/:id/access-state', async (req, res) => {
  const accessState = (req.body.access_state || '').trim();
  const note = (req.body.access_state_note || '').trim() || null;
  if (!ACCESS_STATES.some((s) => s.value === accessState)) {
    return renderRepos(req, res, 'Unknown access state.');
  }
  if (note && note.length > 500) {
    return renderRepos(req, res, 'The note is too long (500 characters maximum).');
  }

  const [[repo]] = await db.query('SELECT name, access_state FROM repos WHERE id = ?', [req.params.id]);
  if (!repo) return renderRepos(req, res, 'That repo no longer exists.');

  await db.query('UPDATE repos SET access_state = ?, access_state_note = ? WHERE id = ?', [
    accessState,
    note,
    req.params.id,
  ]);
  // One action name with from-and-to in a single row, rather than paired
  // repo.disable / repo.enable actions: there are six transitions between three
  // states and six verb names would be unreadable in the log, where the
  // model/document toggles only ever had two.
  await logAdminAction({
    adminUserId: req.session.user.id,
    action: 'repo.access_state',
    detail: { repoId: Number(req.params.id), name: repo.name, from: repo.access_state, to: accessState, note },
  });
  res.redirect('/admin/repos');
});

router.post('/:id/delete', async (req, res) => {
  try {
    await db.query('DELETE FROM repos WHERE id = ?', [req.params.id]);
    await logAdminAction({
      adminUserId: req.session.user.id,
      action: 'repo.delete',
      detail: { repoId: Number(req.params.id) },
    });
    res.redirect('/admin/repos');
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return renderRepos(req, res, 'Cannot delete: this repo still has change orders, branches, or documents.');
    }
    throw err;
  }
});

module.exports = router;
