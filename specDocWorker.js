require('dotenv').config();

const specDocScanService = require('./app/lib/documents/specDocScanService');
const specDocService = require('./app/lib/documents/specDocService');

const INTERVAL_MS = Number(process.env.SPEC_DOC_SCAN_INTERVAL_MS || 5 * 60 * 1000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Standing in for a real cron/systemd timer (see notes.md / ROADMAP.md Phase 8
// - the exact interval/mechanism is deployment-target-dependent and still
// open) with a simple interval loop: scan for trunk staleness, then drain
// whatever landed in spec_doc_jobs, on a fixed cadence - independent of
// worker.js's own AI-pipeline poll loop.
async function tick() {
  await specDocScanService.scanForStaleRepos();
  await specDocService.drainQueuedJobs();
}

async function main() {
  console.log('[spec-doc-worker] started');
  for (;;) {
    try {
      await tick();
    } catch (err) {
      console.error('[spec-doc-worker] tick error', err);
    }
    await sleep(INTERVAL_MS);
  }
}

main();
