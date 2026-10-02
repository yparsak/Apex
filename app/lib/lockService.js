// Pipeline lock: one AI session at a time per (repo_id, co_number), covering
// the full pipeline (clone -> sandbox build/test -> push), not just the push
// (see notes.md / ROADMAP.md Phase 4). Not released here - Phase 4 has no
// pipeline runs yet to complete or fail; release is a later-phase concern
// (worker completion).
const db = require('./db');

async function acquireLock(repoId, coNumber, sessionId, userId) {
  const [[existing]] = await db.query(
    'SELECT session_id FROM pipeline_locks WHERE repo_id = ? AND co_number = ?',
    [repoId, coNumber]
  );
  if (existing && existing.session_id === sessionId) {
    return { acquired: true, holdingSessionId: sessionId };
  }

  try {
    await db.query('INSERT INTO pipeline_locks (repo_id, co_number, session_id) VALUES (?, ?, ?)', [
      repoId,
      coNumber,
      sessionId,
    ]);
    return { acquired: true, holdingSessionId: sessionId };
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;

    const [[holder]] = await db.query(
      'SELECT session_id FROM pipeline_locks WHERE repo_id = ? AND co_number = ?',
      [repoId, coNumber]
    );
    await db.query(
      'INSERT INTO lock_contention_events (repo_id, co_number, requesting_user_id, holding_session_id) VALUES (?, ?, ?, ?)',
      [repoId, coNumber, userId, holder ? holder.session_id : null]
    );
    return { acquired: false, holdingSessionId: holder ? holder.session_id : null };
  }
}

// releaseLock(...) - only called on a session's successful pipeline
// completion (see ROADMAP.md Phase 7). A failed session keeps the lock held,
// same as its kept-alive container, until it succeeds or a later phase's
// retry/abandon logic releases it.
async function releaseLock(repoId, coNumber, sessionId) {
  await db.query('DELETE FROM pipeline_locks WHERE repo_id = ? AND co_number = ? AND session_id = ?', [
    repoId,
    coNumber,
    sessionId,
  ]);
}

// Lock-contention dashboard (see ROADMAP.md Phase 10): every AI session
// currently occupying a (repo, CO) slot, for real-time visibility into
// what's actually locked right now, not just after the fact.
async function listActiveLocks() {
  const [rows] = await db.query(
    `SELECT pl.*, r.name AS repo_name, rg.name AS repo_group_name, o.name AS org_name,
            s.status AS session_status, u.username AS holder_username
     FROM pipeline_locks pl
     JOIN repos r ON r.id = pl.repo_id
     JOIN repo_groups rg ON rg.id = r.repo_group_id
     JOIN orgs o ON o.id = rg.org_id
     JOIN sessions s ON s.id = pl.session_id
     JOIN users u ON u.id = s.user_id
     ORDER BY pl.created_at DESC`
  );
  return rows;
}

// listContentionEvents(...) - historical record of every genuine cross-user
// lock conflict (see lockService.acquireLock above), not the locks
// themselves - pairs with listActiveLocks to form the full Phase 10
// lock-contention dashboard.
async function listContentionEvents({ limit = 200 } = {}) {
  const [rows] = await db.query(
    `SELECT lce.*, r.name AS repo_name, rg.name AS repo_group_name, o.name AS org_name,
            ru.username AS requesting_username, hu.username AS holding_username
     FROM lock_contention_events lce
     JOIN repos r ON r.id = lce.repo_id
     JOIN repo_groups rg ON rg.id = r.repo_group_id
     JOIN orgs o ON o.id = rg.org_id
     JOIN users ru ON ru.id = lce.requesting_user_id
     LEFT JOIN sessions hs ON hs.id = lce.holding_session_id
     LEFT JOIN users hu ON hu.id = hs.user_id
     ORDER BY lce.id DESC
     LIMIT ?`,
    [limit]
  );
  return rows;
}

// forceReleaseLock(...) - admin override for a stuck lock (see ROADMAP.md
// Phase 11): unlike releaseLock, which only ever runs from a successful
// pipeline completion for that exact (repo_id, co_number, session_id), this
// deletes by the lock's own id regardless of session outcome, for the case
// where the session that holds it can no longer be retried/resumed by its
// original owner. Returns the deleted row (for audit-log detail) or null if
// it was already gone. Leaves the orphaned session's own status untouched -
// this only frees the (repo, CO) slot, per the roadmap's "simpler" option
// where that's still explicitly left undecided.
async function forceReleaseLock(lockId) {
  const [[lock]] = await db.query('SELECT * FROM pipeline_locks WHERE id = ?', [lockId]);
  if (!lock) return null;
  await db.query('DELETE FROM pipeline_locks WHERE id = ?', [lockId]);
  return lock;
}

// isLockedForBranch(...) - Phase 13's deactivate/delete guard: true only if
// the session currently holding this (repo, CO) pipeline lock belongs to
// this exact branch, not just any branch sharing the same co_number (a
// user's first branch on any CO is always its own increment, independent of
// other users - see branchService.js's getNextIncrement). Checking by
// co_number alone would over-block a different user's unrelated branch on
// the same CO.
async function isLockedForBranch(repoId, coNumber, branchId) {
  const [[row]] = await db.query(
    `SELECT pl.id FROM pipeline_locks pl
     JOIN sessions s ON s.id = pl.session_id
     WHERE pl.repo_id = ? AND pl.co_number = ? AND s.branch_id = ?`,
    [repoId, coNumber, branchId]
  );
  return !!row;
}

module.exports = {
  acquireLock,
  releaseLock,
  listActiveLocks,
  listContentionEvents,
  forceReleaseLock,
  isLockedForBranch,
};
