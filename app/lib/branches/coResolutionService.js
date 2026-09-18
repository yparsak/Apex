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
const { acquireLock, releaseLock, isLockHeldByUser, LockHeldError } = require('../locks/pipelineLock');
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
  // Track whether *this call* acquired a fresh lock, as opposed to finding
  // one this same user already held from an earlier resolve in the same
  // in-flight run (see below) - only a freshly-acquired lock should be
  // released if something fails past this point. Releasing a lock we merely
  // found already held would incorrectly free up a CO that's still
  // legitimately serializing this user's own earlier, still-in-flight work.
  let acquiredNewLock = false;
  try {
    await acquireLock({ repoId: repo.id, coNumber, userId: user.id });
    acquiredNewLock = true;
  } catch (err) {
    if (!(err instanceof LockHeldError)) throw err;

    // Re-selecting a branch you already resolved onto (e.g. the branch
    // list still shows "Continue" for a branch you just created, since no
    // `sessions` row exists yet - see app/lib/branches/branchListService.js)
    // must not 409 against your own still-held lock. If someone else holds
    // it, this is a real conflict and still fails.
    const alreadyMine = await isLockHeldByUser({ repoId: repo.id, coNumber, userId: user.id });
    if (!alreadyMine) throw err;
    logger.info('resolve reused a lock this user already held', { repoId: repo.id, coNumber, userId: user.id });
  }

  try {
    const changeOrder = await ensureChangeOrder({ repoId: repo.id, coNumber });

    const branch =
      action === 'continue'
        ? await continueExistingBranch({ repo, coNumber, branchId })
        : await createNextBranch({ repo, user, coNumber });

    // Lock intentionally stays held past this point. Phase 2 only resolves
    // *which* branch a pipeline run will target - the pipeline itself
    // (clone -> sandbox build/test -> push -> delivery) runs later, across
    // Phases 3-5, so there's nothing to release the lock for on success yet
    // here. Releasing it once the full pipeline actually completes,
    // including Phase 5's delivery steps, is
    // app/lib/pipeline/pipelineService.js's job (see its runPipelineForSession).
    return { changeOrder, branch };
  } catch (err) {
    if (acquiredNewLock) {
      await releaseLock({ repoId: repo.id, coNumber });
      logger.warn('CO resolution failed, pipeline lock released', {
        repoId: repo.id,
        coNumber,
        error: err.message,
      });
    }
    throw err;
  }
}

module.exports = { resolveChangeOrder };
