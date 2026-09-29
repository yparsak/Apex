const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const db = require('../lib/db');
const { getAccessibleRepo } = require('../lib/repoAccess');
const branchService = require('../lib/branchService');
const sessionService = require('../lib/sessionService');
const lockService = require('../lib/lockService');

const router = express.Router();
router.use(requireAuth);

async function loadAccess(req, res) {
  const access = await getAccessibleRepo(req.params.repoId, req.session.user.id);
  if (!access) {
    res.status(404).send('Repo not found.');
    return null;
  }
  if (access.forbidden) {
    res.status(403).send('Forbidden: no access to this repo group.');
    return null;
  }
  return access;
}

async function renderRepoPage(req, res, access, error) {
  const branches = await branchService.listActiveBranches(access.repo, access.org);
  res.render('repo', {
    user: req.session.user,
    repo: access.repo,
    org: access.org,
    repoGroup: access.repoGroup,
    branches,
    error,
  });
}

router.get('/:repoId', async (req, res) => {
  const access = await loadAccess(req, res);
  if (!access) return;
  await renderRepoPage(req, res, access, null);
});

router.post('/:repoId/branches', async (req, res) => {
  const access = await loadAccess(req, res);
  if (!access) return;

  const coNumber = (req.body.co_number || '').trim();
  let branch;
  try {
    branch = await branchService.createBranch({ repo: access.repo, org: access.org, coNumber, user: req.session.user });
  } catch (err) {
    return renderRepoPage(req, res, access, err.message);
  }

  const session = await sessionService.findOrCreateSession(branch.id, req.session.user.id);
  await lockService.acquireLock(access.repo.id, coNumber, session.id, req.session.user.id);

  res.redirect(`/repos/${access.repo.id}/branches/${branch.id}`);
});

router.post('/:repoId/branches/:branchId/continue', async (req, res) => {
  const access = await loadAccess(req, res);
  if (!access) return;

  const [[branch]] = await db.query("SELECT * FROM branches WHERE id = ? AND repo_id = ? AND status = 'active'", [
    req.params.branchId,
    access.repo.id,
  ]);
  if (!branch) return renderRepoPage(req, res, access, 'That branch is no longer active.');

  const session = await sessionService.findOrCreateSession(branch.id, req.session.user.id);
  await lockService.acquireLock(access.repo.id, branch.co_number, session.id, req.session.user.id);

  res.redirect(`/repos/${access.repo.id}/branches/${branch.id}`);
});

router.get('/:repoId/branches/:branchId', async (req, res) => {
  const access = await loadAccess(req, res);
  if (!access) return;

  const [[branch]] = await db.query('SELECT * FROM branches WHERE id = ? AND repo_id = ?', [
    req.params.branchId,
    access.repo.id,
  ]);
  if (!branch) return res.status(404).send('Branch not found.');

  const [[session]] = await db.query(
    'SELECT * FROM sessions WHERE branch_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1',
    [branch.id, req.session.user.id]
  );
  if (!session) return res.redirect(`/repos/${access.repo.id}`);

  const [[lock]] = await db.query('SELECT session_id FROM pipeline_locks WHERE repo_id = ? AND co_number = ?', [
    access.repo.id,
    branch.co_number,
  ]);
  const lockHeld = !!lock && lock.session_id === session.id;

  const branches = await branchService.listActiveBranches(access.repo, access.org);

  res.render('branch', {
    user: req.session.user,
    repo: access.repo,
    org: access.org,
    branch,
    session,
    lockHeld,
    branches,
  });
});

module.exports = router;
