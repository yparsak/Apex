require('dotenv').config();

const specDocScanService = require('./app/lib/documents/specDocScanService');
const specDocService = require('./app/lib/documents/specDocService');
const { initProcessLogger } = require('./app/lib/logger');
const logRetention = require('./app/lib/logRetention');

const logger = initProcessLogger('spec-doc-worker');

// One-shot script (see ROADMAP.md Phase 15), run on a nightly cadence by
// whatever cron-like facility the deployment target provides (host crontab,
// systemd timer, container-native CronJob, etc.) rather than looping
// in-process: scan for trunk staleness, drain whatever landed in
// spec_doc_jobs, purge rotated logs past retention, then exit - independent
// of worker.js's own AI-pipeline poll loop.
async function main() {
  logger.info('started');
  await specDocScanService.scanForStaleRepos();
  await specDocService.drainQueuedJobs();
  logRetention.purgeOnce(logger);
  logger.info('completed');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'tick error');
    process.exit(1);
  });
