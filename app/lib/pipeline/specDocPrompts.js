// System-prompt / conversation-strategy content for Phase 5's Spec/
// Communication Protocol doc generation. See agent-prompts.md's "Phase 5"
// section for the documented contract this implements: same two-step,
// non-tool-calling, fenced-code-block-plus-deterministic-parse convention
// Phase 3/4 already established, extended here with a *decision* step (does
// this branch even need a doc regenerated) ahead of the generation step, so
// a model call - and a file write - only happens when the model judges one
// is actually warranted.
//
// Reuses app/lib/branches/clarificationPrompts.js's formatDiffForPrompt and
// app/lib/pipeline/pipelinePrompts.js's formatFileListForPrompt rather than
// re-implementing either - same reuse-before-new-helper discipline Phase 4
// already follows for these two formatters. Also reuses Phase 4's
// FILES_NEEDED_TAG/parseFilesNeeded pair for this doc's own file-selection
// step (see buildSpecFileSelectionMessages below) rather than inventing a
// third "give me a list of paths" tag that would mean the exact same thing.

const { formatDiffForPrompt } = require('../branches/clarificationPrompts');
const { formatFileListForPrompt, FILES_NEEDED_TAG } = require('./pipelinePrompts');

const SPEC_DECISION_TAG = 'spec-decision';
const SPEC_DOCUMENT_TAG = 'spec-document';

function formatExistingDocForPrompt(existingDoc) {
  return existingDoc === null
    ? 'No existing Spec/Communication Protocol document was found at this change order\'s path.'
    : `Existing Spec/Communication Protocol document content:\n${existingDoc}`;
}

function formatDiffAsSupportingContext({ diff, repo }) {
  return (
    `Diff vs ${repo.defaultBranchName} (SUPPORTING CONTEXT ONLY - shows what changed recently; it is NOT the ` +
    'source of truth for this document, which must describe the full CURRENT state, cumulative across every ' +
    `session/contributor that has touched this branch):\n${formatDiffForPrompt(diff, repo.defaultBranchName)}`
  );
}

