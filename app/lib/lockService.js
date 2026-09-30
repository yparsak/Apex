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

module.exports = { acquireLock, releaseLock };
