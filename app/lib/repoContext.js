// Shared repo-context limits and the truncation-announcing read path (see
// ROADMAP.md Phase 19). Before this module, MAX_TREE_PATHS, MAX_FILE_CHARS and
// the '(tree unavailable)' fallback were declared three times over -
// codegenService, clarificationService, specDocService - so a cap could be
// fixed in one reader and left wrong in another. Phase 19's whole-file-write
// guard is only sound if every reader agrees on exactly where truncation
// happens, so the caps and the formatter live here together.
//
// The rule this module exists to enforce: the model is never handed a clipped
// file body that looks complete. Every read returns a record saying whether it
// is the whole file, and readFileForModel's own caller (codegenService) uses
// that record to decide whether a whole-file replace is safe.
const githubApi = require('./github/githubApi');
const repoMap = require('./repoMap');

const MAX_TREE_PATHS = repoMap.MAX_TREE_PATHS;
const MAX_FILE_CHARS = 8000;
const TREE_UNAVAILABLE = '(tree unavailable)';

function countLines(text) {
  return text.length === 0 ? 0 : text.split('\n').length;
}

// fetchTree(org, repo, ref) -> a repo map (see repoMap.js). Thin wrapper kept
// so all three readers still enter repo context through one module.
//
// `complete` keeps the meaning Phase 19 gave it - "absent from this list is
// proof the path does not exist" - but Phase 20 makes it both stricter and
// less often false. Stricter, because GitHub's own `truncated` flag now clears
// it, which nothing checked before. Less often false, because `paths` is now
// the repo's *entire* blob list rather than the first 500: prompt-side
// selection no longer costs the write guard any fidelity, so codegen can
// create new files in a large repo without a wasted FETCH_FILE turn each.
async function fetchTree(org, repo, ref) {
  return repoMap.getMap(repo.id, org.name, repo.name, ref);
}

// renderTree(map) - the prompt's file-tree block. Per-file size and an
// estimated line count, plus an explicit statement of what was left out, so
// the model knows which files it cannot read or rewrite before it spends a
// turn finding out (see ROADMAP.md Phase 20). The read limit is passed through
// from here because MAX_FILE_CHARS is this module's constant, and the marker
// in the tree has to agree with the refusal in codegenService.
function renderTree(map) {
  if (!map || !map.entries || map.entries.length === 0) return TREE_UNAVAILABLE;
  return repoMap.renderMap(map, { readLimitChars: MAX_FILE_CHARS });
}

// readFileForModel(...) -> a read record, never a throw. One of:
//   { status: 'ok', content, truncated, shown*, total* }
//   { status: 'missing' }
//   { status: 'too_large', bytes }   - exists, but over the contents API's 1 MB body limit
//   { status: 'error', reason }
// `content` is already clipped to MAX_FILE_CHARS; `truncated` says whether
// clipping happened, and the total/shown counts are what the prompt text uses
// to tell the model how much of the file it is actually looking at.
async function readFileForModel(owner, repoName, path, ref) {
  let content;
  try {
    content = await githubApi.getFileContent(owner, repoName, path, ref);
  } catch (err) {
    if (err.code === 'file_too_large') return { status: 'too_large', bytes: err.fileBytes || null };
    return { status: 'error', reason: err.message || String(err) };
  }
  if (content === null) return { status: 'missing' };

  const shown = content.slice(0, MAX_FILE_CHARS);
  return {
    status: 'ok',
    content: shown,
    truncated: shown.length < content.length,
    shownChars: shown.length,
    shownLines: countLines(shown),
    totalChars: content.length,
    totalLines: countLines(content),
  };
}

// formatFileForModel(...) -> the user-turn text for a read record. A partial
// read says so in prose, with the real file's totals and the range actually
// shown, and explicitly tells the model not to rewrite the file whole - the
// refusal in codegenService is the enforcement, this is the warning.
function formatFileForModel(path, record, { ref } = {}) {
  const at = ref ? ` at ${ref}` : '';
  switch (record.status) {
    case 'ok':
      if (!record.truncated) {
        return `Contents of ${path} (complete file, ${record.totalLines} lines, ${record.totalChars} characters):\n\`\`\`\n${record.content}\n\`\`\``;
      }
      return [
        `PARTIAL contents of ${path}. This is NOT the whole file.`,
        `The real file is ${record.totalLines} lines / ${record.totalChars} characters; you are being shown only`,
        `lines 1-${record.shownLines} (the first ${record.shownChars} characters, the per-file read limit).`,
        `The remaining ${record.totalChars - record.shownChars} characters were not included and you cannot see them.`,
        'Do not reproduce this file in full - any rewrite of it would delete the part you were not shown.',
        '```',
        record.content,
        '```',
      ].join('\n');
    case 'missing':
      return `${path} was not found${at}.`;
    case 'too_large':
      return [
        `${path} exists${at} but could not be read: it is${record.bytes ? ` ${record.bytes} characters,` : ''} over the 1 MB`,
        'limit of the file-contents API, so none of its contents are available to you.',
        'It does exist - do not treat it as a missing file and do not create it from scratch.',
      ].join('\n');
    default:
      return `${path} could not be read${at}: ${record.reason}`;
  }
}

// fullyRead(record) - the single predicate behind Phase 19's rule. True only
// when the entire file was seen, so a whole-file replace cannot destroy
// anything unseen. A truncated, oversized, or failed read is all equally "not
// fully seen" here.
function fullyRead(record) {
  return Boolean(record) && record.status === 'ok' && !record.truncated;
}

module.exports = {
  MAX_TREE_PATHS,
  MAX_FILE_CHARS,
  TREE_UNAVAILABLE,
  fetchTree,
  renderTree,
  readFileForModel,
  formatFileForModel,
  fullyRead,
};
