// Thin REST wrapper over the GitHub API, authenticated via the installation
// token from githubAppAuth.js (see notes.md / ROADMAP.md Phase 4).
const { getInstallationToken } = require('./githubAppAuth');

const API_BASE = 'https://api.github.com';

async function githubRequest(method, path, body) {
  const token = await getInstallationToken();
  return fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function getRepo(owner, repo) {
  const res = await githubRequest('GET', `/repos/${owner}/${repo}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub getRepo ${owner}/${repo} failed: HTTP ${res.status}`);
  return res.json();
}

// This App is contents:write-only (no members/administration scope) - the
// collaborators endpoint plausibly 403s. Callers must treat a thrown error as
// "unknown", not as "no collaborators".
async function listCollaborators(owner, repo) {
  const res = await githubRequest('GET', `/repos/${owner}/${repo}/collaborators`);
  if (!res.ok) throw new Error(`GitHub listCollaborators ${owner}/${repo} failed: HTTP ${res.status}`);
  return res.json();
}

async function getBranch(owner, repo, branch) {
  const res = await githubRequest('GET', `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub getBranch ${owner}/${repo}@${branch} failed: HTTP ${res.status}`);
  return res.json();
}

// The only write call in this module - httpStatus is attached to a thrown
// error so callers can distinguish a 403 (see ROADMAP.md Phase 10's
// blocked_allowlist_alerts) from any other failure without re-parsing the
// message text.
async function createBranchRef(owner, repo, ref, sha) {
  const res = await githubRequest('POST', `/repos/${owner}/${repo}/git/refs`, { ref, sha });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`GitHub createBranchRef ${owner}/${repo} ${ref} failed: HTTP ${res.status}: ${body.slice(0, 300)}`);
    err.httpStatus = res.status;
    throw err;
  }
  return res.json();
}

// listMatchingBranches(owner, repo, prefix) -> array of branch names (the
// refs/heads/ prefix stripped) whose name starts with `prefix`. Phase 18's
// existing-branch discovery: GitHub is the source of truth for what refs
// exist, so this is called live per request and never cached - a stale copy
// would reintroduce exactly the "Apex doesn't know about a hand-made branch"
// failure the phase exists to fix.
//
// An empty repo (no refs at all) answers 409, and a prefix matching nothing
// answers 200 with []; both mean "no matching branches" here.
async function listMatchingBranches(owner, repo, prefix) {
  const names = [];
  for (let page = 1; ; page += 1) {
    const res = await githubRequest(
      'GET',
      `/repos/${owner}/${repo}/git/matching-refs/heads/${prefix.split('/').map(encodeURIComponent).join('/')}?per_page=100&page=${page}`
    );
    if (res.status === 409) return names;
    if (!res.ok) {
      throw new Error(`GitHub listMatchingBranches ${owner}/${repo} ${prefix} failed: HTTP ${res.status}`);
    }
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return names;
    for (const entry of data) {
      if (typeof entry.ref === 'string' && entry.ref.startsWith('refs/heads/')) {
        names.push(entry.ref.slice('refs/heads/'.length));
      }
    }
    if (data.length < 100) return names;
  }
}

// getTree(owner, repo, ref) -> array of blob paths, recursive. Used for
// Phase 5's up-front context retrieval (see notes.md / ROADMAP.md Phase 5) -
// paths only, never bulk file contents, so it scales to large repos.
async function getTree(owner, repo, ref) {
  const branch = await getBranch(owner, repo, ref);
  if (!branch) return [];
  const res = await githubRequest('GET', `/repos/${owner}/${repo}/git/trees/${branch.commit.sha}?recursive=1`);
  if (!res.ok) throw new Error(`GitHub getTree ${owner}/${repo}@${ref} failed: HTTP ${res.status}`);
  const data = await res.json();
  return (data.tree || []).filter((entry) => entry.type === 'blob').map((entry) => entry.path);
}

// getFileContent(owner, repo, path, ref) -> decoded file text, or null if the
// path doesn't exist at ref. Fetched on demand, one path at a time, per the
// LLM's own FETCH_FILE requests (see clarificationService.js).
//
// A file over 1 MB is NOT returned as null (see ROADMAP.md Phase 19): the
// contents API answers with the same `type: 'file'` shape but an empty
// `content` and `encoding: 'none'`, and mapping that to null told the model the
// file "was not found" - so it would cheerfully offer to create a large
// existing file from scratch. It throws with code 'file_too_large' instead, so
// the real reason reaches the model and the write is refused rather than
// applied. Genuinely absent (404) is still null; the two are now distinct.
async function getFileContent(owner, repo, path, ref) {
  const res = await githubRequest(
    'GET',
    `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub getFileContent ${owner}/${repo}/${path}@${ref} failed: HTTP ${res.status}`);
  const data = await res.json();
  if (Array.isArray(data) || data.type !== 'file') return null; // path is a directory, not a file
  if (data.encoding === 'none' || (!data.content && data.size > 0)) {
    const err = new Error(
      `GitHub getFileContent ${owner}/${repo}/${path}@${ref}: file is ${data.size} bytes, over the contents API's 1 MB body limit - contents not returned.`
    );
    err.code = 'file_too_large';
    err.fileBytes = data.size || null;
    throw err;
  }
  return Buffer.from(data.content, data.encoding || 'base64').toString('utf8');
}

// compareCommits(owner, repo, base, head) -> { files: [{ filename, patch }] }.
// Used by overlapService.js to see what's already landed on the DEV branch
// vs. the repo's default branch.
async function compareCommits(owner, repo, base, head) {
  const res = await githubRequest(
    'GET',
    `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
  );
  if (!res.ok) throw new Error(`GitHub compareCommits ${owner}/${repo} ${base}...${head} failed: HTTP ${res.status}`);
  const data = await res.json();
  return { files: (data.files || []).map((f) => ({ filename: f.filename, patch: f.patch || null })) };
}

module.exports = {
  getRepo,
  listCollaborators,
  getBranch,
  listMatchingBranches,
  createBranchRef,
  getTree,
  getFileContent,
  compareCommits,
};
