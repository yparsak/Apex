// Structural index of a repo's working tree (see ROADMAP.md Phase 21).
//
// Phase 20 gave the model a size-aware map: exact bytes, estimated lines, no
// idea what is *in* any file. That is enough to judge "is this file big?" and
// nothing else, so a 3000-line file stayed all-or-nothing - read every line or
// none of them, rewrite every line or none of them.
//
// This module is the other half. It builds, from the clone Phase 7 already put
// in the sandbox container, two things the GitHub API cannot cheaply give:
//
//   1. **Exact line counts.** Phase 20's `BYTES_PER_LINE = 40` estimate becomes
//      decoration the moment a real count is available, and a ranged read is
//      only addressable if the model knows how many lines there are to address.
//   2. **A per-file outline** - declaration-looking lines with their line
//      ranges - so the model can navigate a large file by symbol and then pull
//      the two regions it needs, instead of pulling 3000 lines to find 20.
//
// Both come from one `exec` into a container that already exists, over a clone
// nobody was reading, at zero GitHub API cost and zero token cost. The
// alternative - pulling every file through `getFileContent` - is thousands of
// API calls per repo for data sitting on a local disk, and is rejected in the
// roadmap for that reason.
//
// **The outline is a navigation hint, not ground truth.** Extraction is a
// language-agnostic regex pass in awk, deliberately: real per-language parsing
// means dragging a toolchain into the sandbox image, which Phase 7 keeps
// per-repo and minimal, and the image is the *user's* image - Apex does not get
// to assume what is installed in it. So the pass assumes only POSIX `sh`, `awk`
// and `git`, the last of which the clone step already proved is present. It
// will miss declarations and invent a few; nothing downstream trusts it. Ranged
// reads are addressed by line number and verified against the file, and
// anchored writes are verified against their anchor text - neither consults the
// outline. A wrong outline costs the model a wasted read, never a wrong write.
const db = require('./db');
const dockerRunner = require('./docker/dockerRunner');
const repoMap = require('./repoMap');

// Where the extractor is staged inside the container. Under /tmp rather than
// the workspace so it never shows up in `git status` and cannot be swept into
// the commit codegenStep makes.
const SCRIPT_PATH = '/tmp/apex-outline.awk';

// Caps. All three exist to bound one pathological repo's index, and all three
// are *reported* when they bite (see buildIndex's `limits`) rather than
// silently applied - a truncated index that reads as complete is the same
// failure Phase 20 fixed in the file tree.
const MAX_INDEX_FILES = 4000;
const MAX_SYMBOLS_PER_FILE = 300;
const MAX_LINES_SCANNED = 100000;
const MAX_SYMBOL_TEXT_CHARS = 160;

// Index-build timeout. One pass over a few thousand files is seconds; this is
// a backstop against a repo with a pathological file (a single 2 GB CSV that
// slipped past the exclusion rules), not a normal-case budget.
const BUILD_TIMEOUT_MS = Number(process.env.APEX_INDEX_TIMEOUT_MS || 120000);

