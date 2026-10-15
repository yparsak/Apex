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

// Everything that points at a repo, in the order an admin cares about it (see
// ROADMAP.md Phase 28). This list exists to answer "why can't I delete this",
// so it has to stay exhaustive: every FOREIGN KEY ... REFERENCES repos (id) in
// db/schema.sql is here, which is what makes "nothing references this repo"
// trustworthy enough to proceed on. `sessions` is the one entry that is not
// itself a blocker - it reaches the repo through `branches` - and it is counted
// anyway because pipeline runs are the history an admin is actually weighing,
// and a repo with sessions always has the branches they hang off, so it can
// never be the only thing standing in the way.
const REPO_REFERENCES = [
  { singular: 'change order', plural: 'change orders', table: 'change_orders' },
  { singular: 'branch', plural: 'branches', table: 'branches' },
  {
    singular: 'pipeline run',
    plural: 'pipeline runs',
    sql: 'SELECT COUNT(*) FROM sessions s JOIN branches b ON b.id = s.branch_id WHERE b.repo_id = ?',
  },
  { singular: 'generated document', plural: 'generated documents', table: 'repo_documents' },
  { singular: 'document job', plural: 'document jobs', table: 'doc_jobs' },
  { singular: 'document sync record', plural: 'document sync records', table: 'repo_doc_sync' },
  { singular: 'pipeline lock', plural: 'pipeline locks', table: 'pipeline_locks' },
  {
    singular: 'clarification instruction',
    plural: 'clarification instructions',
    table: 'repo_clarification_instructions',
  },
  { singular: 'blocked-allowlist alert', plural: 'blocked-allowlist alerts', table: 'blocked_allowlist_alerts' },
  { singular: 'lock contention event', plural: 'lock contention events', table: 'lock_contention_events' },
  { singular: 'usage event', plural: 'usage events', table: 'usage_events' },
  { singular: 'file map', plural: 'file maps', table: 'repo_file_maps' },
];

// "12 change orders, 34 sessions" from the plan, built as one round trip of
// scalar subqueries rather than a query per table - twelve sequential COUNTs on
// the click that refuses an action is a lot of work to say no.
async function describeRepoReferences(repoId) {
  const selects = REPO_REFERENCES.map(
    (ref, i) => `(${ref.sql || `SELECT COUNT(*) FROM ${ref.table} WHERE repo_id = ?`}) AS c${i}`
  );
  const [[counts]] = await db.query(
    `SELECT ${selects.join(', ')}`,
    REPO_REFERENCES.map(() => repoId)
  );
  return REPO_REFERENCES.map((ref, i) => ({ ref, count: Number(counts[`c${i}`]) }))
    .filter((row) => row.count > 0)
    .map(({ ref, count }) => `${count} ${count === 1 ? ref.singular : ref.plural}`);
}

function formatList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

async function renderRepos(req, res, error) {
  // Frozen repos sort last (and recede visually in the view) so they stop
  // competing for attention with live ones. `access_state = 'disabled'`
  // evaluates to 0/1, so this is one leading sort key and the existing
  // org/group/name order is untouched within each half - a disabled repo is
  // still exactly where alphabetical order puts it, just below the fold.
  const [repos] = await db.query(
    `SELECT r.id, r.name, r.description, r.default_branch_name, r.repo_group_id,
            r.on_demand_docs_enabled, r.access_state, r.access_state_note,
            rg.name AS repo_group_name, o.name AS org_name
     FROM repos r
     JOIN repo_groups rg ON rg.id = r.repo_group_id
     JOIN orgs o ON o.id = rg.org_id
     ORDER BY r.access_state = 'disabled', o.name, rg.name, r.name`
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

// Delete is the removal verb and `disabled` is explicitly not one (see
// ROADMAP.md Phase 28). The foreign keys mean this only ever succeeds on a repo
// nothing references - a repo added by mistake and never used - and that limit
// is deliberate: cascading a delete through change_orders, sessions,
// repo_documents, usage_events and the rest would destroy the regulatory record
// those tables exist to keep. So the job here is not to make delete work more
// often, it is to make the refusal say what is in the way and name the
// reversible option the admin probably meant.
router.post('/:id/delete', async (req, res) => {
  const repoId = Number(req.params.id);
  const [[repo]] = await db.query('SELECT name, access_state FROM repos WHERE id = ?', [repoId]);
  if (!repo) return renderRepos(req, res, 'That repo no longer exists.');

  // Counted up front rather than read back off the FK error, because the error
  // code says only "something referenced it" - it names neither the table nor
  // how much. The admin's actual question is how much history is at stake, and
  // that only has an answer before the DELETE is attempted.
  const references = await describeRepoReferences(repoId);
  if (references.length) {
    // The recommendation changes when the repo is already frozen: telling an
    // admin to set a state it is already in reads as the page not having looked.
    const freeze =
      repo.access_state === 'disabled'
        ? 'Its State is already Disabled, which is the retirement this page offers: everything above stays readable and nothing is generated or spent.'
        : 'To retire it instead, set its State to Disabled — everything above stays readable and nothing is generated or spent.';
    return renderRepos(
      req,
      res,
      `Cannot delete ${repo.name}: it has ${formatList(references)}, and deleting the repo would destroy ` +
        `all of it. ${freeze} Delete only succeeds on a repo nothing references, such as one added by ` +
        `mistake and never used.`
    );
  }

  try {
    await db.query('DELETE FROM repos WHERE id = ?', [repoId]);
    await logAdminAction({
      adminUserId: req.session.user.id,
      action: 'repo.delete',
      detail: { repoId, name: repo.name },
    });
    res.redirect('/admin/repos');
  } catch (err) {
    // Unreachable via the count above unless a reference landed in the gap
    // between the two queries, or a table started referencing repos without
    // being added to REPO_REFERENCES. Kept as the backstop that makes the list
    // above safe to be wrong about: the FK, not the count, is what actually
    // protects the history.
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return renderRepos(
        req,
        res,
        `Cannot delete ${repo.name}: something still references it. Freeze it instead by setting its State to Disabled.`
      );
    }
    throw err;
  }
});

module.exports = router;
