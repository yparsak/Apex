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

module.exports = { getRepo, listCollaborators, getBranch, createBranchRef };
