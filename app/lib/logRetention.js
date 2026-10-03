// Purge sweep for rotated app-level log files under logs/ (see ROADMAP.md
// Phase 12). Separate from, and unaffected by, Docker's own count-based
// `--log-opt max-file` rotation (Makefile) - this only prunes the files
// logger.js's pino-roll transport writes under logs/, by age.
//
// Decided (was open in ROADMAP.md): runs from a setInterval inside each of
// app.js/worker.js, the two long-running processes, rather than a standalone
// script, since both already run forever and a repeat sweep from each one is
// harmless (deleting an already-gone file is a no-op). specDocWorker.js is a
// one-shot script (see ROADMAP.md Phase 15), so it calls purgeOnce() directly
// instead of schedulePurge() - a setInterval would just be dead weight on a
// process that exits right after its single tick, and that tick is already
// as often as the purge needs to run.
const fs = require('fs');
const path = require('path');

const { LOGS_DIR } = require('./logger');

const DEFAULT_RETENTION_DAYS = 3;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function retentionDays() {
  const parsed = Number(process.env.LOG_RETENTION_DAYS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
}

function purgeOnce(logger) {
  let entries;
  try {
    entries = fs.readdirSync(LOGS_DIR, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }

  const maxAgeMs = retentionDays() * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(LOGS_DIR, entry.name);
    const { mtimeMs } = fs.statSync(filePath);
    if (mtimeMs < cutoff) {
      fs.unlinkSync(filePath);
      if (logger) logger.info({ file: entry.name }, 'purged rotated log file past retention window');
    }
  }
}

function schedulePurge(logger) {
  purgeOnce(logger);
  return setInterval(() => purgeOnce(logger), SWEEP_INTERVAL_MS);
}

module.exports = { purgeOnce, schedulePurge, retentionDays };
