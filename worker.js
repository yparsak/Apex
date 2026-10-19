require('dotenv').config();

const db = require('./app/lib/db');
const appLock = require('./app/lib/appLock');
const pipelineRunner = require('./app/lib/pipeline/pipelineRunner');
const { initProcessLogger } = require('./app/lib/logger');
const logRetention = require('./app/lib/logRetention');
// One definition of the tick, shared with the branch page's poller (see
// ROADMAP.md Phase 31) - the browser must not ask for changes faster than
// this loop can make them.
const { POLL_INTERVAL_MS } = require('./app/lib/pipelinePolling');

const logger = initProcessLogger('worker');

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

  // Joined through to repos for access_state (see ROADMAP.md Phase 27). This
  // process never goes near getAccessibleRepo, so without the join an engineer
  // approves a run, an admin flips the repo to read_only a minute later, and the
  // pipeline runs anyway - the claim is the only checkpoint there is.
  //
  // A queued session on a repo that leaves 'enabled' stays queued and is simply
  // skipped; it is NOT failed. Flipping the repo back resumes the work exactly
  // where it sat, which is what an admin freezing a repo for an afternoon
  // expects. The cost is that queued work can sit invisibly, which /admin/repos
  // answers by showing the count on the row.
  //
  // An already-running pipeline is not interrupted: this claim is the
  // checkpoint, so a container mid-run finishes, writes its delivery and
  // releases its lock. Killing it would mean a half-pushed DEV branch and a held
  // pipeline_locks row, which is strictly worse than one more run completing.
  const [[next]] = await db.query(
    `SELECT s.id, s.resume_requested
     FROM sessions s
     JOIN branches b ON b.id = s.branch_id
     JOIN repos r ON r.id = b.repo_id
     WHERE s.status = 'queued' AND r.access_state = 'enabled'
     ORDER BY s.id ASC LIMIT 1`
  );
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
