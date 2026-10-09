// Shared repo-context limits and the truncation-announcing read path (see
// ROADMAP.md Phase 19). Before this module, MAX_TREE_PATHS, MAX_FILE_CHARS and
// the '(tree unavailable)' fallback were declared three times over -
// codegenService, clarificationService, docService - so a cap could be
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
const structuralIndex = require('./structuralIndex');

const MAX_TREE_PATHS = repoMap.MAX_TREE_PATHS;
const MAX_FILE_CHARS = 8000;
const TREE_UNAVAILABLE = '(tree unavailable)';

// Phase 21's range cap. Deliberately a *line* count rather than a second
// character budget: the point of a ranged read is that the model names a span
// it can reason about, and 400 lines is already more than any single edit
// needs. MAX_FILE_CHARS still applies on top, so a range of 400 very long
// lines is clipped by characters and says so - one cap can bite without the
// other, and the formatter reports whichever did.
const MAX_RANGE_LINES = 400;

// --- The line model -----------------------------------------------------
//
// One definition of "what is line N", used by the tree, the reads, the ranged
// reads and the anchored writes alike. It has to be one definition, and Phase
// 21 is where that stopped being a stylistic preference: a ranged read hands
// the model a line number and an anchored write takes one back, so any two
// components that count lines differently will eventually edit the wrong line.
//
// The specific thing fixed here is a trailing newline. `text.split('\n')` on
// "a\nb\n" yields three elements, the last empty, so Phase 19's countLines
// reported a 231-line file as 232 lines - harmless when the number was prose
// in a truncation warning, and an off-by-one against the container's own
// `wc`-equivalent count the moment ranges exist. A file's last line is the
// last line with text on it; a terminating newline is a terminator, not a line.
function splitLines(text) {
  if (text === '') return { lines: [], endsWithNewline: false };
  const endsWithNewline = text.endsWith('\n');
  const body = endsWithNewline ? text.slice(0, -1) : text;
  return { lines: body.split('\n'), endsWithNewline };
}

// joinLines is splitLines's exact inverse: joinLines(splitLines(x)) === x for
// every x, including the empty string and a lone newline. Anchored writes
// round-trip whole files through this pair, and a pair that is not an exact
// inverse adds or drops a trailing newline on every file it touches - a
// spurious diff line an engineer has to read past on every review.
function joinLines(lines, endsWithNewline) {
  if (lines.length === 0) return endsWithNewline ? '\n' : '';
  return lines.join('\n') + (endsWithNewline ? '\n' : '');
}