// The extractor. Staged as a *file* via dockerRunner.writeFile (which streams
// over stdin) rather than passed as an argv string, so none of it is subject
// to shell quoting - the regexes below contain almost every character a shell
// cares about.
//
// Portability notes, since this runs in an image Apex does not control:
//   - No `{n,m}` interval expressions. mawk historically needs -W re-interval
//     for them, so leading indentation is matched with four optional single
//     character classes instead. Ugly, universally supported.
//   - `getline line < path` opens the file itself, so the file list arrives on
//     stdin and argv never grows with the repo - no ARG_MAX ceiling, and no
//     `xargs` batching to get wrong.
//   - `close(path)` per file, or a repo with a few thousand files exhausts the
//     awk process's file descriptors partway through and silently indexes less
//     than it was given.
const OUTLINE_AWK = String.raw`
# Reads a NUL-free list of repo-relative paths on stdin, one per line, and
# emits for each:
#   F <TAB> lines <TAB> truncated(0|1) <TAB> path
#   S <TAB> startLine <TAB> declaration text        (zero or more, after its F)
# Line numbers are 1-based and count every line, including ones skipped for
# symbol extraction, so a range read against them always lands where the model
# meant it to.
# Every regex below is anchored against the *trimmed* line, with indentation
# measured separately, because indentation is what separates "a declaration"
# from "a statement that happens to start with a keyword". Matching against the
# raw line with a tolerant leading-whitespace prefix - the obvious first cut -
# turns every nested "const x = ..." and every "if (...) {" into an outline
# entry, which is worse than no outline: it is 200 hits that bury the 12 the
# model wanted.
BEGIN {
  FS = "\n"
  MODS = "((export|default|async|public|private|protected|internal|static|abstract|final|open|override|inline|extern|local|declare)[ \t]+)*"
  KW = "(function|class|const|let|var|interface|type|enum|struct|trait|impl|module|package|namespace|def|defn|defmodule|fn|func|sub|proc|object|record|template|union|typedef)[ \t]"
  TOPKW = "^" MODS KW
  # Indented declarations: class members and methods only. Pointedly *not*
  # const/let/var - a local binding four spaces in is a statement, not
  # structure, and including it is what made the first version unusable.
  MEMBERKW = "^((public|private|protected|internal|static|abstract|final|override|async|open|get|set)[ \t]+)*(function|def|fn|func|class|sub|proc)[ \t]"
  # name(args) { - C, Java, C#, Go methods, JS method shorthand, shell
  # functions. Requires the brace on the same line, which is the common case
  # and keeps this to one regex.
  # The bracket expression below deliberately contains no "[" or "]": escaping
  # a bracket inside a bracket expression is not portable ERE, and array types
  # in a signature are not worth the risk of a regex that fails to compile in
  # one awk implementation and takes the whole index build down with it.
  CALLISH = "^[A-Za-z_~][A-Za-z0-9_:<>,.*& \t-]*\\([^)]*\\)[ \t]*(const[ \t]*)?\\{[ \t]*$"
  # Control flow, and imports. These match TOPKW/CALLISH on syntax and carry no
  # structural information whatsoever, so they are rejected before either runs.
  NOISE = "^(if|for|while|switch|catch|do|else|elif|elsif|end|return|try|case|when|unless|foreach|using|import|from|include)[ \t(]"
  REQUIRE = "=[ \t]*require\\("
  SQL = "^[Cc][Rr][Ee][Aa][Tt][Ee][ \t]"
  HEAD = "^#+[ \t]"
}
{
  path = $0
  if (path == "" || substr(path, 1, 1) == "\"") next   # git quotes odd names; skip them
  # Markdown headings are the only structure a docs file has, and they are what
  # a requirement about documentation refers to. Gated on extension because
  # "^#+[ \t]" is also every comment in sh, Python, Ruby, YAML and Make - left
  # ungated it would make the outline for a shell script pure noise.
  ismd = (path ~ /\.(md|markdown|mdx|rst)$/)
  n = 0
  nsym = 0
  trunc = 0
  while ((getline line < path) > 0) {
    n++
    if (n > MAXLINES) { trunc = 1; break }
    if (nsym >= MAXSYM) continue
    t = line
    sub(/^[ \t]+/, "", t)
    ind = length(line) - length(t)
    sub(/[ \t\r]+$/, "", t)
    if (t == "") continue
    if (ismd) {
      if (t !~ HEAD) continue
    } else {
      if (t ~ NOISE || t ~ REQUIRE) continue
      if (ind == 0) {
        if (t !~ TOPKW && t !~ CALLISH && t !~ SQL) continue
      } else if (ind <= 4) {
        if (t !~ MEMBERKW && t !~ CALLISH) continue
      } else continue
    }
    if (length(t) > MAXTEXT) t = substr(t, 1, MAXTEXT) "..."
    nsym++
    sym[nsym] = n "\t" t
  }
  close(path)
  printf "F\t%d\t%d\t%s\n", n, trunc, path
  for (i = 1; i <= nsym; i++) printf "S\t%s\n", sym[i]
  for (i = 1; i <= nsym; i++) delete sym[i]
}
`;

