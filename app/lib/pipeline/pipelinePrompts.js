// System-prompt / conversation-strategy content for Phase 4's code-generation
// step. See agent-prompts.md's "Phase 4" section for the documented
// contract this implements: the model adapter is still free-text-only (no
// tool-calling - see app/lib/model/modelAdapter.js), so this extends Phase
// 3's fenced-code-block-plus-deterministic-parse convention
// (app/lib/branches/clarificationPrompts.js /
// app/lib/branches/responseParsing.js) with two new tags for a two-step,
// non-tool-calling "what do you need to see, then what do you want to
// change" protocol. Kept as its own module, separate from
// pipelineService.js's orchestration - same separation Phase 3 keeps between
// clarificationPrompts.js and sessionService.js.

const { formatDiffForPrompt } = require('../branches/clarificationPrompts');

const FILES_NEEDED_TAG = 'files-needed';
const FILE_CHANGES_TAG = 'file-changes';

function formatRequirementsForPrompt(requirements) {
  return requirements.map((r, i) => `${i + 1}. ${r}`).join('\n');
}

function formatFileListForPrompt(fileListing) {
  const { files, truncated, totalFiles } = fileListing;
  const header = truncated
    ? `${totalFiles} file(s) in the repository - showing the first ${files.length} (list truncated for length):`
    : `${totalFiles} file(s) in the repository:`;
  return `${header}\n${files.join('\n')}`;
}

// Step 1: ask the model which existing files (if any) it needs to read in
// full before it can write concrete changes. Reply shape mirrors Phase 3's
// convention exactly (a single fenced block, nothing else), but unlike
// requirements-ready, an EMPTY array is a valid, non-ambiguous answer here -
// "I don't need to read anything, I'm only creating new files" is a
// legitimate outcome, not a sign the model failed to answer. See
// app/lib/pipeline/pipelineResponseParsing.js's parseFilesNeeded.
function buildFileSelectionMessages({ repo, branch, requirements, diff, fileListing }) {
  const system = [
    `You are Apex, implementing already-confirmed requirements as concrete file changes on branch ${branch.branchName} ` +
      `(change order ${branch.coNumber}) of repo ${repo.name}.`,
    'You have no tools and cannot execute code or fetch anything further - you only see what is given to you in ' +
      'this conversation. Before writing any changes, decide which existing files (if any) you need to read in ' +
      'full first.',
    'Reply with NOTHING but a single fenced code block labeled ' +
      `"${FILES_NEEDED_TAG}" containing a JSON array of repo-relative file paths, copied exactly as they appear in ` +
      'the file listing below. An empty array is a valid reply if you can satisfy every requirement without ' +
      'reading any existing file (for example, only creating brand-new files). Example:\n' +
      '```' +
      FILES_NEEDED_TAG +
      '\n["app/routes/widgets.js", "app/views/widgets.ejs"]\n' +
      '```',
    'Only name paths that appear in the listing below - a path that is not in the listing cannot be resolved and ' +
      'will fail the run rather than being guessed at or skipped.',
  ].join('\n\n');

  const user =
    `Confirmed requirements to implement (this session's only - already-implemented work from other sessions on ` +
    `this branch is reflected in the diff below, not repeated here):\n${formatRequirementsForPrompt(requirements)}\n\n` +
    `Current diff vs ${repo.defaultBranchName} (what this branch already contains):\n` +
    `${formatDiffForPrompt(diff, repo.defaultBranchName)}\n\n` +
    `${formatFileListForPrompt(fileListing)}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// Step 2: given the actual content of whatever files it asked for, emit the
// concrete file changes. Full file content per change, never a diff/patch
// format - deterministic to apply with a plain fs write, with no risk of an
// LLM getting line offsets wrong the way a patch/diff format would carry
// (see agent-prompts.md's Phase 4 section for the full rationale).
function buildCodeChangesMessages({ repo, branch, requirements, diff, fileContents }) {
  const system = [
    `You are Apex, implementing already-confirmed requirements as concrete file changes on branch ${branch.branchName} ` +
      `(change order ${branch.coNumber}) of repo ${repo.name}.`,
    'You have no tools and cannot execute code or fetch anything further - work only from what is given to you below.',
    'Reply with NOTHING but a single fenced code block labeled ' +
      `"${FILE_CHANGES_TAG}" containing a JSON array with one object per changed file, shaped like:\n` +
      '```' +
      FILE_CHANGES_TAG +
      '\n[{"path": "app/routes/widgets.js", "action": "create", "content": "<entire file content>"}]\n' +
      '```',
    '"action" is "create", "modify", or "delete". "content" must be the ENTIRE new file content (never a diff or ' +
      'patch, and never just the changed lines) for "create"/"modify", and must be omitted (or null) for "delete". ' +
      'Every "path" must be a repo-relative path with no ".." segments, and must not be listed more than once. ' +
      'Include every file that needs to change to satisfy the requirements, and nothing else - a malformed or ' +
      'incomplete reply fails the entire run rather than being partially applied.',
  ].join('\n\n');

  const fileBlocks =
    Object.keys(fileContents).length === 0
      ? '(no existing files were requested in the previous step)'
      : Object.entries(fileContents)
          .map(([filePath, content]) => `--- ${filePath} ---\n${content}`)
          .join('\n\n');

  const user =
    `Confirmed requirements to implement:\n${formatRequirementsForPrompt(requirements)}\n\n` +
    `Current diff vs ${repo.defaultBranchName} (what this branch already contains):\n` +
    `${formatDiffForPrompt(diff, repo.defaultBranchName)}\n\n` +
    `Full content of the files you requested:\n${fileBlocks}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

module.exports = {
  buildFileSelectionMessages,
  buildCodeChangesMessages,
  FILES_NEEDED_TAG,
  FILE_CHANGES_TAG,
};
