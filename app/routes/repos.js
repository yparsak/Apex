// Repo/branch selection & resolution API (Phase 2). Depends only on the
// service modules under app/lib/repos/ and app/lib/branches/ - never on db
// access or GitHub calls directly - so this file stays a thin HTTP layer,
// same separation as app/routes/auth.js keeps from app/lib/auth/.

const express = require('express');
const requireAuth = require('../lib/auth/requireAuth');
const { sendSuccess, sendFailure } = require('../lib/respond');
const { isValidCoNumber } = require('../lib/validate');
const repoAccess = require('../lib/repos/repoAccess');
const { refreshActiveBranches } = require('../lib/branches/branchListService');
const { resolveChangeOrder } = require('../lib/branches/coResolutionService');
const sessionsRouter = require('./sessions');
const logger = require('../lib/logger');

const router = express.Router();

router.use(requireAuth);

function parseRepoId(req, res) {
  const repoId = Number(req.params.repoId);
  if (!Number.isInteger(repoId) || repoId <= 0) {
    sendFailure(res, 400, 'Invalid repo id');
    return null;
  }
  return repoId;
}

router.get('/', async (req, res) => {
  try {
    const repos = await repoAccess.listReposForUser(req.session.user.id);
    return sendSuccess(res, { repos });
  } catch (err) {
    logger.error('list repos failed', { error: err.message });
    return sendFailure(res, 500, 'Failed to list repos', { code: 'INTERNAL_ERROR' });
  }
});

router.get('/:repoId/branches', async (req, res) => {
  const repoId = parseRepoId(req, res);
  if (repoId === null) return undefined;

  const coNumber = req.query.co ? String(req.query.co).trim() : undefined;
  if (coNumber && !isValidCoNumber(coNumber)) {
    return sendFailure(res, 400, 'co must match ^C[0-9]{8}$');
  }

  try {
    const repo = await repoAccess.getRepoForUser({ repoId, userId: req.session.user.id });
    if (!repo) {
      return sendFailure(res, 404, 'Repo not found or access denied');
    }

    const branches = await refreshActiveBranches({ repo, userId: req.session.user.id, coNumber });
    return sendSuccess(res, { repo, branches });
  } catch (err) {
    logger.error('list branches failed', { repoId, error: err.message });
    return sendFailure(res, 502, 'Failed to refresh branch list from GitHub', { code: 'GITHUB_ERROR' });
  }
});

router.post('/:repoId/resolve', async (req, res) => {
  const repoId = parseRepoId(req, res);
  if (repoId === null) return undefined;

  const { coNumber, action, branchId } = req.body || {};
  if (!isValidCoNumber(coNumber)) {
    return sendFailure(res, 400, 'coNumber must match ^C[0-9]{8}$');
  }
  if (action !== 'continue' && action !== 'create') {
    return sendFailure(res, 400, 'action must be "continue" or "create"');
  }
  if (action === 'continue' && !Number.isInteger(Number(branchId))) {
    return sendFailure(res, 400, 'branchId is required for action "continue"');
  }

  try {
    const repo = await repoAccess.getRepoForUser({ repoId, userId: req.session.user.id });
    if (!repo) {
      return sendFailure(res, 404, 'Repo not found or access denied');
    }

    const result = await resolveChangeOrder({
      repo,
      user: req.session.user,
      coNumber,
      action,
      branchId: branchId !== undefined ? Number(branchId) : undefined,
    });
    return sendSuccess(res, result, 'Change order resolved');
  } catch (err) {
    if (err.code === 'LOCK_HELD') {
      return sendFailure(res, 409, err.message, { code: 'LOCK_HELD' });
    }
    if (err.code === 'BRANCH_NOT_FOUND') {
      return sendFailure(res, 404, err.message, { code: 'BRANCH_NOT_FOUND' });
    }
    logger.error('resolve CO failed', { repoId, error: err.message });
    return sendFailure(res, 500, 'Failed to resolve change order', { code: 'INTERNAL_ERROR' });
  }
});

// Phase 3's clarification-loop routes, nested under a resolved branch. Split
// into their own router file (see app/routes/sessions.js) since the surface
// is a few endpoints deep already; mounted here, after router.use(requireAuth)
// above, so it inherits the same auth guard without re-declaring it.
router.use('/:repoId/branches/:branchId/sessions', sessionsRouter);

module.exports = router;
