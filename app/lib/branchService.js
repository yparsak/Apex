// Branch listing/creation for Phase 4 (see ROADMAP.md). Branch naming:
// dev/{initials}-{co_number}-{n}.
const db = require('./db');
const githubApi = require('./github/githubApi');
const blockedAllowlistAlerts = require('./blockedAllowlistAlerts');

const CO_NUMBER_RE = /^C[0-9]{8}$/;

function isValidCoNumber(coNumber) {
  return CO_NUMBER_RE.test(coNumber);
}

// Scoped to (initials, co_number) only - deliberately NOT repo_id (see
// notes.md / ROADMAP.md Phase 4): a user's first branch on any CO is always
// -1, independent of which repo they're touching or what other users have
// done. The DB unique key is still (repo_id, initials, co_number, increment),
// so this can produce different increments for the same CO across repos.
async function getNextIncrement(initials, coNumber) {
  const [[row]] = await db.query(
    'SELECT COALESCE(MAX(increment), 0) AS maxIncrement FROM branches WHERE initials = ? AND co_number = ?',
    [initials, coNumber]
  );
  return row.maxIncrement + 1;
}

// markDeleted(...) - the single place status='deleted' is ever written (see
// ROADMAP.md Phase 13), so the automatic GitHub-gone detection below and the
// user-initiated delete action (app/routes/repos.js) converge on the exact
// same outcome regardless of which path triggered it.
async function markDeleted(branchId) {
  await db.query("UPDATE branches SET status = 'deleted' WHERE id = ?", [branchId]);
}

// Re-checks each "active" branch against GitHub (on-demand staleness check,
// same bounded-window tradeoff as notes.md accepted risk #5) and flips
// anything actually gone on GitHub to status='deleted', excluding it from the
// returned list. A failed lookup (e.g. no GitHub creds configured) is treated
// as "unknown" and the branch is kept, not deleted - we only ever act on a
// confirmed 404.
async function listActiveBranches(repo, org) {
  const [rows] = await db.query(
    "SELECT * FROM branches WHERE repo_id = ? AND status = 'active' ORDER BY created_at DESC",
    [repo.id]
  );

  const active = [];
  for (const branch of rows) {
    let ghBranch;
    try {
      ghBranch = await githubApi.getBranch(org.name, repo.name, branch.branch_name);
    } catch (err) {
      ghBranch = undefined;
    }
    if (ghBranch === null) {
      await markDeleted(branch.id);
      continue;
    }
    active.push(branch);
  }
  return active;
}

// listStaleBranches(...) - Phase 13's Stale tab on the repo page. Unlike
// listActiveBranches, this never re-checks GitHub - a stale branch isn't
// offered for continued work, so there's nothing time-sensitive to verify
// until the user actually clicks Reactivate (see reactivateBranch below).
async function listStaleBranches(repoId) {
  const [rows] = await db.query(
    "SELECT * FROM branches WHERE repo_id = ? AND status = 'stale' ORDER BY updated_at DESC",
    [repoId]
  );
  return rows;
}

// deactivateBranch(...) - Phase 13's user-initiated Active -> Stale move.
// Scoped to status='active' in the WHERE clause so a concurrent delete (or
// an already-stale branch) makes this a no-op rather than resurrecting it.
async function deactivateBranch(branchId) {
  const [result] = await db.query("UPDATE branches SET status = 'stale' WHERE id = ? AND status = 'active'", [
    branchId,
  ]);
  return result.affectedRows > 0;
}

// reactivateBranch(...) - Phase 13's user-initiated Stale -> Active move.
// Re-checks GitHub existence first, same on-demand check as
// listActiveBranches: a confirmed 404 marks the branch deleted instead of
// reactivating it, so Active never shows an entry that's actually gone. An
// ambiguous/failed lookup is treated as "unknown" and reactivated anyway -
// same "only act on a confirmed 404" rule - the next repo-page load re-runs
// listActiveBranches' own check and will catch it then if it really is gone.
async function reactivateBranch(branch, repo, org) {
  let ghBranch;
  try {
    ghBranch = await githubApi.getBranch(org.name, repo.name, branch.branch_name);
  } catch (err) {
    ghBranch = undefined;
  }
  if (ghBranch === null) {
    await markDeleted(branch.id);
    return { reactivated: false, deletedInstead: true };
  }

  const [result] = await db.query("UPDATE branches SET status = 'active' WHERE id = ? AND status = 'stale'", [
    branch.id,
  ]);
  return { reactivated: result.affectedRows > 0, deletedInstead: false };
}

// deleteBranch(...) - Phase 13's user-initiated soft delete, from either the
// Active or Stale tab. The row is never removed - see markDeleted - so
// sessions/session_requirements/pipeline_runs/audit_log history tied to this
// branch stays intact; it's just unreachable from the UI going forward.
async function deleteBranch(branchId) {
  await markDeleted(branchId);
}

async function createBranch({ repo, org, coNumber, user }) {
  if (!isValidCoNumber(coNumber)) {
    throw new Error('CO number must match format C12345678 (a C followed by 8 digits).');
  }

  await db.query('INSERT IGNORE INTO change_orders (repo_id, co_number) VALUES (?, ?)', [repo.id, coNumber]);

  const increment = await getNextIncrement(user.initials, coNumber);
  const branchName = `dev/${user.initials}-${coNumber}-${increment}`;

  const defaultBranch = await githubApi.getBranch(org.name, repo.name, repo.default_branch_name);
  if (!defaultBranch) {
    throw new Error(
      `Default branch "${repo.default_branch_name}" not found on GitHub for ${org.name}/${repo.name}.`
    );
  }

  try {
    await githubApi.createBranchRef(org.name, repo.name, `refs/heads/${branchName}`, defaultBranch.commit.sha);
  } catch (err) {
    // See ROADMAP.md Phase 10: a 403 here is either an App-permission scope
    // violation or the dev/** ruleset rejecting the ref - record it for the
    // admin dashboard, then still surface the failure to the user as before.
    if (err.httpStatus === 403) {
      await blockedAllowlistAlerts.recordAlert({ repoId: repo.id, httpStatus: 403, detail: err.message });
    }
    throw err;
  }

  try {
    const [result] = await db.query(
      'INSERT INTO branches (repo_id, initials, co_number, increment, branch_name) VALUES (?, ?, ?, ?, ?)',
      [repo.id, user.initials, coNumber, increment, branchName]
    );
    return {
      id: result.insertId,
      repo_id: repo.id,
      initials: user.initials,
      co_number: coNumber,
      increment,
      branch_name: branchName,
      status: 'active',
    };
  } catch (err) {
    // Rare increment race: the GitHub ref now exists but isn't tracked here.
    // No compensation attempted (deleting the ref risks clobbering concurrent
    // work) - surface loudly and let the user retry, consistent with how
    // push conflicts are handled elsewhere in this app.
    if (err.code === 'ER_DUP_ENTRY') {
      throw new Error('Branch name collision - please retry.');
    }
    throw err;
  }
}

module.exports = {
  isValidCoNumber,
  listActiveBranches,
  listStaleBranches,
  createBranch,
  deactivateBranch,
  reactivateBranch,
  deleteBranch,
};