// buildIndex({ containerId, repoRoot }) -> an index, never a throw. Failure
// degrades to `available: false`, which costs the model exact line counts and
// outlines and costs nothing else: ranged reads read the container directly and
// anchored writes verify against the container directly, so neither needs this
// to have succeeded. That is the reason index-build failure is logged rather
// than failing the codegen step.
async function buildIndex({ containerId, repoRoot }) {
  const index = {
    available: false,
    files: {},
    fileCount: 0,
    reason: null,
    headSha: null,
    limits: { filesOmitted: 0, filesLineTruncated: 0, filesSymbolCapped: 0 },
  };

  try {
    await dockerRunner.writeFile(containerId, SCRIPT_PATH, OUTLINE_AWK);
  } catch (err) {
    index.reason = `could not stage the outline extractor in the container: ${err.message}`;
    return index;
  }

  // `git ls-files` rather than `find`: it is already guaranteed present (the
  // clone step used it), it yields exactly the tracked tree, and it therefore
  // excludes .git internals and anything gitignored without this module having
  // to restate Phase 20's directory rules in shell. The authoritative
  // exclusion still happens on the host below, through repoMap.isExcluded, so
  // the two halves of Apex cannot disagree about what a listable file is.
  let result;
  try {
    result = await dockerRunner.exec(
      containerId,
      [
        'sh',
        '-c',
        `cd "$1" && git ls-files | awk -v MAXSYM="$2" -v MAXLINES="$3" -v MAXTEXT="$4" -f "$5"`,
        '_',
        repoRoot,
        String(MAX_SYMBOLS_PER_FILE),
        String(MAX_LINES_SCANNED),
        String(MAX_SYMBOL_TEXT_CHARS),
        SCRIPT_PATH,
      ],
      { timeoutMs: BUILD_TIMEOUT_MS }
    );
  } catch (err) {
    index.reason = err.message || String(err);
    return index;
  }
  if (result.code !== 0) {
    index.reason = (result.stderr || `awk pass exited ${result.code}`).trim().slice(0, 500);
    return index;
  }

  parseIndexOutput(result.stdout, index);

  // The commit the index actually describes, which is not assumed to be the
  // sha repoMap resolved from the branch name: those are two lookups a moment
  // apart, and a push landing between them would have Apex persisting this
  // commit's outline under that commit's key. Nothing in *this* run would
  // notice - the run reads the container, not the row - but a later
  // clarification would be handed line numbers for a tree it is not looking
  // at. Cheap to check, so it is checked, and saveIndex refuses a mismatch.
  try {
    const head = await dockerRunner.exec(containerId, ['git', '-C', repoRoot, 'rev-parse', 'HEAD']);
    if (head.code === 0) index.headSha = head.stdout.trim() || null;
  } catch (err) {
    index.headSha = null;
  }

  return index;
}

// parseIndexOutput(stdout, index) - split out from buildIndex so the parse is
// exercisable without a container. The `F`/`S` stream is order-dependent: an
// `S` belongs to the most recent `F`, which is what lets the extractor emit
// without buffering a whole repo in awk memory.
function parseIndexOutput(stdout, index) {
  let current = null;
  for (const raw of stdout.split('\n')) {
    if (raw === '') continue;
    const tab = raw.indexOf('\t');
    if (tab === -1) continue;
    const kind = raw.slice(0, tab);
    const rest = raw.slice(tab + 1);

    if (kind === 'F') {
      const parts = rest.split('\t');
      if (parts.length < 3) continue;
      const lines = Number(parts[0]);
      const truncated = parts[1] === '1';
      // The path may itself contain tabs; everything after the second field is
      // path, rejoined rather than taken as parts[2].
      const path = parts.slice(2).join('\t');
      current = null;
      // Phase 20's exclusion rules, applied here rather than restated in awk.
      // A file not worth a slot in the prompt's tree is not worth an outline.
      if (!path || repoMap.isExcluded(path) || !Number.isFinite(lines)) continue;
      if (index.fileCount >= MAX_INDEX_FILES) {
        index.limits.filesOmitted += 1;
        continue;
      }
      current = { lines, symbols: [] };
      if (truncated) index.limits.filesLineTruncated += 1;
      index.files[path] = current;
      index.fileCount += 1;
      continue;
    }

    if (kind === 'S' && current) {
      const sep = rest.indexOf('\t');
      if (sep === -1) continue;
      const start = Number(rest.slice(0, sep));
      const text = rest.slice(sep + 1);
      if (!Number.isFinite(start) || !text) continue;
      if (current.symbols.length >= MAX_SYMBOLS_PER_FILE) continue;
      current.symbols.push([start, text]);
    }
  }

  for (const entry of Object.values(index.files)) {
    if (entry.symbols.length >= MAX_SYMBOLS_PER_FILE) index.limits.filesSymbolCapped += 1;
  }

  index.available = index.fileCount > 0;
  if (!index.available) index.reason = index.reason || 'the outline pass listed no indexable files';
  return index;
}

// emptyIndex() - what every caller without an index uses, so no caller needs a
// null check. Same shape as a failed build, which is the point: "no container
// has ever run for this repo" and "the index build failed" are the same
// condition downstream.
function emptyIndex() {
  return {
    available: false,
    files: {},
    fileCount: 0,
    reason: null,
    headSha: null,
    limits: { filesOmitted: 0, filesLineTruncated: 0, filesSymbolCapped: 0 },
  };
}

// --- Persistence --------------------------------------------------------
//
// Extends Phase 20's per-(repo, sha) row rather than adding a second store, so
// one lookup answers "what is in this commit?" completely. The asymmetry this
// introduces is deliberate and worth stating: the Phase 20 map is buildable
// from the GitHub API alone, so it exists on the repo page before any pipeline
// run, while the index needs a container, so it exists from the first
// successful codegen onward. A repo with no run yet simply has the map and no
// outline - and since the index is only ever needed where a container already
// exists, or as a bonus to clarification when an earlier run happened to leave
// one, that costs nothing.

