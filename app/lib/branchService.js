// Branch listing/creation for Phase 4 (see ROADMAP.md). Branch naming:
// dev/{initials}-{co_number}-{n}.
const db = require('./db');
const githubApi = require('./github/githubApi');
const blockedAllowlistAlerts = require('./blockedAllowlistAlerts');

const CO_NUMBER_RE = /^C[0-9]{8}$/;

// The single filter for what Phase 18's discovery will list, and the only
// shape it knows how to parse an increment back out of. Deliberately wider
// than what Apex itself writes:
//   - initials: 2 OR 3 letters, any case. Phase 2's Initials admin is
//     narrower today, but the branch being matched was typed by hand on
//     GitHub and needn't correspond to an Apex user row at all.
//   - CO: an uppercase C and exactly 8 digits, matching CO_NUMBER_RE above so
//     there is one CO spelling everywhere. A hand-made dev/JD-c00000001-1 is
//     simply not recognized.
//   - increment: 1-3 digits. "1", "01" and "001" all parse to 1, but the name
//     on GitHub is always used verbatim - Apex never renames someone else's
//     branch to fit its own convention.
// Anything else (dev/fix-C00000001-urgent, a 4-digit increment,
// feature/C00000001-1 outside dev/) is excluded entirely: not listed, not
// selectable, and contributing nothing to increment computation.
const DEV_BRANCH_RE = /^dev\/([A-Za-z]{2,3})-(C[0-9]{8})-([0-9]{1,3})$/;

const DEV_REF_PREFIX = 'dev/';

function isValidCoNumber(coNumber) {
  return CO_NUMBER_RE.test(coNumber);
}

// parseDevBranchName(name) -> { initials, coNumber, increment } | null.
// initials come back verbatim (casing preserved - it's part of the real ref
// name); increment comes back as an integer with any zero-padding dropped.
function parseDevBranchName(name) {
  const m = DEV_BRANCH_RE.exec(name);
  if (!m) return null;
  return { initials: m[1], coNumber: m[2], increment: parseInt(m[3], 10) };
}