function countLines(text) {
  return splitLines(text).lines.length;
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
//
// Phase 21 adds the optional `index`: when a structural index exists for this
// commit, per-file line counts stop being Phase 20's `BYTES_PER_LINE`
// estimate and become the real count the container measured. That matters
// more than it sounds - a ranged read is addressed by line number, so an
// estimate in the tree and exact numbers in the read would have the model
// aiming at coordinates from one system and landing in another.
function renderTree(map, index) {
  if (!map || !map.entries || map.entries.length === 0) return TREE_UNAVAILABLE;
  return repoMap.renderMap(map, {
    readLimitChars: MAX_FILE_CHARS,
    exactLinesFor: index && index.available ? (path) => structuralIndex.exactLines(index, path) : null,
  });
}

// recordFromText(content) -> the same 'ok' read record readFileForModel
// produces, built from text that is already in hand. Phase 21 gave codegen a
// second source of bytes (the container), and the record shape is what Phase
// 19's write guard reads - so the clipping happens here, once, rather than
// each source deciding for itself where a file stops being complete.
function recordFromText(content) {
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
  return recordFromText(content);
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
    // Phase 21: reachable only from a container-served read, where the bytes
    // are whatever is actually on disk rather than something the contents API
    // already decided was text.
    case 'binary':
      return [
        `${path} exists${at} but is a binary file (${record.bytes} bytes, contains NUL bytes), so it`,
        'has no contents you can read or edit through this interface. Leave it alone.',
      ].join('\n');
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

// --- Ranged reads (Phase 21) -------------------------------------------
//
// The fix for Phase 19's append-only context growth is not a bigger window: it
// is reading less. A 3000-line file stops being all-or-nothing once the model
// can name the two spans it needs and leave the other 2600 lines out of the
// context entirely.

// parseRangeSpec('app/lib/foo.js:1200-1400') -> { path, start, end }, or null
// if it is not a range spec at all. Accepts a bare line ('foo.js:42') as a
// one-line range. Rejects rather than repairs an inverted or zero start, so
// the model gets told what it did instead of silently reading somewhere else.
function parseRangeSpec(spec) {
  const match = String(spec).trim().match(/^(.+?):(\d+)(?:-(\d+))?$/);
  if (!match) return null;
  const path = match[1].trim();
  const start = Number(match[2]);
  const end = match[3] === undefined ? start : Number(match[3]);
  if (!path || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { path, start, end };
}

// extractRange(content, start, end) -> { status, ... }. Line numbers are
// 1-based and inclusive, matching the outline and every editor the engineer
// reading the audit trail will have open.
//
// Clamping end past the file's last line is deliberate and is reported;
// refusing it would make "read the tail of this file" require knowing the
// length first. A start past the end of the file is not clamped - that is the
// model addressing a line that does not exist, which it needs told.
function extractRange(content, start, end) {
  const totalLines = countLines(content);
  if (start < 1) return { status: 'bad_range', reason: 'line numbers start at 1', totalLines };
  if (end < start) return { status: 'bad_range', reason: 'the end line is before the start line', totalLines };
  if (start > totalLines) {
    return { status: 'past_end', reason: `the file has only ${totalLines} lines`, totalLines };
  }

  const requested = end - start + 1;
  const lineCapped = requested > MAX_RANGE_LINES;
  const clampedEnd = Math.min(end, totalLines, start + MAX_RANGE_LINES - 1);
  const text = splitLines(content).lines.slice(start - 1, clampedEnd).join('\n');
  const shown = text.slice(0, MAX_FILE_CHARS);

  return {
    status: 'ok',
    content: shown,
    start,
    end: clampedEnd,
    requestedEnd: end,
    totalLines,
    lineCapped,
    charCapped: shown.length < text.length,
    endClamped: end > totalLines,
  };
}

// formatRangeForModel(path, range) -> the user-turn text for an extractRange
// result. States the span actually returned in every case, because the model's
// next move is an anchored write addressed by these exact numbers.
function formatRangeForModel(path, range) {
  if (range.status === 'bad_range') {
    return `Cannot read that range of ${path}: ${range.reason}. The file has ${range.totalLines} lines.`;
  }
  if (range.status === 'past_end') {
    return `Cannot read that range of ${path}: ${range.reason}, so the start line you asked for does not exist.`;
  }

  const notes = [];
  if (range.lineCapped) notes.push(`the ${range.requestedEnd - range.start + 1}-line span you asked for is over the ${MAX_RANGE_LINES}-line range limit`);
  else if (range.endClamped) notes.push(`you asked for line ${range.requestedEnd}, but the file ends at ${range.totalLines}`);
  if (range.charCapped) notes.push(`output was further clipped at the ${MAX_FILE_CHARS}-character read limit, so the last lines of this range are missing`);

  const header = [
    `Lines ${range.start}-${range.end} of ${path} (the file has ${range.totalLines} lines in total).`,
    notes.length ? `Note: ${notes.join('; ')}.` : null,
    'Line numbers below are not part of the file - they are there so you can address a span.',
  ]
    .filter(Boolean)
    .join('\n');

  // Numbered, because an anchored write names a line range and the model
  // should not have to count. The numbers are stripped by nobody - they never
  // enter a write; the anchor text the model sends back is compared against
  // the file's own bytes, not against this rendering.
  const body = range.content.split('\n').map((line, i) => `${range.start + i}\t${line}`).join('\n');
  return `${header}\n\`\`\`\n${body}\n\`\`\``;
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
  MAX_RANGE_LINES,
  TREE_UNAVAILABLE,
  splitLines,
  joinLines,
  countLines,
  fetchTree,
  renderTree,
  recordFromText,
  readFileForModel,
  formatFileForModel,
  parseRangeSpec,
  extractRange,
  formatRangeForModel,
  fullyRead,
};
