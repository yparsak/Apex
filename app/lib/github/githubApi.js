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

async function createBranchRef(owner, repo, ref, sha) {
  const res = await githubRequest('POST', `/repos/${owner}/${repo}/git/refs`, { ref, sha });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub createBranchRef ${owner}/${repo} ${ref} failed: HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
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
async function getFileContent(owner, repo, path, ref) {
  const res = await githubRequest(
    'GET',
    `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub getFileContent ${owner}/${repo}/${path}@${ref} failed: HTTP ${res.status}`);
  const data = await res.json();
  if (Array.isArray(data) || data.type !== 'file') return null; // path is a directory, not a file
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
  createBranchRef,
  getTree,
  getFileContent,
  compareCommits,
};
