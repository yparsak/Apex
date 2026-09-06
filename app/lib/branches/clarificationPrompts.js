// System-prompt / conversation-strategy content for Phase 3's clarification
// loop. See agent-prompts.md's "Phase 3" section for the documented
// contract this implements: the model adapter is free-text-only (no
// tool-calling - see app/lib/model/modelAdapter.js), so structured output
// (the finalized requirements list, overlap judgments) is obtained purely
// through prompting plus deterministic parsing of a fenced-code-block
// convention (see app/lib/branches/responseParsing.js). Kept as its own
// module, separate from sessionService.js's DB/orchestration logic, so
// prompt wording can be iterated on without touching control flow.

const REQUIREMENTS_READY_TAG = 'requirements-ready';
const OVERLAP_CHECK_TAG = 'overlap-check';

function formatDiffForPrompt(diff, defaultBranchName) {
  if (!diff || diff.files.length === 0) {
    return `No differences from ${defaultBranchName} yet.`;
  }

  const header =
    `${diff.totalFiles} file(s) changed` +
    (typeof diff.totalCommits === 'number' ? ` (${diff.totalCommits} commit(s) ahead)` : '') +
    (diff.truncatedFileCount || diff.truncatedPatch ? ' [diff truncated for length - see below]' : '');

  const fileBlocks = diff.files
    .map((f) => `--- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions}) ---\n${f.patch || '(no patch content)'}`)
    .join('\n\n');

  return `${header}\n\n${fileBlocks}`;
}

function formatAuditHistoryForPrompt(history) {
  if (!history || history.length === 0) {
    return 'No prior recorded discussion for this change order on this repo.';
  }

  return history
    .map((row) => {
      const asked = row.rawInstructions ? `User asked: ${row.rawInstructions}` : '(system-triggered entry, no user instruction)';
      const replied = row.qaHistory ? `Agent replied: ${row.qaHistory}` : '(no recorded reply)';
      const when = row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt);
      return `[${when}] ${asked}\n${replied}`;
    })
    .join('\n\n');
}

// Start/resume summary - plain prose only, no fenced block, since there is
// nothing to finalize yet. This is the first message shown in the
// transcript (see sessionService.generateStartSummary).
function buildStartSummaryMessages({ repo, branch, diff, history }) {
  const system =
    'You are Apex, an engineering assistant helping a user pick up work on a Git branch for a ' +
    'regulated change-control process. Reply with plain prose only - a short, factual summary. ' +
    'Do not ask questions in this reply and do not use any fenced code block.';

  const user =
    `Repo: ${repo.name} (owner ${repo.githubOwner})\n` +
    `Branch: ${branch.branchName} (change order ${branch.coNumber}), compared to default branch ${repo.defaultBranchName}.\n\n` +
    `Current diff vs ${repo.defaultBranchName}:\n${formatDiffForPrompt(diff, repo.defaultBranchName)}\n\n` +
    `Prior discussion recorded for change order ${branch.coNumber} on this repo, most recent first ` +
    `(covers every user's sessions, not just this one):\n${formatAuditHistoryForPrompt(history)}\n\n` +
    'Write a short summary (a few sentences) covering: (1) what the branch currently contains relative ' +
    'to the default branch, and (2) what has already been discussed/requested for this change order, so ' +
    'the user can pick up where things left off.';

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// Q&A system prompt - defines the two-reply-shape convention. See
// app/lib/branches/responseParsing.js for the deterministic, fail-safe
// parser this prompt's second reply shape must satisfy.
function buildQaSystemPrompt({ repo, branch }) {
  return [
    `You are Apex, an engineering assistant running a requirements-clarification loop with a user ` +
      `working on branch ${branch.branchName} (change order ${branch.coNumber}) of repo ${repo.name}.`,
    'You have no tools and cannot execute code or fetch anything further - you only see what is given ' +
      "to you in this conversation (the branch diff, prior discussion, and the user's messages). If you " +
      'need more information to scope the work well, ask for it rather than guessing.',
    'Reply in exactly one of these two forms:',
    '1. Plain prose: a clarifying question, or commentary. Use this whenever you need more information ' +
      'or want to check something with the user. This is the default - keep asking until you are ' +
      'confident you have a complete, unambiguous, and discrete set of requirements.',
    '2. A finalization reply, used only once you have enough information: reply with NOTHING but a ' +
      `single fenced code block labeled "${REQUIREMENTS_READY_TAG}" containing a JSON array of short, ` +
      'discrete, actionable requirement strings, one per requirement. Example:\n' +
      '```' +
      REQUIREMENTS_READY_TAG +
      '\n["Add server-side validation that rejects an empty email field", ' +
      '"Return HTTP 400 with a clear message on invalid input"]\n' +
      '```',
    'Do not include any prose alongside the fenced block when using form 2 - the block must be the ' +
      'entire reply, and it must parse as a JSON array of one or more non-empty strings. A malformed or ' +
      'ambiguous finalization reply is treated as an ordinary clarifying question, not accepted, so only ' +
      'use form 2 when you mean it.',
  ].join('\n\n');
}

// Overlap-check prompt - a single system-triggered call made once per
// finalization (see sessionService.applyOverlapCheck), not part of the
// visible back-and-forth with the user.
function buildOverlapCheckMessages({ repo, branch, diff, existingRequirements, candidateRequirements }) {
  const system = [
    `You are Apex, reviewing newly proposed requirements for branch ${branch.branchName} (change order ` +
      `${branch.coNumber}) of repo ${repo.name} for likely overlap with work already agreed on this same branch.`,
    '"Already agreed" means requirements another session on this branch already confirmed to proceed ' +
      'with - it is not a guarantee that work was actually implemented in code, only the best available ' +
      'proxy at this stage. Judge overlap by meaning, not exact wording.',
    'Reply with NOTHING but a single fenced code block labeled ' +
      `"${OVERLAP_CHECK_TAG}" containing a JSON array with exactly one object per candidate requirement, ` +
      'in the same order, each shaped like:\n' +
      '```' +
      OVERLAP_CHECK_TAG +
      '\n[{"requirementIndex": 0, "duplicate": false, "duplicateOfRequirementId": null, "reason": "short reason"}]\n' +
      '```',
    '"requirementIndex" is the candidate\'s position, starting at 0. "duplicate" is true only if the ' +
      'candidate is substantially the same ask as one of the already-agreed requirements listed below - ' +
      'if true, "duplicateOfRequirementId" must be that requirement\'s id from the list. If not a ' +
      'duplicate, set "duplicate" to false and "duplicateOfRequirementId" to null. You must include every ' +
      'candidate index exactly once.',
  ].join('\n\n');

  const existingList =
    existingRequirements.length === 0
      ? 'None recorded yet.'
      : existingRequirements.map((r) => `- id ${r.id}: ${r.content}`).join('\n');
  const candidateList = candidateRequirements.map((text, i) => `${i}: ${text}`).join('\n');

  const user =
    `Current diff vs ${repo.defaultBranchName}:\n${formatDiffForPrompt(diff, repo.defaultBranchName)}\n\n` +
    `Already-agreed requirements on this branch (any user's session):\n${existingList}\n\n` +
    `Newly proposed requirements to check:\n${candidateList}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

module.exports = {
  buildStartSummaryMessages,
  buildQaSystemPrompt,
  buildOverlapCheckMessages,
  REQUIREMENTS_READY_TAG,
  OVERLAP_CHECK_TAG,
};
