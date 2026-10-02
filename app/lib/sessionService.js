const db = require('./db');

async function createSession(branchId, userId) {
  const [result] = await db.query('INSERT INTO sessions (branch_id, user_id) VALUES (?, ?)', [branchId, userId]);
  return { id: result.insertId, branch_id: branchId, user_id: userId, status: 'awaiting_approval' };
}

// findOrCreateSession(branchId, userId) - reuses an open-or-failed session
// for this user+branch (so repeat "Continue" clicks don't spawn a duplicate
// row that shadows the one actually holding the pipeline lock - see
// lockService.js). 'failed' is included deliberately: it still holds its
// lock (lockService never releases on failure) and still has the fail
// state/retry UI (branch.ejs) worth surfacing, unlike 'completed', which is
// genuinely done and should always start a fresh session.
async function findOrCreateSession(branchId, userId) {
  const [[existing]] = await db.query(
    `SELECT * FROM sessions WHERE branch_id = ? AND user_id = ?
     AND status IN ('awaiting_approval', 'queued', 'running', 'failed')
     ORDER BY id DESC LIMIT 1`,
    [branchId, userId]
  );
  if (existing) return existing;

  return createSession(branchId, userId);
}

module.exports = { findOrCreateSession, createSession };
