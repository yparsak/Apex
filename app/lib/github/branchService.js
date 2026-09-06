// GitHub branch existence-check + creation, used by Phase 2's repo/branch
// resolution flow (app/lib/branches/). Mints a short-lived installation
// token via mintInstallationToken() and never persists it, same guarantee
// as githubAppTokenProvider.js itself.
//
// Owner/repo derivation note: the `repos` table (db/schema.sql) stores only
// a bare `name` column, no GitHub owner field. Callers here always receive
// an already-resolved `owner` string from app/lib/repos/repoAccess.js, which
// treats the parent `orgs.name` (repos -> repo_groups -> orgs) as the GitHub
// owner login. See that file for the reasoning; this module intentionally
// stays GitHub-API-only and doesn't reach into the DB schema itself.
//
// 404 handling: a missing branch is GitHub's normal way of saying "not
// found", not a failure of this service - branchExists() returns `false`
// for it rather than throwing, mirroring roadmap.md's on-demand
// deletion-detection design (a 404 here is what marks a branch `deleted`).

const { mintInstallationToken } = require('./githubAppTokenProvider');
const logger = require('../logger');

const GITHUB_API_BASE = 'https://api.github.com';

async function githubRequest(token, path, options = {}) {
  return fetch(`${GITHUB_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
}

// Mints one installation token scoped to a single repo. Callers that need
// to check/create several branches on the same repo in one request should
// mint once via this and pass the token through, rather than minting per
// branch (see app/lib/branches/branchListService.js).
async function mintRepoToken(repoName) {
  const { token } = await mintInstallationToken({ repositories: [repoName] });
  return token;
}

async function resolveToken(repoName, token) {
  return token || mintRepoToken(repoName);
}

async function branchExists({ owner, repoName, branch, token }) {
  const accessToken = await resolveToken(repoName, token);
  const response = await githubRequest(
    accessToken,
    `/repos/${owner}/${repoName}/branches/${encodeURIComponent(branch)}`
  );

  if (response.status === 404) return false;
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub branch lookup failed (${response.status}): ${detail}`);
  }
  return true;
}

async function createBranchFrom({ owner, repoName, newBranch, fromBranch, token }) {
  const accessToken = await resolveToken(repoName, token);

  const refResponse = await githubRequest(
    accessToken,
    `/repos/${owner}/${repoName}/git/ref/heads/${encodeURIComponent(fromBranch)}`
  );
  if (!refResponse.ok) {
    const detail = await refResponse.text();
    throw new Error(`Failed to resolve "${fromBranch}" SHA (${refResponse.status}): ${detail}`);
  }
  const refData = await refResponse.json();
  const sha = refData.object.sha;

  const createResponse = await githubRequest(accessToken, `/repos/${owner}/${repoName}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${newBranch}`, sha }),
  });
  if (!createResponse.ok) {
    const detail = await createResponse.text();
    throw new Error(`Failed to create branch "${newBranch}" (${createResponse.status}): ${detail}`);
  }

  logger.info('created GitHub branch', { owner, repoName, newBranch, fromBranch });
}

module.exports = { branchExists, createBranchFrom, mintRepoToken };
