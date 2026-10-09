// Size-aware repo file map (see ROADMAP.md Phase 20).
//
// Before this module, the only structural artifact Apex had was githubApi's
// flat path list: re-fetched from GitHub by each of its three callers on every
// request, cut by a blind `paths.slice(0, 500)`, and joined with newlines into
// the prompt. Three things were wrong with that, and this module fixes all
// three against the same single tree call:
//
//   1. GitHub sends a byte `size` with every blob and the old code dropped it.
//      Carrying it through means the model can see that a file is too big to
//      read or rewrite *before* spending a FETCH_FILE turn to find out - which
//      is what turns Phase 19's write refusal from a surprise mid-run into a
//      visible, up-front constraint.
//   2. The 500-path cut had no notion of what was worth keeping. With no
//      extension filter at all, lockfiles, minified bundles, images and
//      vendored trees consumed slots, so in a large repo the files a
//      requirement actually concerns could simply never appear. Selection is
//      now explicit - exclude, then rank, then budget - and whatever got
//      dropped is *stated in the prompt*, because a tree that is quietly 500 of
//      4,000 files reads to the model as the whole repo.
//   3. The clipped list was also what Phase 19's write guard used as proof a
//      path was new. The map keeps the full path list separate from the
//      rendered selection, so narrowing what the model *sees* never widens what
//      the guard will *allow*.
//
// Persisted per (repo_id, commit_sha): three callers in one session make one
// tree call between them, and a repo whose trunk hasn't moved isn't re-walked
// at all.
const db = require('./db');
const githubApi = require('./github/githubApi');

// The selection budget. Still 500, but it now bounds a ranked selection rather
// than naming the point at which an arbitrary list got cut.
const MAX_TREE_PATHS = 500;

// Average bytes per line, used to approximate line counts. GitHub gives bytes
// for free; exact line counts would need every file's content, which is the
// expensive part this module exists to avoid - so the map ships byte-accurate
// and line-approximate, and the rendering says "~" so the model reads it as an
// estimate. (Phase 21's container pass can produce exact counts; see
// undecided_topics.md.)
const BYTES_PER_LINE = 40;

// Exclusion is global, not per-repo. Per-repo rules (an apex.pipeline.json key)
// would be more correct for monorepos, but Stack decisions have kept that file
// deliberately plain and nothing has yet demanded the config surface - see
// undecided_topics.md.
const EXCLUDED_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', 'bower_components', 'vendor', 'third_party',
  'dist', 'build', 'out', 'target', 'coverage', '__pycache__', '.pytest_cache',
  '.next', '.nuxt', '.cache', '.gradle', '.idea', '.vscode', 'venv', '.venv',
  'Pods', 'DerivedData', '.terraform',
]);

const EXCLUDED_FILENAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json',
  'Gemfile.lock', 'poetry.lock', 'composer.lock', 'Cargo.lock', 'go.sum',
  'Podfile.lock', '.DS_Store',
]);

// Non-text, or text that is generated rather than authored. Both are noise in
// a prompt: the model can neither usefully read nor sensibly edit them.
const EXCLUDED_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'tiff', 'ico', 'webp', 'svg', 'psd', 'ai',
  'pdf', 'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar',
  'jar', 'war', 'ear', 'class', 'so', 'dll', 'dylib', 'exe', 'bin', 'o', 'a', 'obj',
  'woff', 'woff2', 'ttf', 'eot', 'otf',
  'mp3', 'mp4', 'mov', 'avi', 'wav', 'webm', 'flac',
  'xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt',
  'db', 'sqlite', 'sqlite3', 'mdb',
  'pyc', 'pyo', 'wasm', 'node', 'pack', 'idx', 'map', 'lock',
]);

const SOURCE_EXTS = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'ejs', 'vue', 'svelte',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'swift', 'm', 'mm',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'pl', 'lua', 'r', 'dart', 'ex', 'exs',
  'sql', 'sh', 'bash', 'zsh', 'ps1',
]);