// Scoped to (initials, co_number) only - deliberately NOT repo_id (see
// notes.md / ROADMAP.md Phase 4): a user's first branch on any CO is always
// -1, independent of which repo they're touching or what other users have
// done. The DB unique key is still (repo_id, initials, co_number, increment),
// so this can produce different increments for the same CO across repos.
//
// UPPER() on both sides because Phase 18 made `initials` case-sensitive at
// the DB level (utf8mb4_bin): a user whose row says JD must still see a
// hand-made `jd` branch's increment as taken. Storage stays verbatim; only
// the comparison normalizes.
//
// takenIncrements is Phase 18's second source - the increments already in use
// by matching refs discovered on GitHub, which may include branches Apex has
// no row for. Passing them in is what stops a hand-made -1 from making Apex
// compute a second -1 that then fails at createBranchRef.
async function getNextIncrement(initials, coNumber, takenIncrements = []) {
  const [[row]] = await db.query(
    'SELECT COALESCE(MAX(increment), 0) AS maxIncrement FROM branches WHERE UPPER(initials) = UPPER(?) AND co_number = ?',
    [initials, coNumber]
  );
  return Math.max(row.maxIncrement, 0, ...takenIncrements) + 1;
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

// discoverCoBranches(...) - Phase 18. Lists every branch *on GitHub* whose
// name matches DEV_BRANCH_RE for exactly this CO, joined against whatever
// Apex already tracks, so the repo page can offer adoption instead of blindly
// creating a ref that may already exist.
//
// Deliberately scoped to the entered CO only - branches for other COs on the
// same repo are never shown, regardless of who created them - but *not*
// scoped to the requesting user: seeing what already exists for this CO
// across all engineers is the entire point. (The counterpart asymmetry lives
// in takenIncrementsFor below.)
//
// Rows whose ref is gone from GitHub are absent from the result by
// construction: the GitHub refs are what's being enumerated. The repo page's
// own listActiveBranches handles flipping those to deleted.
async function discoverCoBranches({ repo, org, coNumber }) {
  if (!isValidCoNumber(coNumber)) {
    throw new Error('CO number must match format C12345678 (a C followed by 8 digits).');
  }

  const [refNames, [rows]] = await Promise.all([
    githubApi.listMatchingBranches(org.name, repo.name, DEV_REF_PREFIX),
    db.query('SELECT * FROM branches WHERE repo_id = ? AND co_number = ?', [repo.id, coNumber]),
  ]);

  const matching = [];
  for (const branchName of refNames) {
    const parsed = parseDevBranchName(branchName);
    if (parsed && parsed.coNumber === coNumber) matching.push({ branchName, ...parsed });
  }
  // Increment first, then raw code-unit order on the name (not localeCompare,
  // which would order case-variants by the server's locale) so two refs
  // differing only in case always list in the same order.
  matching.sort((a, b) => a.increment - b.increment || (a.branchName < b.branchName ? -1 : a.branchName > b.branchName ? 1 : 0));

  const refNameSet = new Set(matching.map((m) => m.branchName));
  // Exact, case-sensitive name match on purpose: dev/jd-... and dev/JD-...
  // are different refs, and after Phase 18's utf8mb4_bin change they can be
  // different rows too. Matching in JS rather than SQL keeps that comparison
  // out of reach of any column/connection collation surprise.
  const rowByName = new Map(rows.map((r) => [r.branch_name, r]));

  const entries = matching.map((m) => {
    const row = rowByName.get(m.branchName) || null;
    if (row) {
      return {
        ...m,
        row,
        state: row.status,
        // Phase 13's soft delete is a one-way door with no undelete path, so
        // a ref Apex has deleted is shown (it genuinely exists on GitHub -
        // hiding it would recreate the same confusion this phase removes) but
        // offers no action and still occupies its increment.
        adoptable: false,
        blockedReason:
          row.status === 'deleted'
            ? 'Deleted in Apex. Deletion is one-way; use a new increment instead.'
            : row.status === 'stale'
              ? 'Stale in Apex. Reactivate it from the Branches list on the repo page first.'
              : null,
      };
    }
    return { ...m, row: null, state: 'untracked', ...adoptability(m, rows, refNameSet) };
  });

  return { coNumber, entries };
}

// Decides whether an untracked GitHub ref can be adopted, enforcing "never
// two live branches for what is effectively one logical slot"
// (repo + CO + case-insensitive initials + increment).
//
// Git refs are case-sensitive but Apex only ever writes one casing - its
// user's own `initials` - so a case-variant of a branch Apex already tracks
// was necessarily created by hand. Adopting it is refused rather than
// silently producing a second Apex branch differing from the first only by
// case.
//
// The exception needs *both* halves: the original's Apex row must be deleted
// AND its ref must actually be gone from GitHub. Phase 13's delete is soft
// and never touches GitHub, so status='deleted' alone doesn't mean the ref
// vanished - and Apex shouldn't start tracking a ref whose live case-twin it
// deliberately abandoned. The GitHub half costs nothing: discovery has
// already listed every matching ref by the time this runs.
//
// Refusal is never a dead end - creating a new branch at the next available
// increment stays available on this CO no matter which variant exists. The
// rule is about not double-booking a slot, not about reserving a casing
// forever, which would permanently poison that CO/increment after a perfectly
// legitimate delete-then-recreate-by-hand.
function adoptability(ref, rows, refNameSet) {
  const slotRows = rows.filter(
    (r) => r.increment === ref.increment && r.initials.toUpperCase() === ref.initials.toUpperCase()
  );

  const live = slotRows.find((r) => r.status !== 'deleted');
  if (live) {
    return {
      adoptable: false,
      blockedReason: `Apex already tracks "${live.branch_name}" for this increment; adopting a case-variant would double-book it.`,
    };
  }

  const survivingTwin = slotRows.find((r) => refNameSet.has(r.branch_name));
  if (survivingTwin) {
    return {
      adoptable: false,
      blockedReason: `"${survivingTwin.branch_name}" was deleted in Apex but still exists on GitHub; its case-variant can't be adopted while it does.`,
    };
  }

  return { adoptable: true, blockedReason: null };
}

// The asymmetry Phase 18 is explicit about: the *displayed* list is CO-scoped
// across all users, but the increment for a new branch stays scoped to the
// requesting user's own initials - so adopting (or merely seeing) someone
// else's -3 doesn't push your own first branch on this CO past -1.
function takenIncrementsFor(discovery, initials) {
  const want = initials.toUpperCase();
  return discovery.entries.filter((e) => e.initials.toUpperCase() === want).map((e) => e.increment);
}

// adoptBranch(...) - Phase 18. Starts tracking a branch that exists on GitHub
// but has no Apex row, parsing initials/increment back out of the ref name so
// the user continues into a session on it exactly as if Apex had created it.
// The name is stored verbatim, padding and casing included.
//
// Re-runs discovery rather than trusting the submitted name: the rendered
// page is a snapshot, and between render and submit the ref could be gone or
// its slot could have been taken.
// Note there's no `user` here on purpose: the adopted row's initials come
// from the ref name, not from whoever clicked Adopt. The branch belongs to
// the engineer whose initials are in it, which is also what keeps Phase 4's
// per-user increment scoping honest.
async function adoptBranch({ repo, org, coNumber, branchName }) {
  const discovery = await discoverCoBranches({ repo, org, coNumber });
  const entry = discovery.entries.find((e) => e.branchName === branchName);
  if (!entry) {
    throw new Error(`"${branchName}" no longer exists on GitHub for ${coNumber}.`);
  }
  if (entry.row) {
    if (entry.row.status === 'active') return entry.row;
    throw new Error(entry.blockedReason);
  }
  if (!entry.adoptable) {
    throw new Error(entry.blockedReason);
  }

  await db.query('INSERT IGNORE INTO change_orders (repo_id, co_number) VALUES (?, ?)', [repo.id, coNumber]);

  try {
    const [result] = await db.query(
      'INSERT INTO branches (repo_id, initials, co_number, increment, branch_name) VALUES (?, ?, ?, ?, ?)',
      [repo.id, entry.initials, coNumber, entry.increment, branchName]
    );
    return {
      id: result.insertId,
      repo_id: repo.id,
      initials: entry.initials,
      co_number: coNumber,
      increment: entry.increment,
      branch_name: branchName,
      status: 'active',
    };
  } catch (err) {
    // Lost the race against a concurrent adopt/create of the same slot. No
    // compensation - the GitHub ref was never ours to begin with here.
    if (err.code === 'ER_DUP_ENTRY') {
      throw new Error(`"${branchName}" was just adopted by someone else - reload and continue it instead.`);
    }
    throw err;
  }
}

async function createBranch({ repo, org, coNumber, user, takenIncrements = [] }) {
  if (!isValidCoNumber(coNumber)) {
    throw new Error('CO number must match format C12345678 (a C followed by 8 digits).');
  }

  await db.query('INSERT IGNORE INTO change_orders (repo_id, co_number) VALUES (?, ?)', [repo.id, coNumber]);

  const increment = await getNextIncrement(user.initials, coNumber, takenIncrements);
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
  parseDevBranchName,
  getNextIncrement,
  discoverCoBranches,
  takenIncrementsFor,
  adoptBranch,
  listActiveBranches,
  listStaleBranches,
  createBranch,
  deactivateBranch,
  reactivateBranch,
  deleteBranch,
};
