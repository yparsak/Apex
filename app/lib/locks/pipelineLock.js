// Pipeline lock - serializes the full agent pipeline (clone -> sandbox
// build/test -> push) one session at a time per (repo_id, co_number), per
// roadmap.md's "Lock scope: entire pipeline" decision (a push-only lock
// would let two sandboxes build against stale state and race on push).
// Backed by the pipeline_locks table (db/schema.sql): a row's existence IS
// the lock. Acquiring is an INSERT that relies on the table's
// UNIQUE (repo_id, co_number) constraint to fail if another session already
// holds it; releasing is a DELETE.
//
// Phase 2 only wires acquire (at CO resolution, see
// app/lib/branches/coResolutionService.js) and release-on-failure. There is
// no sandbox/execution phase yet (Phases 3-5), so there is nothing
// downstream to release the lock for on success - releasing once the full
// pipeline actually completes is Phase 5's job, not this module's.

const db = require('../db');

class LockHeldError extends Error {
  constructor(repoId, coNumber) {
    super(`Pipeline lock already held for repo ${repoId}, CO ${coNumber}`);
    this.name = 'LockHeldError';
    this.code = 'LOCK_HELD';
  }
}

async function acquireLock({ repoId, coNumber, userId }) {
  try {
    await db.query('INSERT INTO pipeline_locks (repo_id, co_number, locked_by_user_id) VALUES (?, ?, ?)', [
      repoId,
      coNumber,
      userId,
    ]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      throw new LockHeldError(repoId, coNumber);
    }
    throw err;
  }
}

async function releaseLock({ repoId, coNumber }) {
  await db.query('DELETE FROM pipeline_locks WHERE repo_id = ? AND co_number = ?', [repoId, coNumber]);
}

// Lets a caller distinguish "someone else is mid-pipeline on this CO" from
// "I'm the one holding this lock, from an earlier resolve in this same
// in-flight run" - see coResolutionService.js's use of this. Without it, a
// user who already resolved once (e.g. created a branch) gets a LockHeldError
// on every subsequent /resolve for that CO - including re-selecting the exact
// branch they just created, since the branch list has no other way to reach
// the session-start screen until a sessions row exists (Phase 3).
async function isLockHeldByUser({ repoId, coNumber, userId }) {
  const rows = await db.query('SELECT 1 FROM pipeline_locks WHERE repo_id = ? AND co_number = ? AND locked_by_user_id = ?', [
    repoId,
    coNumber,
    userId,
  ]);
  return rows.length > 0;
}

module.exports = { acquireLock, releaseLock, isLockHeldByUser, LockHeldError };
