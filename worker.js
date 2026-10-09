require('dotenv').config();

const db = require('./app/lib/db');
const appLock = require('./app/lib/appLock');
const pipelineRunner = require('./app/lib/pipeline/pipelineRunner');
const { initProcessLogger } = require('./app/lib/logger');
const logRetention = require('./app/lib/logRetention');

const logger = initProcessLogger('worker');
const POLL_INTERVAL_MS = Number(process.env.PIPELINE_POLL_INTERVAL_MS || 5000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Single-process, one-session-at-a-time poll loop (see notes.md / ROADMAP.md
// Phase 7) - decoupled from the browser session; completion surfaces next
// time the user views that repo's branch list, not through a separate
// notification channel. Processing sessions strictly sequentially, rather
// than concurrently across different (repo, CO) pairs, is a scale limitation
// accepted for now - nothing in this phase requires more.
async function pollOnce() {
  // Locking the web tier does nothing to this process - it's a separate
  // container polling the same table (see ROADMAP.md Phase 22). Both lock
  // sources have to reach it:
  //   - maintenance: a window exists to freeze the system, not just its UI.
  //   - no_model: a queued session has nothing to generate against, so
  //     claiming it would only burn it through to 'failed'. Leaving it queued
  //     means it simply runs once an admin adds a model.
  // A session already running is untouched - see main()'s loop; this only
  // stops new ones being claimed, so nothing is abandoned mid-pipeline with a
  // half-written branch and a held CO lock.
  // Fails OPEN on a read error, matching app/middleware/appLockGate.js rather
  // than contradicting it. Without the catch, an unreadable app_settings (app
  // deployed before db/schema.sql was re-applied, say) throws on every poll
  // while the web tier serves normally - so approved work would sit in 'queued'
  // indefinitely with no maintenance banner anywhere to explain why. A session
  // let through during a lock is the milder failure, and the no-model case it
  // might admit is still caught by the stamp check in pipelineRunner.run.
  let lock;
  try {
    lock = await appLock.getLockState();
  } catch (err) {
    logger.error({ err }, 'lock-state read failed - continuing to claim work');
    lock = { locked: false };
  }
  if (lock.locked) return false;

  const [[next]] = await db.query("SELECT id, resume_requested FROM sessions WHERE status = 'queued' ORDER BY id ASC LIMIT 1");
  if (!next) return false;

  // resume_requested (see ROADMAP.md Phase 9) distinguishes a resume-from-
  // failed-step click from a normal approval/full-retry - both just leave
  // the session 'queued', so this flag is the only signal worker.js has for
  // which of pipelineRunner's two entry points to call.
  if (next.resume_requested) {
    logger.info({ sessionId: next.id }, 'resuming pipeline for session');
    await pipelineRunner.resume(next.id);
  } else {
    logger.info({ sessionId: next.id }, 'running pipeline for session');
    await pipelineRunner.run(next.id);
  }
  logger.info({ sessionId: next.id }, 'finished session');
  return true;
}

async function main() {
  logger.info('Apex pipeline worker started');
  logRetention.schedulePurge(logger);
  for (;;) {
    let processed;
    try {
      processed = await pollOnce();
    } catch (err) {
      logger.error({ err }, 'poll error');
      processed = false;
    }
    if (!processed) await sleep(POLL_INTERVAL_MS);
  }
}

main();
