// Session/pipeline-run progress stepper view-model (see ROADMAP.md Phase 9).
// Pure computation, no I/O - kept separate from app/routes/repos.js so the
// step-derivation rules are easy to read/verify in one place.

const TOP_STEPS = ['Branch created', 'Clarifying', 'Awaiting approval', 'Queued', 'Running', 'Completed'];
const SUB_STEPS = [
  { key: 'cloning', label: 'Clone' },
  { key: 'codegen', label: 'Codegen' },
  { key: 'building', label: 'Build' },
  { key: 'testing', label: 'Test' },
  { key: 'pushing', label: 'Push' },
];

function toSteps(labels, currentIndex, failedAtCurrent) {
  return labels.map((label, index) => {
    if (failedAtCurrent && index === currentIndex) return { label, state: 'failed' };
    if (index < currentIndex) return { label, state: 'done' };
    if (index === currentIndex) return { label, state: 'current' };
    return { label, state: 'pending' };
  });
}

// buildTopStepper(session, eligibleForApproval) -> [{ label, state }].
// 'awaiting_approval' covers two sub-states of the same sessions.status value
// (see ROADMAP.md Phase 9): eligibleForApproval (no pending_confirm
// requirement, at least one confirmed) distinguishes "ready to approve" from
// still-clarifying.
function buildTopStepper(session, eligibleForApproval) {
  const index = {
    awaiting_approval: eligibleForApproval ? 2 : 1,
    queued: 3,
    running: 4,
    completed: 5,
    failed: 4, // stalled where 'running' would be - buildSubStepper shows exactly where
  }[session.status];

  return toSteps(TOP_STEPS, index === undefined ? 0 : index, session.status === 'failed');
}

// buildSubStepper(session, latestRun) -> [{ label, state }] | null. Null when
// there's nothing meaningful to show yet - e.g. a run that failed before
// setting its first stage (see pipelineRunner.js: a missing apex.pipeline.json
// fails before any container even exists).
function buildSubStepper(session, latestRun) {
  if (!latestRun || !latestRun.stage) return null;
  if (session.status !== 'running' && session.status !== 'failed') return null;

  const currentIndex = SUB_STEPS.findIndex((s) => s.key === latestRun.stage);
  if (currentIndex === -1) return null;

  return toSteps(SUB_STEPS.map((s) => s.label), currentIndex, session.status === 'failed');
}

module.exports = { buildTopStepper, buildSubStepper };
