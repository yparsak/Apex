// GitHub Git Data API wrapper for Phase 4's push step - creates blobs, a
// tree, and a commit for the pipeline's file changes, then updates the
// branch ref. Reuses githubRequest/mintPushToken rather than re-implementing
// the GitHub fetch wrapper or minting logic, same scope discipline
// diffService.js keeps against branchService.js.
//
// This is "push" for Phase 4's purposes deliberately without ever shelling
// out to a `git` binary - see agent-prompts.md's Phase 4 section for why the
// whole pipeline stays GitHub-REST-API-only, same as branchService.js and
// diffService.js already are.
//
// Fetch-and-retry, never force-push: immediately before building the
// commit, this reads the branch's current head SHA fresh. If the ref update
// fails because it's no longer a fast-forward (someone pushed directly to
// the branch in the meantime - an explicitly anticipated case per
// roadmap.md), it re-fetches the current head and rebuilds the tree/commit
// against it, up to MAX_PUSH_RETRIES times, then fails loudly. `force` is
// never set to true anywhere in this module.

const { githubRequest, mintPushToken } = require('./branchService');
const logger = require('../logger');

const MAX_PUSH_RETRIES = 3;

async function getBranchHeadSha({ owner, repoName, branch, token }) {
  const response = await githubRequest(token, `/repos/${owner}/${repoName}/git/ref/heads/${encodeURIComponent(branch)}`);
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Failed to resolve "${branch}" head SHA (${response.status}): ${detail}`);
  }
  const data = await response.json();
  return data.object.sha;
}

async function getCommitTreeSha({ owner, repoName, commitSha, token }) {
  const response = await githubRequest(token, `/repos/${owner}/${repoName}/git/commits/${commitSha}`);
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Failed to load commit "${commitSha}" (${response.status}): ${detail}`);
  }
  const data = await response.json();
  return data.tree.sha;
}

async function createBlob({ owner, repoName, content, token }) {
  const response = await githubRequest(token, `/repos/${owner}/${repoName}/git/blobs`, {
    method: 'POST',
    // base64, not utf-8, so blob creation is byte-safe regardless of what
    // the model's generated file content contains (line endings, unicode).
    body: JSON.stringify({ content: Buffer.from(content, 'utf-8').toString('base64'), encoding: 'base64' }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Failed to create blob (${response.status}): ${detail}`);
  }
  const data = await response.json();
  return data.sha;
}

// Builds a new tree from a base tree plus the pipeline's file changes. A
// `delete` entry sets `sha: null`, which the Git Data API treats as "remove
// this path from the tree" when a base_tree is given.
async function createTree({ owner, repoName, baseTreeSha, changes, token }) {
  const treeEntries = [];
  for (const change of changes) {
    if (change.action === 'delete') {
      treeEntries.push({ path: change.path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    const blobSha = await createBlob({ owner, repoName, content: change.content, token });
    treeEntries.push({ path: change.path, mode: '100644', type: 'blob', sha: blobSha });
  }

  const response = await githubRequest(token, `/repos/${owner}/${repoName}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Failed to create tree (${response.status}): ${detail}`);
  }
  const data = await response.json();
  return data.sha;
}

async function createCommit({ owner, repoName, message, treeSha, parentSha, token }) {
  const response = await githubRequest(token, `/repos/${owner}/${repoName}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: treeSha, parents: [parentSha] }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Failed to create commit (${response.status}): ${detail}`);
  }
  const data = await response.json();
  return data.sha;
}

// `force: false` is written explicitly, not merely omitted/defaulted, so the
// never-force-push rule reads as a literal decision in this code, not an
// accident of GitHub's default.
async function updateRef({ owner, repoName, branch, commitSha, token }) {
  return githubRequest(token, `/repos/${owner}/${repoName}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commitSha, force: false }),
  });
}

async function commitAndPushChanges({ owner, repoName, branch, changes, commitMessage }) {
  const token = await mintPushToken(repoName);

  for (let attempt = 1; attempt <= MAX_PUSH_RETRIES; attempt++) {
    const headSha = await getBranchHeadSha({ owner, repoName, branch, token });
    const baseTreeSha = await getCommitTreeSha({ owner, repoName, commitSha: headSha, token });
    const newTreeSha = await createTree({ owner, repoName, baseTreeSha, changes, token });
    const commitSha = await createCommit({ owner, repoName, message: commitMessage, treeSha: newTreeSha, parentSha: headSha, token });

    const refResponse = await updateRef({ owner, repoName, branch, commitSha, token });
    if (refResponse.ok) {
      logger.info('pushed pipeline commit', { owner, repoName, branch, commitSha, attempt });
      return commitSha;
    }

    const detail = await refResponse.text();
    // GitHub returns 422 (or occasionally 409) for a non-fast-forward ref
    // update - anything else is a real failure, not a race to retry through.
    const isNonFastForward = refResponse.status === 422 || refResponse.status === 409;
    if (!isNonFastForward || attempt === MAX_PUSH_RETRIES) {
      throw new Error(`Failed to update ref "${branch}" after ${attempt} attempt(s) (${refResponse.status}): ${detail}`);
    }
    logger.warn('non-fast-forward push, re-fetching head and retrying', { owner, repoName, branch, attempt, detail });
  }

  // Unreachable - the loop above always returns or throws - but keeps the
  // function's control flow explicit rather than relying on falling off the
  // end of a for loop.
  throw new Error(`Failed to update ref "${branch}" - exhausted retries`);
}

module.exports = { commitAndPushChanges };
