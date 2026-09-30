require('dotenv').config();

const db = require('./app/lib/db');
const pipelineRunner = require('./app/lib/pipeline/pipelineRunner');

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
  const [[next]] = await db.query("SELECT id FROM sessions WHERE status = 'queued' ORDER BY id ASC LIMIT 1");
  if (!next) return false;

  console.log(`[worker] running pipeline for session ${next.id}`);
  await pipelineRunner.run(next.id);
  console.log(`[worker] finished session ${next.id}`);
  return true;
}

async function main() {
  console.log('[worker] Apex pipeline worker started');
  for (;;) {
    let processed;
    try {
      processed = await pollOnce();
    } catch (err) {
      console.error('[worker] poll error', err);
      processed = false;
    }
    if (!processed) await sleep(POLL_INTERVAL_MS);
  }
}

main();
