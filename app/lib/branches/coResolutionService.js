// Resolves a submitted CO number against a repo: either attaches to an
// existing active branch for that CO (any user's - roadmap.md is explicit
// that ownership is not the gate at selection time, only at creation), or
// creates the next available `dev/{initials}-{CO}-{n}` branch under the
// submitting user's own initials. Acquires the pipeline lock for
// (repo_id, co_number) either way, since both paths kick off a pipeline run
// (clone -> sandbox build/test -> push) that must be serialized per CO - see
// app/lib/locks/pipelineLock.js.

const db = require('../db');
const logger = require('../logger');
const { acquireLock, releaseLock } = require('../locks/pipelineLock');
const { createBranchFrom, mintRepoToken } = require('../github/branchService');

async function ensureChangeOrder({ repoId, coNumber }) {
  await db.query('INSERT IGNORE INTO change_orders (repo_id, co_number) VALUES (?, ?)', [repoId, coNumber]);
  const rows = await db.query(
    'SELECT id, repo_id AS repoId, co_number AS coNumber, status FROM change_orders WHERE repo_id = ? AND co_number = ?',
    [repoId, coNumber]
  );
  return rows[0];
}

async function continueExistingBranch({ repo, coNumber, branchId }) {
  const rows = await db.query(
    `SELECT id, initials, co_number AS coNumber, increment, branch_name AS branchName,
            created_by_user_id AS createdByUserId, status
     FROM branches
     WHERE id = ? AND repo_id = ? AND co_number = ? AND status = 'active'`,
    [branchId, repo.id, coNumber]
  );
  if (rows.length === 0) {
    const err = new Error('Active branch not found for this CO on this repo');
    err.code = 'BRANCH_NOT_FOUND';
    throw err;
  }
  return rows[0];
}

async function createNextBranch({ repo, user, coNumber }) {
  const rows = await db.query(
    'SELECT MAX(increment) AS maxIncrement FROM branches WHERE repo_id = ? AND initials = ? AND co_number = ?',
    [repo.id, user.initials, coNumber]
  );
  // MAX is taken over ALL rows for this (repo, initials, CO), not just
  // active ones, so a deleted branch's number is never reused and branch
  // history stays unambiguous.
  const nextIncrement = (rows[0].maxIncrement || 0) + 1;
  const branchName = `dev/${user.initials}-${coNumber}-${nextIncrement}`;

  const token = await mintRepoToken(repo.name);
  await createBranchFrom({
    owner: repo.githubOwner,
    repoName: repo.name,
    newBranch: branchName,
    fromBranch: repo.defaultBranchName,
    token,
  });

  const result = await db.query(
    `INSERT INTO branches (repo_id, created_by_user_id, initials, co_number, increment, branch_name, status, last_checked_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', NOW())`,
    [repo.id, user.id, user.initials, coNumber, nextIncrement, branchName]
  );

  return {
    id: result.insertId,
    initials: user.initials,
    coNumber,
    increment: nextIncrement,
    branchName,
    createdByUserId: user.id,
    status: 'active',
  };
}

async function resolveChangeOrder({ repo, user, coNumber, action, branchId }) {
  await acquireLock({ repoId: repo.id, coNumber, userId: user.id });

  try {
    const changeOrder = await ensureChangeOrder({ repoId: repo.id, coNumber });

    const branch =
      action === 'continue'
        ? await continueExistingBranch({ repo, coNumber, branchId })
        : await createNextBranch({ repo, user, coNumber });

    // Lock intentionally stays held past this point. Phase 2 only resolves
    // *which* branch a pipeline run will target - the pipeline itself
    // (clone -> sandbox build/test -> push) doesn't exist yet (Phases 3-5),
    // so there's nothing to release the lock for on success yet. Releasing
    // it once the full pipeline actually completes is Phase 5's job.
    return { changeOrder, branch };
  } catch (err) {
    await releaseLock({ repoId: repo.id, coNumber });
    logger.warn('CO resolution failed, pipeline lock released', {
      repoId: repo.id,
      coNumber,
      error: err.message,
    });
    throw err;
  }
}

module.exports = { resolveChangeOrder };
