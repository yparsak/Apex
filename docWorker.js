require('dotenv').config();

const appLock = require('./app/lib/appLock');
const docDefinitions = require('./app/lib/documents/docDefinitions');
const docScanService = require('./app/lib/documents/docScanService');
const docService = require('./app/lib/documents/docService');
const { initProcessLogger } = require('./app/lib/logger');
const logRetention = require('./app/lib/logRetention');
const repoMap = require('./app/lib/repoMap');

const logger = initProcessLogger('doc-worker');

// One-shot script (see ROADMAP.md Phase 15), run on a nightly cadence by
// whatever cron-like facility the deployment target provides (host crontab,
// systemd timer, container-native CronJob, etc.) rather than looping
// in-process: scan for trunk staleness, drain whatever landed in
// doc_jobs, retire unread repo file maps, purge rotated logs past retention,
// then exit - independent of worker.js's own AI-pipeline poll loop.
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
    logger.warn({ reason: lock.reason }, 'app is locked - skipping document scan and drain');
  } else if (!(await docDefinitions.listActive()).length) {
    // Since Phase 24 there are no built-in document types, so "nothing to
    // generate" is the state of every fresh install rather than a
    // misconfiguration. info and exit 0, deliberately not a warning and not a
    // non-zero status: a cron wrapper that pages someone the first morning
    // after an install, for a system behaving exactly as designed, teaches
    // people to ignore it.
    //
    // The drain still runs. With no active definition every queued job is
    // skippable, and running it is one query that marks those jobs terminal
    // instead of leaving them queued for a reactivation that would generate
    // against a months-old sha (see docService.drainQueuedJobs).
    logger.info('No Active Document to generate');
    await docService.drainQueuedJobs();
  } else {
    await docScanService.scanForStaleRepos();
    await docService.drainQueuedJobs();
  }

  // Phase 20's file maps ride this nightly invocation rather than inventing a
  // second schedule: rebuild is already handled by the (repo_id, commit_sha)
  // key - a moved trunk simply misses the cache - so the only thing left to do
  // on a timer is retire maps for shas nobody reads any more.
  //
  // Deliberately out here next to logRetention rather than inside the scan
  // where it used to live (see ROADMAP.md Phase 23): now that every document
  // type can be turned off, a prune riding the scan would silently stop the
  // moment an admin unchecks the last box, leaving an unrelated cache growing
  // forever as a side effect of a documentation setting. Also outside the lock
  // branch, for the same reason log retention is: it touches no model and no
  // repo. Failure is logged, not fatal - a map table that grows a little is
  // harmless, and the top-level catch would skip retention below.
  try {
    const removed = await repoMap.pruneUnused();
    if (removed) logger.info({ removed }, 'pruned unused repo file maps');
  } catch (err) {
    logger.error({ err }, 'repo file map prune failed');
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
