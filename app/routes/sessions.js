// Phase 3 clarification-loop API, nested under a repo + branch:
// /api/repos/:repoId/branches/:branchId/sessions. Mounted with
// { mergeParams: true } so :repoId/:branchId from the parent router
// (app/routes/repos.js) are visible here, and mounted after that router's
// requireAuth middleware so it doesn't need to re-apply auth itself. Stays a
// thin HTTP layer, delegating everything to app/lib/branches/sessionService.js
// - same separation repos.js keeps from app/lib/branches/ and app/lib/github/.

const express = require('express');
const { sendSuccess, sendFailure } = require('../lib/respond');
const { isNonEmptyString } = require('../lib/validate');
const repoAccess = require('../lib/repos/repoAccess');
const sessionService = require('../lib/branches/sessionService');
const logger = require('../lib/logger');

const router = express.Router({ mergeParams: true });

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function loadRepoAndBranch(req, res) {
  const repoId = parseId(req.params.repoId);
  const branchId = parseId(req.params.branchId);
  if (repoId === null || branchId === null) {
    sendFailure(res, 400, 'Invalid repo or branch id');
    return null;
  }

  try {
    const repo = await repoAccess.getRepoForUser({ repoId, userId: req.session.user.id });
    if (!repo) {
      sendFailure(res, 404, 'Repo not found or access denied');
      return null;
    }

    const branch = await sessionService.getActiveBranch({ repoId, branchId });
    if (!branch) {
      sendFailure(res, 404, 'Active branch not found on this repo');
      return null;
    }

    return { repo, branch };
  } catch (err) {
    logger.error('failed to load repo/branch context for session route', { repoId, branchId, error: err.message });
    sendFailure(res, 500, 'Failed to load repo/branch context', { code: 'INTERNAL_ERROR' });
    return null;
  }
}

// Every route past start/resume operates on one specific session. Only its
// owner may read or act on it - other users only ever see the lightweight
// otherSessions summary embedded in the owner's own session detail (see
// sessionService.listOtherSessionsForBranch), per roadmap.md's "visible ...
// for context" wording, which stops short of full read access to someone
// else's transcript.
async function loadOwnedSession(req, res, branchId) {
  const sessionId = parseId(req.params.sessionId);
  if (sessionId === null) {
    sendFailure(res, 400, 'Invalid session id');
    return null;
  }

  try {
    const session = await sessionService.getSessionForBranch({ sessionId, branchId });
    if (!session) {
      sendFailure(res, 404, 'Session not found on this branch');
      return null;
    }
    if (session.userId !== req.session.user.id) {
      sendFailure(res, 403, 'This session belongs to another user');
      return null;
    }
    return session;
  } catch (err) {
    logger.error('failed to load session', { sessionId, branchId, error: err.message });
    sendFailure(res, 500, 'Failed to load session', { code: 'INTERNAL_ERROR' });
    return null;
  }
}

// Start or resume the current user's session on this branch. Idempotent in
// effect: reuses a non-terminal (queued/running) session if one exists,
// otherwise creates one - see sessionService.startOrResumeSession for the
// state machine. Deliberately does not touch pipeline_locks - that lock is
// Phase 2's CO-resolution gate (see app/lib/locks/pipelineLock.js) and stays
// held across the resolving user's whole pipeline; calling this repeatedly
// to reopen the clarification loop must never re-trigger it.
router.post('/', async (req, res) => {
  const ctx = await loadRepoAndBranch(req, res);
  if (!ctx) return undefined;

  try {
    const session = await sessionService.startOrResumeSession({ repo: ctx.repo, branch: ctx.branch, user: req.session.user });
    const detail = await sessionService.getSessionDetail({ session, repo: ctx.repo, branch: ctx.branch });
    return sendSuccess(res, detail, 'Session ready');
  } catch (err) {
    logger.error('start/resume session failed', { error: err.message });
    return sendFailure(res, 502, 'Failed to start or resume session', { code: 'SESSION_START_FAILED' });
  }
});

router.get('/:sessionId', async (req, res) => {
  const ctx = await loadRepoAndBranch(req, res);
  if (!ctx) return undefined;
  const session = await loadOwnedSession(req, res, ctx.branch.id);
  if (!session) return undefined;

  try {
    const detail = await sessionService.getSessionDetail({ session, repo: ctx.repo, branch: ctx.branch });
    return sendSuccess(res, detail);
  } catch (err) {
    logger.error('fetch session detail failed', { sessionId: session.id, error: err.message });
    return sendFailure(res, 500, 'Failed to load session', { code: 'INTERNAL_ERROR' });
  }
});

router.post('/:sessionId/messages', async (req, res) => {
  const ctx = await loadRepoAndBranch(req, res);
  if (!ctx) return undefined;
  const session = await loadOwnedSession(req, res, ctx.branch.id);
  if (!session) return undefined;

  const { message } = req.body || {};
  if (!isNonEmptyString(message, { maxLength: 8000 })) {
    return sendFailure(res, 400, 'message is required (non-empty, max 8000 characters)');
  }

  try {
    const result = await sessionService.postMessage({
      session,
      repo: ctx.repo,
      branch: ctx.branch,
      actingUserId: req.session.user.id,
      message: message.trim(),
    });
    return sendSuccess(res, result);
  } catch (err) {
    if (err.code === 'SESSION_TERMINAL') {
      return sendFailure(res, 409, err.message, { code: err.code });
    }
    logger.error('post session message failed', { sessionId: session.id, error: err.message });
    return sendFailure(res, 502, 'Failed to process message', { code: 'MODEL_ERROR' });
  }
});

router.post('/:sessionId/requirements/:requirementId/resolve', async (req, res) => {
  const ctx = await loadRepoAndBranch(req, res);
  if (!ctx) return undefined;
  const session = await loadOwnedSession(req, res, ctx.branch.id);
  if (!session) return undefined;

  const requirementId = parseId(req.params.requirementId);
  if (requirementId === null) {
    return sendFailure(res, 400, 'Invalid requirement id');
  }

  const { resolution } = req.body || {};
  if (resolution !== 'confirmed_proceed' && resolution !== 'confirmed_skip') {
    return sendFailure(res, 400, 'resolution must be "confirmed_proceed" or "confirmed_skip"');
  }

  try {
    const requirement = await sessionService.resolveRequirement({
      session,
      requirementId,
      resolution,
      actingUserId: req.session.user.id,
    });
    return sendSuccess(res, { requirement }, 'Requirement resolved');
  } catch (err) {
    if (err.code === 'NOT_FOUND') return sendFailure(res, 404, err.message, { code: err.code });
    if (err.code === 'INVALID_STATE') return sendFailure(res, 409, err.message, { code: err.code });
    if (err.code === 'FORBIDDEN') return sendFailure(res, 403, err.message, { code: err.code });
    logger.error('resolve requirement failed', { sessionId: session.id, requirementId, error: err.message });
    return sendFailure(res, 500, 'Failed to resolve requirement', { code: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
