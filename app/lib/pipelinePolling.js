// Pacing constants and the branch-status view-model shared by the server-
// rendered branch page, the JSON status endpoint it polls, and worker.js
// itself (see ROADMAP.md Phase 31).
//
// POLL_INTERVAL_MS lives here rather than in worker.js because the browser's
// interval is meant to BE the worker's tick, not a second constant that
// happens to read 5000 today: polling faster than the worker asks the
// database for changes that cannot have happened yet. worker.js imports this
// one definition, and the page hands the same number to the client script.
//
// Pure computation apart from reading the environment once at require time -
// the same property that lets app/lib/pipelineStepper.js serve both the HTML
// render and the JSON endpoint.
const pipelineStepper = require('./pipelineStepper');

const POLL_INTERVAL_MS = Number(process.env.PIPELINE_POLL_INTERVAL_MS || 5000);

// A session the page should keep watching. Everything else is terminal from
// the poller's point of view - including 'awaiting_approval', which a session
// drops back into when a new requirement is finalized after approval (see
// clarificationService.js). That is not "finished", but it is a page whose
// controls, forms and lock line all differ from the one on screen, so the
// poller's single full reload is exactly the right response to it.
const LIVE_SESSION_STATUSES = ['queued', 'running'];

// Stall thresholds. Neither is a timeout and nothing acts on them - they only
// decide when the page stops implying progress and says so.
//
// Queued is generous because worker.js processes sessions strictly one at a
// time (see worker.js): a queued session legitimately waits behind another
// repo's run, and the page has no way to tell that apart from a worker that
// is not running at all. Five minutes is well past a healthy pickup (one
// tick) and still short enough to catch a dead worker in the same sitting.
const QUEUED_STALL_MS = 5 * 60 * 1000;
// Running is measured against pipeline_runs.updated_at, which setStage()
// touches as each step begins, so it is "this step has not finished", not
// "this run is slow". Codegen is a multi-turn model loop and legitimately the
// long one, which is what twenty minutes is sized for.
const RUNNING_STALL_MS = 20 * 60 * 1000;

function toMillis(value) {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

// "4s" / "2m 14s" / "1h 06m". Formatted here rather than in the client script
// so the first paint and every poll after it phrase the same elapsed figure
// the same way.
function formatElapsed(ms) {
  if (ms === null || ms < 0) return null;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

// Which timestamp the elapsed figure counts from, per status:
// - queued: sessions.approved_at, i.e. how long the worker has had this to
//   pick up. Falls back to updated_at for a session queued by a path that
//   left approved_at alone.
// - running: the attempt's own pipeline_runs.created_at, not the approval -
//   a retry's elapsed time is about that attempt.
function elapsedSince(session, latestRun) {
  if (session.status === 'queued') return toMillis(session.approved_at) || toMillis(session.updated_at);
  if (session.status === 'running') return (latestRun && toMillis(latestRun.created_at)) || toMillis(session.updated_at);
  return null;
}

// The stall test is deliberately against a DIFFERENT timestamp than the
// elapsed figure for a running session: elapsed counts the whole attempt,
// stalled asks whether the current *step* has moved. A thirty-minute run that
// changed stage a minute ago is healthy and must not be called out.
function stallCheck(session, latestRun, now) {
  if (session.status === 'queued') {
    const since = elapsedSince(session, latestRun);
    if (since === null || now - since < QUEUED_STALL_MS) return null;
    return (
      `This session has been queued for more than ${Math.round(QUEUED_STALL_MS / 60000)} minutes without starting. ` +
      'That is normal if another run is ahead of it, but it is also what a stopped pipeline worker looks like — ' +
      'ask an administrator to check that the worker process is running.'
    );
  }

  if (session.status === 'running') {
    const lastMoved = latestRun ? toMillis(latestRun.updated_at) || toMillis(latestRun.created_at) : null;
    if (lastMoved === null || now - lastMoved < RUNNING_STALL_MS) return null;
    const where = latestRun && latestRun.stage ? `the ${latestRun.stage} step` : 'its first step';
    return (
      `This run has not advanced past ${where} in over ${Math.round(RUNNING_STALL_MS / 60000)} minutes. ` +
      'Codegen on a large change can take a while, but if it stays here, ask an administrator to check the ' +
      'pipeline worker and the sandbox container.'
    );
  }

  return null;
}

// buildBranchStatus({ session, latestRun, eligibleForApproval }) -> the whole
// view-model the page renders and the status endpoint returns, from the same
// code path in both cases. `live` is what gates the poller client-side;
// `terminal` is its negation, named separately because that is the flag the
// script actually branches on and reading `!live` at every call site invites
// getting it backwards once.
function buildBranchStatus({ session, latestRun, eligibleForApproval }, now = Date.now()) {
  const live = LIVE_SESSION_STATUSES.includes(session.status);
  const since = elapsedSince(session, latestRun);

  return {
    status: session.status,
    stage: (latestRun && latestRun.stage) || null,
    live,
    terminal: !live,
    topStepper: pipelineStepper.buildTopStepper(session, eligibleForApproval),
    subStepper: pipelineStepper.buildSubStepper(session, latestRun),
    commitSha: (latestRun && latestRun.commit_sha) || null,
    errorMessage: (latestRun && latestRun.error_message) || null,
    elapsedMs: since === null ? null : now - since,
    elapsedLabel: since === null ? null : formatElapsed(now - since),
    stallMessage: stallCheck(session, latestRun, now),
    pollIntervalMs: POLL_INTERVAL_MS,
    checkedAt: new Date(now).toISOString(),
  };
}

module.exports = {
  POLL_INTERVAL_MS,
  QUEUED_STALL_MS,
  RUNNING_STALL_MS,
  LIVE_SESSION_STATUSES,
  formatElapsed,
  buildBranchStatus,
};
