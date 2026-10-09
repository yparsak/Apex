require('dotenv').config();

const appLock = require('./app/lib/appLock');
const docScanService = require('./app/lib/documents/docScanService');
const docService = require('./app/lib/documents/docService');
const { initProcessLogger } = require('./app/lib/logger');
const logRetention = require('./app/lib/logRetention');

const logger = initProcessLogger('doc-worker');

// One-shot script (see ROADMAP.md Phase 15), run on a nightly cadence by
// whatever cron-like facility the deployment target provides (host crontab,
// systemd timer, container-native CronJob, etc.) rather than looping
// in-process: scan for trunk staleness, drain whatever landed in
// spec_doc_jobs, purge rotated logs past retention, then exit - independent
// of worker.js's own AI-pipeline poll loop.
async function main() {
  logger.info('started');

  // Same reasoning as worker.js's poll guard (see ROADMAP.md Phase 22): a
  // maintenance window freezes the whole system, not just its UI, and with no
  // enabled model there is nothing to generate docs against. Skipping both the
  // scan and the drain is lossless here - this is a nightly one-shot, and
  // whatever is stale tonight is still stale tomorrow night. Log retention
  // still runs: it touches no model and no repo, and skipping it would let
  // logs grow unbounded for the length of a maintenance window.
  // try/catch so a failed lock read can't skip logRetention below: an
  // uncaught throw here would reach the top-level .catch and process.exit(1)
  // before retention ran, which is exactly what the comment above says must
  // not happen. Fails open, like the web gate and worker.js.
  let lock = { locked: false };
  try {
    lock = await appLock.getLockState();
  } catch (err) {
    logger.error({ err }, 'lock-state read failed - proceeding with scan and drain');
  }

  if (lock.locked) {
    logger.warn({ reason: lock.reason }, 'app is locked - skipping spec-doc scan and drain');
  } else {
    await docScanService.scanForStaleRepos();
    await docService.drainQueuedJobs();
  }

  logRetention.purgeOnce(logger);
  logger.info('completed');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'tick error');
    process.exit(1);
  });