const CONFIG_EXTS = new Set([
  'json', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties',
  'xml', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'md', 'rst', 'txt',
  'gradle', 'tf', 'proto', 'graphql',
]);

// Root-level files that describe the repo as a whole. These earn the top rank
// outright: they are how the model orients, and they are what the build and
// test steps actually run against.
const ROOT_MANIFESTS = new Set([
  'apex.pipeline.json', 'package.json', 'readme.md', 'makefile', 'dockerfile',
  'docker-compose.yml', 'docker-compose.yaml', 'tsconfig.json', 'go.mod',
  'pom.xml', 'build.gradle', 'requirements.txt', 'pyproject.toml', 'setup.py',
  'cargo.toml', 'gemfile', 'composer.json', '.env.example',
]);

function extensionOf(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function basenameOf(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

function isMinified(name) {
  return /\.min\.(js|css)$/i.test(name) || /\.bundle\.js$/i.test(name) || /-lock\.(json|yaml)$/i.test(name);
}

function looksLikeTest(path) {
  const lower = path.toLowerCase();
  return (
    /(^|\/)(tests?|spec|specs|__tests__|__mocks__|fixtures|testdata)(\/|$)/.test(lower) ||
    /\.(test|spec)\.[a-z0-9]+$/.test(lower) ||
    /(^|\/)test_[^/]+$/.test(lower)
  );
}

// isExcluded(path) - true for paths that should never occupy a slot in the
// budget. Note this hides a file from the *prompt* only; it stays in the map's
// full path list, so the write guard still knows it exists.
function isExcluded(path) {
  const segments = path.split('/');
  const name = segments[segments.length - 1];
  if (segments.slice(0, -1).some((seg) => EXCLUDED_DIRS.has(seg))) return true;
  if (EXCLUDED_FILENAMES.has(name)) return true;
  if (isMinified(name)) return true;
  return EXCLUDED_EXTS.has(extensionOf(path));
}

// rankOf(path) - lower sorts first. The ordering encodes what a requirement is
// most likely to be about: how the repo is built and described, then the code
// itself, then the tests that pin the code's behavior, then supporting config,
// then whatever is left.
function rankOf(path) {
  const depth = path.split('/').length - 1;
  const ext = extensionOf(path);
  if (depth === 0 && ROOT_MANIFESTS.has(basenameOf(path).toLowerCase())) return 0;
  if (looksLikeTest(path)) return SOURCE_EXTS.has(ext) ? 2 : 3;
  if (SOURCE_EXTS.has(ext)) return 1;
  if (CONFIG_EXTS.has(ext)) return 3;
  return 4;
}

// Ranked within a tier by shallowness - a repo's own top-level layout is more
// informative than one more file buried eight directories down - then by path,
// so the same commit always produces the same map.
function compareEntries(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  const depthA = a.path.split('/').length;
  const depthB = b.path.split('/').length;
  if (depthA !== depthB) return depthA - depthB;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

// selectEntries(entries) -> the map's prompt-facing half. Everything it drops
// it counts, because the counts are what the rendering reports; silently
// cutting is the failure mode this replaces.
function selectEntries(entries) {
  const kept = [];
  let excludedCount = 0;
  for (const entry of entries) {
    if (isExcluded(entry.path)) {
      excludedCount += 1;
      continue;
    }
    kept.push({ path: entry.path, bytes: entry.bytes, rank: rankOf(entry.path) });
  }
  kept.sort(compareEntries);
  const selected = kept.slice(0, MAX_TREE_PATHS).map(({ path, bytes }) => ({ path, bytes }));
  return { selected, excludedCount, omittedCount: kept.length - selected.length };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function approxLines(bytes) {
  if (bytes === 0) return 0;
  const raw = bytes / BYTES_PER_LINE;
  return raw >= 100 ? Math.round(raw / 10) * 10 : Math.max(1, Math.round(raw));
}

function formatCount(n) {
  return n.toLocaleString('en-US');
}

// An empty map is what every failure degrades to: no entries, no paths, and
// `complete: false`. The flag is load-bearing - it is what stops Phase 19's
// guard from reading "absent from this list" as "does not exist in the repo"
// when the list is simply missing.
function emptyMap() {
  return {
    sha: null,
    paths: [],
    entries: [],
    complete: false,
    githubTruncated: false,
    totalFiles: 0,
    totalBytes: 0,
    excludedCount: 0,
    omittedCount: 0,
  };
}

// renderMap(map, { readLimitChars }) -> the body of the prompt's FILE TREE block.
//
// Every line carries magnitude, and files past the read limit are called out
// by name, so "this file cannot be rewritten through this interface" is
// information the model has before it acts rather than a refusal it discovers
// afterwards. The trailer states what is missing from the listing and
// explicitly says those files still exist - without it, an absent path reads
// as a file the model is free to create from scratch.
// `exactLinesFor` (Phase 21) is an optional `path -> number|null` lookup into
// the structural index. Where it answers, the `~` estimate is replaced by the
// count the container actually measured, per file rather than all-or-nothing:
// a repo whose index was built before a file was added renders that one file
// as an estimate and the rest exactly, which is the honest rendering and
// costs nothing to support.
function renderMap(map, { readLimitChars, exactLinesFor } = {}) {
  if (!map || map.entries.length === 0) return '(tree unavailable)';

  const scope =
    map.omittedCount || map.excludedCount
      ? `${formatCount(map.entries.length)} of ${formatCount(map.totalFiles)} files, most relevant first.`
      : `All ${formatCount(map.totalFiles)} files.`;

  const lines = [];
  let anyEstimated = false;
  for (const entry of map.entries) {
    const exact = exactLinesFor ? exactLinesFor(entry.path) : null;
    if (exact === null || exact === undefined) anyEstimated = true;
    const lineText = exact === null || exact === undefined ? `~${formatCount(approxLines(entry.bytes))}` : formatCount(exact);
    // The read-limit marker keys on bytes, not lines, because MAX_FILE_CHARS
    // is a character cap - and bytes are exact whether or not an index exists.
    // What the marker means has narrowed since Phase 20: such a file still
    // cannot be read whole or rewritten whole, but it can now be read and
    // edited by range, so the text says so rather than writing the file off.
    const over = readLimitChars && entry.bytes > readLimitChars ? '  [too large to read whole - use ranges]' : '';
    lines.push(`${entry.path} - ${formatBytes(entry.bytes)}, ${lineText} lines${over}`);
  }

  const header = `${scope} Sizes are exact; line counts are ${
    exactLinesFor ? (anyEstimated ? 'exact except where marked "~"' : 'exact') : 'estimates'
  }.`;

  const trailer = [];
  if (map.excludedCount) {
    trailer.push(`${formatCount(map.excludedCount)} generated, vendored, or non-text files are not listed`);
  }
  if (map.omittedCount) {
    trailer.push(`${formatCount(map.omittedCount)} further files were omitted for space`);
  }
  if (trailer.length) {
    trailer.push('they all still exist in the repo - do not treat an unlisted path as a file you can create');
  }
  if (map.githubTruncated) {
    trailer.push(
      "GitHub's own tree listing for this repo was truncated, so some paths are unknown to Apex entirely"
    );
  }

  return trailer.length ? `${header}\n${lines.join('\n')}\n(${trailer.join('; ')}.)` : `${header}\n${lines.join('\n')}`;
}

function rowToMap(row) {
  return {
    sha: row.commit_sha,
    paths: JSON.parse(row.paths_json),
    entries: JSON.parse(row.selected_json),
    complete: !row.github_truncated,
    githubTruncated: Boolean(row.github_truncated),
    totalFiles: row.total_files,
    totalBytes: Number(row.total_bytes),
    excludedCount: row.excluded_files,
    omittedCount: row.omitted_files,
  };
}

// getMap(repoId, owner, repoName, ref) -> a map, never a throw. Resolves the
// ref to a commit sha first so the cache can be keyed on content rather than
// on a branch name that moves under it.
//
// Cache misses cost one tree call; hits cost one branch call and one row read.
// The branch call is not avoidable - it is how we learn whether the cached sha
// is still the ref's head - but it is cheap next to re-walking a large repo
// three times per session.
async function getMap(repoId, owner, repoName, ref) {
  let sha;
  try {
    const branch = await githubApi.getBranch(owner, repoName, ref);
    if (!branch) return emptyMap();
    sha = branch.commit.sha;
  } catch (err) {
    return emptyMap(); // degrade to no tree context rather than blocking the caller
  }

  if (repoId) {
    try {
      const [[row]] = await db.query('SELECT * FROM repo_file_maps WHERE repo_id = ? AND commit_sha = ?', [
        repoId,
        sha,
      ]);
      if (row) {
        // Touched on read so pruneUnused can retire maps for branches nobody
        // works on any more, rather than only the trunk shas it can see.
        db.query('UPDATE repo_file_maps SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?', [row.id]).catch(() => {});
        return rowToMap(row);
      }
    } catch (err) {
      // A cache that can't be read is a performance problem, not a correctness
      // one - fall through and build the map from GitHub.
    }
  }

  let tree;
  try {
    tree = await githubApi.getTreeBySha(owner, repoName, sha);
  } catch (err) {
    return emptyMap();
  }

  const { selected, excludedCount, omittedCount } = selectEntries(tree.entries);
  const map = {
    sha,
    // The complete path list, deliberately not the selection: this is what the
    // write guard asks "does this path exist?", and narrowing it would let the
    // guard approve a whole-file write over a real file that merely didn't fit
    // in the prompt.
    paths: tree.entries.map((entry) => entry.path),
    entries: selected,
    complete: !tree.truncated,
    githubTruncated: tree.truncated,
    totalFiles: tree.entries.length,
    totalBytes: tree.entries.reduce((sum, entry) => sum + entry.bytes, 0),
    excludedCount,
    omittedCount,
  };

  if (repoId) {
    try {
      await db.query(
        `INSERT INTO repo_file_maps
           (repo_id, commit_sha, github_truncated, total_files, total_bytes, excluded_files, omitted_files, selected_json, paths_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE last_used_at = CURRENT_TIMESTAMP`,
        [
          repoId,
          sha,
          map.githubTruncated,
          map.totalFiles,
          map.totalBytes,
          map.excludedCount,
          map.omittedCount,
          JSON.stringify(map.entries),
          JSON.stringify(map.paths),
        ]
      );
    } catch (err) {
      // Same reasoning as the read side: an uncached map is still a correct map.
    }
  }

  return map;
}

// pruneUnused(days) - drops maps nothing has asked for in `days`. Rides Phase
// 15's nightly docWorker.js invocation rather than inventing a second schedule
// - called from its main(), deliberately not from the trunk scan it used to sit
// inside (see ROADMAP.md Phase 23: once every document type can be disabled, a
// prune riding the scan stops the moment the last one is unchecked). Keyed on
// last use, not on whether the sha is still a branch head, because a map for an
// in-flight DEV branch is exactly the one worth keeping.
async function pruneUnused(days = 14) {
  const [result] = await db.query('DELETE FROM repo_file_maps WHERE last_used_at < (NOW() - INTERVAL ? DAY)', [days]);
  return result.affectedRows || 0;
}

module.exports = {
  MAX_TREE_PATHS,
  BYTES_PER_LINE,
  isExcluded,
  rankOf,
  selectEntries,
  formatBytes,
  approxLines,
  emptyMap,
  renderMap,
  getMap,
  pruneUnused,
};
