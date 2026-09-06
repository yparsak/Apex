// GitHub compare-API wrapper for Phase 3's clarification loop - fetches the
// diff between a DEV branch and the repo's default branch so the agent can
// summarize current branch state before taking new instructions (see
// roadmap.md's Phase 3 "agent summarizes current diff..." bullet).
//
// Reuses mintRepoToken/githubRequest from branchService.js rather than
// re-minting a token or re-implementing the GitHub fetch wrapper - this
// module stays GitHub-API-only, same scope discipline as branchService.js
// (no DB access here; callers pass in already-resolved owner/repo/branch
// names, same as branchService.js's callers do).
//
// Truncation: a full diff patch can be arbitrarily large (generated files,
// vendored code, large refactors) and this text goes straight into an LLM
// prompt, which has a finite context window and a real cost/latency budget.
// MAX_FILES caps how many changed files are considered at all;
// MAX_PATCH_CHARS_PER_FILE and MAX_TOTAL_PATCH_CHARS cap patch text size
// per-file and in aggregate. Truncation is logged (not silently swallowed)
// so a misleadingly-partial summary can be traced back to it later.

const { mintRepoToken, githubRequest } = require('./branchService');
const logger = require('../logger');

const MAX_FILES = 30;
const MAX_PATCH_CHARS_PER_FILE = 2000;
const MAX_TOTAL_PATCH_CHARS = 20000;

async function getBranchDiffSummary({ owner, repoName, base, head, token }) {
  const accessToken = token || (await mintRepoToken(repoName));

  const response = await githubRequest(
    accessToken,
    `/repos/${owner}/${repoName}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub compare failed (${response.status}): ${detail}`);
  }
  const data = await response.json();

  const allFiles = data.files || [];
  const truncatedFileCount = allFiles.length > MAX_FILES;
  const consideredFiles = truncatedFileCount ? allFiles.slice(0, MAX_FILES) : allFiles;

  let totalPatchChars = 0;
  let truncatedPatch = false;
  const files = consideredFiles.map((file) => {
    let patch = file.patch || '';

    if (patch.length > MAX_PATCH_CHARS_PER_FILE) {
      patch = `${patch.slice(0, MAX_PATCH_CHARS_PER_FILE)}\n... (patch truncated)`;
      truncatedPatch = true;
    }

    const remainingBudget = MAX_TOTAL_PATCH_CHARS - totalPatchChars;
    if (patch.length > remainingBudget) {
      patch = remainingBudget > 0 ? `${patch.slice(0, remainingBudget)}\n... (patch truncated)` : '(patch omitted - total diff budget exceeded)';
      truncatedPatch = true;
    }
    totalPatchChars += patch.length;

    return { filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, patch };
  });

  if (truncatedFileCount || truncatedPatch) {
    logger.info('branch diff truncated for prompt context', {
      owner,
      repoName,
      base,
      head,
      totalFiles: allFiles.length,
      consideredFiles: consideredFiles.length,
      truncatedFileCount,
      truncatedPatch,
    });
  }

  return {
    aheadBy: data.ahead_by,
    behindBy: data.behind_by,
    totalCommits: data.total_commits,
    totalFiles: allFiles.length,
    truncatedFileCount,
    truncatedPatch,
    files,
  };
}

module.exports = { getBranchDiffSummary };
