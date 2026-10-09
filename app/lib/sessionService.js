const db = require('./db');
const modelCatalog = require('./model/modelCatalog');

// sessions.model is stamped here, at creation, and read everywhere downstream
// (see db/schema.sql Phase 22). Resolving the user's model is this module's job
// rather than each caller's so no route can create a session without one.
//
// Refusing outright when nothing resolves, rather than storing NULL, is what
// makes "every session has a model" an invariant instead of a convention. The
// app-wide lock (app/lib/appLock.js) normally prevents anyone reaching here with
// an empty catalog, but it is not sufficient on its own: it exempts admins
// entirely, it fails open on a DB read error, and its state is up to a few
// seconds stale. A NULL stamp written through any of those gaps is unrecoverable
// in a way that is very hard to diagnose - approve/retry/resume all accept the
// session and it fails deep inside the pipeline, after container boot and clone,
// on every attempt forever.
class NoModelAvailableError extends Error {
  constructor() {
    super('No model is available. An administrator must add and enable a model on /admin/models.');
    this.name = 'NoModelAvailableError';
    this.noModelAvailable = true;
  }
}

async function createSession(branchId, userId) {
  const model = await modelCatalog.resolveForUser(userId);
  if (!model) throw new NoModelAvailableError();

  const [result] = await db.query('INSERT INTO sessions (branch_id, user_id, model) VALUES (?, ?, ?)', [
    branchId,
    userId,
    model.model_id,
  ]);
  return {
    id: result.insertId,
    branch_id: branchId,
    user_id: userId,
    status: 'awaiting_approval',
    model: model.model_id,
  };
}

// findOrCreateSession(branchId, userId) - reuses an open-or-failed session
// for this user+branch (so repeat "Continue" clicks don't spawn a duplicate
// row that shadows the one actually holding the pipeline lock - see
// lockService.js). 'failed' is included deliberately: it still holds its
// lock (lockService never releases on failure) and still has the fail
// state/retry UI (branch.ejs) worth surfacing, unlike 'completed', which is
// genuinely done and should always start a fresh session.
//
// A reused session has its model re-stamped, as long as it hasn't started
// running yet. Without that, this function's reuse would silently defeat the
// model selector: a user who changes their model and clicks Continue on a
// branch they already had an open session for would keep getting the old
// model, with nothing in the UI to explain why. 'running' and 'queued' are
// excluded from the re-stamp because work is already in flight against the
// stamped model - swapping it underneath a worker mid-run is the exact
// cross-model stitching the stamp exists to prevent.
async function findOrCreateSession(branchId, userId) {
  const [[existing]] = await db.query(
    `SELECT * FROM sessions WHERE branch_id = ? AND user_id = ?
     AND status IN ('awaiting_approval', 'queued', 'running', 'failed')
     ORDER BY id DESC LIMIT 1`,
    [branchId, userId]
  );

  if (existing) {
    if (existing.status === 'awaiting_approval' || existing.status === 'failed') {
      const model = await modelCatalog.resolveForUser(userId);
      // `model &&` is load-bearing: when nothing resolves, LEAVE the existing
      // stamp alone rather than clearing it. Without that guard, a user clicking
      // Continue during a window where the catalog is empty would have a
      // perfectly good stamp overwritten with NULL, breaking a session that was
      // about to work once a model came back.
      if (model && model.model_id !== existing.model) {
        await db.query('UPDATE sessions SET model = ? WHERE id = ?', [model.model_id, existing.id]);
        existing.model = model.model_id;
      }
    }
    return existing;
  }

  return createSession(branchId, userId);
}

// restampSession(sessionId, userId) - re-resolves and re-stamps an existing
// session. Used by /retry, which re-runs a failed session from scratch: without
// this, a session that failed *because* of its stamp (a legacy NULL, or a model
// since renamed out of the catalog) would fail identically on every retry, with
// no way out but abandoning the session and its confirmed requirements.
// Returns the stamped model id, or null if nothing resolved (stamp untouched).
async function restampSession(sessionId, userId) {
  const model = await modelCatalog.resolveForUser(userId);
  if (!model) return null;
  await db.query('UPDATE sessions SET model = ? WHERE id = ?', [model.model_id, sessionId]);
  return model.model_id;
}

module.exports = { findOrCreateSession, createSession, restampSession, NoModelAvailableError };
