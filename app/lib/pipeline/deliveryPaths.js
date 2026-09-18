// Fixed, documented file paths for Phase 5's DEV-branch delivery artifacts
// (see roadmap.md's "Phase 5 - DEV branch delivery" bullets and
// agent-prompts.md's "Phase 5" section for the full rationale). Kept in one
// tiny module with zero dependencies so requirementsLogService.js,
// specDocService.js, pipelineService.js's orchestration, and
// app/lib/branches/sessionService.js's read view (for the UI's GitHub links)
// all agree on exactly the same paths without importing each other.

// Single, fixed, repo-root path. Deliberately NOT CO-keyed, unlike the spec
// doc below - the requirements log is a per-branch record ("what was asked
// on this branch"), organized *internally* under a heading per CO number
// (see requirementsLogService.js), not a separate file per CO.
const REQUIREMENTS_LOG_PATH = 'APEX-REQUIREMENTS-LOG.md';

// CO-number-keyed, per roadmap.md ("committed as a file inside the DEV
// branch" at "a CO-number-keyed path"). One Spec/Communication Protocol
// document per change order per repo, so multiple branches/sessions working
// the same CO number converge on (and can accurately judge the staleness of)
// the same document rather than each branch drifting its own copy.
function getSpecDocPath(coNumber) {
  return `docs/apex-spec/${coNumber}.md`;
}

module.exports = { REQUIREMENTS_LOG_PATH, getSpecDocPath };