// Enough for a very large repo's outline and small enough that a runaway one
// is rejected rather than stored. LONGTEXT could hold far more; the cap is
// about not making every cache hit pay to parse it.
const MAX_INDEX_JSON_CHARS = 4 * 1024 * 1024;

async function saveIndex(repoId, commitSha, index) {
  if (!repoId || !commitSha || !index.available) return false;
  // See buildIndex: an index whose container HEAD disagrees with the key it
  // would be stored under describes a different commit's files, and a wrong
  // outline that looks authoritative is worse than no outline.
  if (index.headSha && index.headSha !== commitSha) return false;
  const json = JSON.stringify({ files: index.files, limits: index.limits });
  if (json.length > MAX_INDEX_JSON_CHARS) return false;
  try {
    // UPDATE, not INSERT: the Phase 20 row for this sha is written by
    // repoMap.getMap before codegen ever starts. If it somehow is not there,
    // this updates nothing and the index is simply not cached - the in-memory
    // one this run built is still used for this run.
    const [result] = await db.query(
      'UPDATE repo_file_maps SET structural_index_json = ?, indexed_at = CURRENT_TIMESTAMP WHERE repo_id = ? AND commit_sha = ?',
      [json, repoId, commitSha]
    );
    return (result.affectedRows || 0) > 0;
  } catch (err) {
    // Same reasoning as repoMap's cache: an unsaved index is still a correct
    // index for the run that built it.
    return false;
  }
}

// loadIndex(repoId, commitSha) -> an index, never a throw. This is the
// clarification-side read: no container exists there, so the only outline
// available is one some earlier codegen run left behind for this exact commit.
async function loadIndex(repoId, commitSha) {
  if (!repoId || !commitSha) return emptyIndex();
  try {
    const [[row]] = await db.query(
      'SELECT structural_index_json FROM repo_file_maps WHERE repo_id = ? AND commit_sha = ?',
      [repoId, commitSha]
    );
    if (!row || !row.structural_index_json) return emptyIndex();
    const parsed = JSON.parse(row.structural_index_json);
    const index = emptyIndex();
    index.files = parsed.files || {};
    index.limits = parsed.limits || index.limits;
    index.fileCount = Object.keys(index.files).length;
    index.available = index.fileCount > 0;
    return index;
  } catch (err) {
    return emptyIndex();
  }
}

// --- Rendering ----------------------------------------------------------

// exactLines(index, path) -> the real line count, or null. This is what lets
// the file tree stop saying "~". Callers must treat null as "no index for this
// path" and fall back to Phase 20's estimate rather than to zero.
function exactLines(index, path) {
  const entry = index && index.files ? index.files[path] : null;
  return entry && Number.isFinite(entry.lines) ? entry.lines : null;
}

// renderOutline(index, path) -> the FETCH_OUTLINE reply, or null if this path
// has no outline.
//
// Each symbol is given an end line, derived as "one before the next symbol"
// and clamped to the file's length. That is an over-claim for the gap between
// two top-level declarations and it is still the right thing to show: the
// model's next move is a ranged read, and a range that is slightly too wide
// costs a few extra lines of context, while one that is too narrow costs a
// wrong edit. The header says the ranges are approximate so the model does not
// reason from them as if they were a parse.
function renderOutline(index, path) {
  const entry = index && index.files ? index.files[path] : null;
  if (!entry) return null;

  if (entry.symbols.length === 0) {
    return [
      `Outline of ${path}: ${entry.lines} lines, no declaration-like lines detected.`,
      'This is a regex pass, not a parser - "none found" can mean the file has no',
      `declarations or that its language is not recognized. Read it with FETCH_RANGE: ${path}:1-200.`,
    ].join('\n');
  }

  const rows = entry.symbols.map(([start, text], i) => {
    const next = entry.symbols[i + 1];
    const end = next ? Math.max(start, next[0] - 1) : entry.lines;
    return `  ${start}-${end}  ${text}`;
  });

  return [
    `Outline of ${path} (${entry.lines} lines). Line ranges are approximate - each entry runs`,
    'to the line before the next one, which over-claims the gap between declarations. The',
    'line numbers themselves are exact. Use FETCH_RANGE to read a span before editing it.',
    ...rows,
  ].join('\n');
}

module.exports = {
  MAX_INDEX_FILES,
  MAX_SYMBOLS_PER_FILE,
  MAX_LINES_SCANNED,
  OUTLINE_AWK,
  buildIndex,
  parseIndexOutput,
  emptyIndex,
  saveIndex,
  loadIndex,
  exactLines,
  renderOutline,
};