// Step 1 (new this phase): decide whether a doc regeneration is even needed,
// before spending a second model call and a file write on one. Given only
// the file listing (not full file contents - that's step 2's job) plus
// whatever existing doc already lives at this CO's path, the model judges
// two independent things. See app/lib/pipeline/specDocResponseParsing.js's
// parseSpecDecision for the fail-closed parsing this must satisfy: an
// unparseable reply is NOT treated as "no surface" or "doc is current" - it
// fails the whole pipeline run, the same way an unparseable files-needed/
// file-changes reply already does in Phase 4.
function buildSpecDecisionMessages({ repo, branch, fileListing, existingDoc, diff }) {
  const system = [
    `You are Apex, judging whether branch ${branch.branchName} (change order ${branch.coNumber}) of repo ` +
      `${repo.name} needs its Spec/Communication Protocol document regenerated.`,
    'This document exists to describe the API surface (HTTP endpoints, request/response contracts, message ' +
      'formats, or any other externally-callable interface) that this branch\'s code CUMULATIVELY exposes right ' +
      'now, so downstream reviewers/integrators do not have to read every file to understand what is callable.',
    'You have no tools and cannot execute code or fetch anything further - judge only from the file listing, ' +
      'the existing document (if any), and the diff given to you below.',
    'Reply with NOTHING but a single fenced code block labeled ' +
      `"${SPEC_DECISION_TAG}" containing a JSON object with exactly two boolean fields:\n` +
      '```' +
      SPEC_DECISION_TAG +
      '\n{"hasApiSurface": true, "docIsCurrent": false}\n' +
      '```',
    '"hasApiSurface" is true only if this branch\'s code currently exposes some kind of API surface at all ' +
      '(HTTP routes/endpoints, public functions meant to be called externally, a message/event contract, etc.) ' +
      '- false for a branch with no such surface (e.g. only internal refactors, styling, docs, or config). ' +
      '"docIsCurrent" only matters when "hasApiSurface" is true: true if the existing document below (if any) ' +
      'still completely and accurately reflects the current API surface; false if it is missing, stale, or ' +
      'incomplete. Set "docIsCurrent" to false (never null or omitted) when there is no existing document to ' +
      'judge, or when "hasApiSurface" is false.',
    'Be conservative: if you are not confident the existing document still matches the current surface, answer ' +
      '"docIsCurrent": false so the document gets regenerated rather than silently drifting further out of date.',
  ].join('\n\n');

  const user = [
    formatFileListForPrompt(fileListing),
    formatExistingDocForPrompt(existingDoc),
    formatDiffAsSupportingContext({ diff, repo }),
  ].join('\n\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// Step 2 (only reached when step 1 says hasApiSurface && !docIsCurrent):
// same "which files do you need to read in full" shape Phase 4's code-gen
// already uses (buildFileSelectionMessages in pipelinePrompts.js), reusing
// the exact same FILES_NEEDED_TAG/parseFilesNeeded pair rather than a
// doc-specific duplicate - the semantics ("name existing files you need to
// read before you can proceed") are identical, only the purpose differs.
function buildSpecFileSelectionMessages({ repo, branch, fileListing, diff }) {
  const system = [
    `You are Apex, about to regenerate the Spec/Communication Protocol document for branch ${branch.branchName} ` +
      `(change order ${branch.coNumber}) of repo ${repo.name}. This document must describe the CUMULATIVE API ` +
      "surface this branch's code exposes right now - full current state, not a diff and not just this " +
      'session\'s changes.',
    'Reply with NOTHING but a single fenced code block labeled ' +
      `"${FILES_NEEDED_TAG}" containing a JSON array of repo-relative file paths, copied exactly as they appear ` +
      'in the file listing below - every file you need to read in full to describe the current API surface ' +
      'completely and accurately (route/controller files, schema/contract definitions, request handlers, etc.). ' +
      'An empty array is a valid reply if you judge the file listing alone is enough (unusual, but not an error).',
    'Only name paths that appear in the listing below - a path that is not in the listing cannot be resolved and ' +
      'will fail this step rather than being guessed at or skipped.',
  ].join('\n\n');

  const user = [formatFileListForPrompt(fileListing), formatDiffAsSupportingContext({ diff, repo })].join('\n\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// Step 3: emit the ENTIRE regenerated document as plain Markdown prose (not
// JSON - this is document content, not structured data), given the content
// of whatever files step 2 asked for.
function buildSpecDocumentMessages({ repo, branch, fileListing, fileContents, diff }) {
  const system = [
    `You are Apex, writing the entire Spec/Communication Protocol document for branch ${branch.branchName} ` +
      `(change order ${branch.coNumber}) of repo ${repo.name}.`,
    'This document must describe the CUMULATIVE, current API surface this branch\'s code exposes as of right ' +
      'now - across every session/contributor that has touched this branch, not just the most recent change. ' +
      'Write it so a new engineer or integrator could read only this document and understand every ' +
      'externally-callable interface this branch provides: endpoints/routes, request/response shapes, ' +
      'authentication expectations, and anything else a caller needs to know.',
    'Reply with NOTHING but a single fenced code block labeled ' +
      `"${SPEC_DOCUMENT_TAG}" containing the ENTIRE document as plain Markdown prose (not JSON - this is ` +
      'document content, not structured data). The block must fully replace any prior version of this document ' +
      '- do not write "unchanged" or refer to a diff for any section; describe the current, complete state.',
  ].join('\n\n');

  const fileBlocks =
    Object.keys(fileContents).length === 0
      ? '(no files were requested in the previous step)'
      : Object.entries(fileContents)
          .map(([filePath, content]) => `--- ${filePath} ---\n${content}`)
          .join('\n\n');

  const user = [
    formatFileListForPrompt(fileListing),
    `Full content of the files you requested:\n${fileBlocks}`,
    formatDiffAsSupportingContext({ diff, repo }),
  ].join('\n\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

module.exports = {
  buildSpecDecisionMessages,
  buildSpecFileSelectionMessages,
  buildSpecDocumentMessages,
  SPEC_DECISION_TAG,
  SPEC_DOCUMENT_TAG,
};
