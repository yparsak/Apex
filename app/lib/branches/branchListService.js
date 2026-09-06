// Builds the active-branch list for a repo. Two responsibilities, both from
// roadmap.md's Phase 2 scope:
//
// 1. On-demand deletion check: before returning the list, verify each
//    currently-`active` candidate branch still exists on GitHub. Anything
//    missing is marked `deleted` in the DB immediately and excluded - this
//    is the first of the two on-demand checkpoints (the second is session
//    start, Phase 4).
// 2. Session-status join: attach the *current user's own* latest session
//    status on each surviving branch, since that's the only way a user
//    learns a background job finished after stepping away (no separate
//    notification channel).

const db = require('../db');
const logger = require('../logger');
const { branchExists, mintRepoToken } = require('../github/branchService');

async function refreshActiveBranches({ repo, userId, coNumber }) {
  const params = [repo.id];
  let coFilter = '';
  if (coNumber) {
    coFilter = ' AND co_number = ?';
    params.push(coNumber);
  }

  const candidates = await db.query(
    `SELECT id, initials, co_number AS coNumber, increment, branch_name AS branchName,
            created_by_user_id AS createdByUserId, status, created_at AS createdAt
     FROM branches
     WHERE repo_id = ? AND status = 'active'${coFilter}
     ORDER BY co_number, initials, increment`,
    params
  );

  if (candidates.length === 0) return [];

  // One installation token covers every per-branch existence check below,
  // instead of minting a fresh one per branch in the loop.
  const token = await mintRepoToken(repo.name);

  const stillActive = [];
  for (const branch of candidates) {
    const exists = await branchExists({
      owner: repo.githubOwner,
      repoName: repo.name,
      branch: branch.branchName,
      token,
    });

    if (!exists) {
      await db.query("UPDATE branches SET status = 'deleted', last_checked_at = NOW() WHERE id = ?", [branch.id]);
      logger.info('branch missing on GitHub, marked deleted', {
        repoId: repo.id,
        branchId: branch.id,
        branchName: branch.branchName,
      });
      continue;
    }

    await db.query('UPDATE branches SET last_checked_at = NOW() WHERE id = ?', [branch.id]);
    stillActive.push(branch);
  }

  if (stillActive.length === 0) return [];

  const branchIds = stillActive.map((b) => b.id);
  const placeholders = branchIds.map(() => '?').join(', ');
  const sessionRows = await db.query(
    `SELECT branch_id AS branchId, status, completed_at AS completedAt, created_at AS createdAt
     FROM sessions
     WHERE user_id = ? AND branch_id IN (${placeholders})
     ORDER BY created_at DESC`,
    [userId, ...branchIds]
  );

  // sessionRows is ordered newest-first, so the first row seen per branch
  // is that branch's latest session for this user.
  const latestSessionByBranch = new Map();
  for (const row of sessionRows) {
    if (!latestSessionByBranch.has(row.branchId)) {
      latestSessionByBranch.set(row.branchId, row);
    }
  }

  return stillActive.map((branch) => {
    const mySession = latestSessionByBranch.get(branch.id) || null;
    return {
      ...branch,
      isMine: branch.createdByUserId === userId,
      mySessionStatus: mySession ? mySession.status : null,
      mySessionCompletedAt: mySession ? mySession.completedAt : null,
    };
  });
}

module.exports = { refreshActiveBranches };
