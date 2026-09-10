// Phase 4 worker entrypoint. Polls `sessions` for status='queued' rows and
// runs the sandboxed-execution pipeline against one at a time, independent
// of any live browser session (see roadmap.md's "Runs as an async
// background job" bullet). Mirrors server.js's entrypoint style (load env,
// then start) but exposes no HTTP surface of its own.
//
// Claiming a session is a single conditional UPDATE
// (`status='running' WHERE id=? AND status='queued'`), not a SELECT then a
// separate UPDATE - this is what prevents double pickup without needing
// DB-specific `SKIP LOCKED` syntax: only one such UPDATE can ever affect the
// row, so a second worker (or a second poll racing itself) simply affects
// zero rows and moves on. See agent-prompts.md's Phase 4 section for the
// full design.

require('dotenv').config();

const logger = require('./app/lib/logger');
const db = require('./app/lib/db');
const { runPipelineForSession } = require('./app/lib/pipeline/pipelineService');

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS) || 5000;

async function claimNextQueuedSession() {
  const queued = await db.query(`SELECT id FROM sessions WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`);
  if (queued.length === 0) return null;

  const sessionId = queued[0].id;
  const result = await db.query(`UPDATE sessions SET status = 'running' WHERE id = ? AND status = 'queued'`, [sessionId]);
  if (result.affectedRows !== 1) return null; // lost the race - another worker/poll already claimed it

  return sessionId;
}

async function pollOnce() {
  const sessionId = await claimNextQueuedSession();
  if (sessionId === null) return;

  logger.info('worker claimed queued session', { sessionId });
  await runPipelineForSession(sessionId);
}

async function loop() {
  try {
    await pollOnce();
  } catch (err) {
    logger.error('worker poll iteration failed', { error: err.message });
  } finally {
    setTimeout(loop, POLL_INTERVAL_MS);
  }
}

logger.info('Apex worker starting', { pollIntervalMs: POLL_INTERVAL_MS });
loop();
