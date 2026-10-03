// Structured logging (see ROADMAP.md Phase 12), replacing the scattered
// console.log/console.error calls app.js/worker.js/specDocWorker.js/
// pipelineRunner.js used to make directly. One pino instance per process name
// (app/worker/spec-doc-worker - "per-process log files", not one combined
// stream; specDocWorker.js is a one-shot invocation as of Phase 15, not a
// long-running process like the other two, but still gets its own named log
// file the same way), writing to two targets at once:
//   - stdout, unchanged, so `docker logs`/`podman logs` keep working.
//   - a size-and-date-rolled file under logs/<name>.log via pino-roll.
// logs/ sits at the repo root, which the app/worker containers already
// bind-mount in full (see Makefile) - no extra bind mount needed for these
// files to survive container recreation and be host-greppable.
const path = require('path');
const pino = require('pino');

const LOGS_DIR = path.join(__dirname, '..', '..', 'logs');
const LEVEL = process.env.LOG_LEVEL || 'info';

// Cached per name: two independent pino-roll transports (each tracking its
// own rolling-file-index state) writing to the same logs/<name>.log would
// race each other. Modules that log under the same process name (e.g.
// specDocWorker.js and specDocService.js, both 'spec-doc-worker') must share
// one underlying pino instance, not create their own.
const cache = new Map();

function createLogger(name) {
  if (cache.has(name)) return cache.get(name);

  const transport = pino.transport({
    targets: [
      { target: 'pino/file', level: LEVEL, options: { destination: 1 } },
      {
        target: 'pino-roll',
        level: LEVEL,
        options: {
          file: path.join(LOGS_DIR, name),
          extension: '.log',
          size: '10m',
          frequency: 'daily',
          mkdir: true,
        },
      },
    ],
  });

  const logger = pino({ name, level: LEVEL }, transport);
  cache.set(name, logger);
  return logger;
}

module.exports = { createLogger, LOGS_DIR };
