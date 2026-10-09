// Structured logging (see ROADMAP.md Phase 12), replacing the scattered
// console.log/console.error calls app.js/worker.js/docWorker.js/
// pipelineRunner.js used to make directly. One pino instance per process name
// (app/worker/doc-worker - "per-process log files", not one combined
// stream; docWorker.js is a one-shot invocation as of Phase 15, not a
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
// docWorker.js and docService.js, both 'doc-worker') must share one
// underlying pino instance, not create their own.
const cache = new Map();

// The per-process-name invariant above only holds within one process - the
// cache can't dedupe across processes, and the app/worker containers both
// bind-mount the same logs/ (see Makefile). Two *containers* opening one
// logs/<name>.log is therefore the same race, plus a uid mismatch: `make
// worker` runs as root while `make dev` runs as the host user, so whichever
// container wins the daily roll leaves a file the other can't open
// (EACCES, crashing it via the transport's unhandled 'error' event).
//
// So the log file name is a property of the *process*, not of the module
// doing the logging: entrypoints declare it once via initProcessLogger(), and
// shared library modules (pipelineRunner.js, docService.js - both loaded
// by app.js's route tree as well as by their own worker entrypoint) resolve
// it lazily through processLogger() instead of naming a file themselves.
let processName = null;

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

  // Without this, any failure to write the rolled file (a permission problem
  // on a rotated file, a full disk) reaches the process as an unhandled
  // 'error' event on pino's ThreadStream and takes the whole process down -
  // a web server dying because it couldn't append to a log file. Report it
  // on the original stderr (the logger itself is what's broken) and keep
  // running; stdout logging and `docker logs` are unaffected. Reported once
  // per transport, since a failed destination usually keeps failing.
  let reported = false;
  transport.on('error', (err) => {
    if (reported) return;
    reported = true;
    process.stderr.write(`[logger] file transport for "${name}" failed, continuing without it: ${err.message}\n`);
  });

  const logger = pino({ name, level: LEVEL }, transport);
  cache.set(name, logger);
  return logger;
}

// Called once by each entrypoint (app.js/worker.js/docWorker.js) to fix
// the name every log file this process writes is derived from.
function initProcessLogger(name) {
  processName = name;
  return createLogger(name);
}

// For shared modules: the current process's logger. Resolved at call time,
// not at require time - a library module is required while the entrypoint's
// own requires are still being evaluated, before initProcessLogger() runs.
// The fallback keeps the one-file-per-process invariant for any future
// script that forgets to initialize rather than silently joining (and
// racing) another process's file.
function processLogger() {
  if (!processName) {
    const entry = process.argv[1] ? path.basename(process.argv[1], path.extname(process.argv[1])) : 'unknown';
    processName = entry;
  }
  return createLogger(processName);
}

module.exports = { initProcessLogger, processLogger, LOGS_DIR };
