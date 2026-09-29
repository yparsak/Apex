const db = require('./db');

// findOrCreateSession(branchId, userId) - reuses a non-terminal session for
// this user+branch (so repeat "Continue" clicks don't spawn duplicate rows);
// only creates a new one if the prior session already completed/failed.
async function findOrCreateSession(branchId, userId) {
  const [[existing]] = await db.query(
    `SELECT * FROM sessions WHERE branch_id = ? AND user_id = ?
     AND status IN ('awaiting_approval', 'queued', 'running')
     ORDER BY id DESC LIMIT 1`,
    [branchId, userId]
  );
  if (existing) return existing;

  const [result] = await db.query('INSERT INTO sessions (branch_id, user_id) VALUES (?, ?)', [branchId, userId]);
  return { id: result.insertId, branch_id: branchId, user_id: userId, status: 'awaiting_approval' };
}

module.exports = { findOrCreateSession };
