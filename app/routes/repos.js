const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const db = require('../lib/db');
const { getAccessibleRepo } = require('../lib/repoAccess');
const branchService = require('../lib/branchService');
const sessionService = require('../lib/sessionService');
const lockService = require('../lib/lockService');
const clarificationService = require('../lib/clarificationService');
const auditLog = require('../lib/auditLog');
const pipelineRunner = require('../lib/pipeline/pipelineRunner');
const pipelineStepper = require('../lib/pipelineStepper');
const documentsService = require('../lib/documents/documentsService');

const router = express.Router();
router.use(requireAuth);

async function loadAccess(req, res) {
  const access = await getAccessibleRepo(req.params.repoId, req.session.user.id);
  if (!access) {
    res.status(404).send('Repo not found.');
    return null;
  }
  if (access.forbidden) {
    res.status(403).send('Forbidden: no access to this repo group.');
    return null;
  }
  return access;
}

// Loads the branch + this user's most recent session on it, or writes a
// response (404 / redirect) and returns null. Shared by every route below the
// branch-detail page, since they all operate on that same (branch, session)
// pair.
async function loadBranchSession(req, res, access) {
  const [[branch]] = await db.query('SELECT * FROM branches WHERE id = ? AND repo_id = ?', [
    req.params.branchId,
    access.repo.id,
  ]);
  if (!branch) {
    res.status(404).send('Branch not found.');
    return null;
  }

  const [[session]] = await db.query(
    'SELECT * FROM sessions WHERE branch_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1',
    [branch.id, req.session.user.id]
  );
  if (!session) {
    res.redirect(`/repos/${access.repo.id}`);
    return null;
  }

  return { branch, session };
}

async function renderRepoPage(req, res, access, error) {
  const tab = req.query.tab === 'stale' ? 'stale' : 'active';
  const [branches, staleBranches] = await Promise.all([
    branchService.listActiveBranches(access.repo, access.org),
    branchService.listStaleBranches(access.repo.id),
  ]);
  res.render('repo', {
    user: req.session.user,
    repo: access.repo,
    org: access.org,
    repoGroup: access.repoGroup,
    branches,
    staleBranches,
    tab,
    error,
  });
}

// Loads a branch by id (scoped to this repo) for the repo-page management
// actions below (deactivate/reactivate/delete) - unlike loadBranchSession,
// these aren't tied to the requesting user's own session, since any user
// with repo access can manage the branch list (same access level createBranch
// already requires).
async function loadBranch(req, res, access) {
  const [[branch]] = await db.query('SELECT * FROM branches WHERE id = ? AND repo_id = ?', [
    req.params.branchId,
    access.repo.id,
  ]);
  if (!branch) {
    res.status(404).send('Branch not found.');
    return null;
  }
  return branch;
}

router.get('/:repoId', async (req, res) => {
  const access = await loadAccess(req, res);
  if (!access) return;
  await renderRepoPage(req, res, access, null);
});

// Per-repo Documents view (see ROADMAP.md Phase 8) - the global, CO-scoped
// cross-repo search lives at GET /documents instead (app/routes/documents.js).
router.get('/:repoId/documents', async (req, res) => {
  const access = await loadAccess(req, res);
  if (!access) return;

  const [branches, reqLogResult, specDocResult] = await Promise.all([
    branchService.listActiveBranches(access.repo, access.org),
    db.query(
      "SELECT content, updated_at FROM repo_documents WHERE repo_id = ? AND doc_type = 'requirements_log' AND co_number = ''",
      [access.repo.id]
    ),
    db.query(
      "SELECT content, updated_at FROM repo_documents WHERE repo_id = ? AND doc_type = 'spec_communication_protocol' AND co_number = ''",
      [access.repo.id]
    ),
  ]);

  res.render('repo-documents', {
    user: req.session.user,
    repo: access.repo,
    org: access.org,
    repoGroup: access.repoGroup,
    branches,
    requirementsLog: reqLogResult[0][0] || null,
    specDoc: specDocResult[0][0] || null,
  });
});

// Phase 18: entering a CO on the repo page no longer creates a branch. It
// validates the CO and hands off to the discovery page below, which shows
// what already exists on GitHub for that CO before anything is created.
// Plain POST-redirect-GET so the discovery page is reloadable/bookmarkable
// and the CO lives in the URL.
router.post('/:repoId/co', async (req, res) => {
  const access = await loadAccess(req, res);
  if (!access) return;

  const coNumber = (req.body.co_number || '').trim().toUpperCase();
  if (!branchService.isValidCoNumber(coNumber)) {
    return renderRepoPage(req, res, access, 'CO number must match format C12345678 (a C followed by 8 digits).');
  }

  res.redirect(`/repos/${access.repo.id}/co/${coNumber}`);
});

// Opens a session on `branch` and takes the user to it - the shared tail of
// every path off the discovery page (continue / adopt / create new).
async function enterBranch(req, res, access, branch) {
  const session = await sessionService.findOrCreateSession(branch.id, req.session.user.id);
  await lockService.acquireLock(access.repo.id, branch.co_number, session.id, req.session.user.id);
  res.redirect(`/repos/${access.repo.id}/branches/${branch.id}`);
}

// Renders Phase 18's intermediate "branches for this CO" page. Discovery is a
// live GitHub call, so it can fail (no creds, rate limit, outage); when it
// does we show the error and deliberately offer *no* create option, because
// without the GitHub side of the picture we can't compute an increment that's
// safe to create - which is the exact failure this phase exists to remove.
async function renderCoPage(req, res, access, coNumber, error) {
  let discovery = null;
  let discoveryError = null;
  try {
    discovery = await branchService.discoverCoBranches({ repo: access.repo, org: access.org, coNumber });
  } catch (err) {
    discoveryError = err.message;
  }

  const nextIncrement = discovery
    ? await branchService.getNextIncrement(
        req.session.user.initials,
        coNumber,
        branchService.takenIncrementsFor(discovery, req.session.user.initials)
      )
    : null;

  res.render('co-branches', {
    user: req.session.user,
    repo: access.repo,
    org: access.org,
    repoGroup: access.repoGroup,
    branches: await branchService.listActiveBranches(access.repo, access.org),
    coNumber,
    entries: discovery ? discovery.entries : [],
    nextIncrement,
    proposedBranchName: nextIncrement ? `dev/${req.session.user.initials}-${coNumber}-${nextIncrement}` : null,
    discoveryError,
    error,
  });
}

// Validates the CO out of the path itself, so a hand-typed /co/whatever gets
// the same single CO spelling rule as the form (CO_NUMBER_RE) rather than
// reaching GitHub with garbage.
function coNumberParam(req, res) {
  const coNumber = (req.params.coNumber || '').trim();
  if (!branchService.isValidCoNumber(coNumber)) {
    res.status(400).send('CO number must match format C12345678 (a C followed by 8 digits).');
    return null;
  }
  return coNumber;
}

router.get('/:repoId/co/:coNumber', async (req, res) => {
  const access = await loadAccess(req, res);
  if (!access) return;
  const coNumber = coNumberParam(req, res);
  if (!coNumber) return;

  await renderCoPage(req, res, access, coNumber, null);
});

// Adopt an existing GitHub branch Apex has no row for. branchService
// re-discovers and re-checks adoptability rather than trusting the submitted
// name - the page the user clicked on is a snapshot.
router.post('/:repoId/co/:coNumber/adopt', async (req, res) => {
  const access = await loadAccess(req, res);
  if (!access) return;
  const coNumber = coNumberParam(req, res);
  if (!coNumber) return;

  const branchName = (req.body.branch_name || '').trim();
  let branch;
  try {
    branch = await branchService.adoptBranch({ repo: access.repo, org: access.org, coNumber, branchName });
  } catch (err) {
    return renderCoPage(req, res, access, coNumber, err.message);
  }

  await auditLog.logAction({ userId: req.session.user.id, action: 'branch_adopted', detail: branch.branch_name });
  await enterBranch(req, res, access, branch);
});

// Create a new branch at the next increment available across *both* sources -
// Apex's own rows and the refs just discovered on GitHub - so a hand-made -1
// means this one is -2, never a second -1 that fails at createBranchRef.
router.post('/:repoId/co/:coNumber/create', async (req, res) => {
  const access = await loadAccess(req, res);
  if (!access) return;
  const coNumber = coNumberParam(req, res);
  if (!coNumber) return;

  let branch;
  try {
    const discovery = await branchService.discoverCoBranches({ repo: access.repo, org: access.org, coNumber });
    branch = await branchService.createBranch({
      repo: access.repo,
      org: access.org,
      coNumber,
      user: req.session.user,
      takenIncrements: branchService.takenIncrementsFor(discovery, req.session.user.initials),
    });
  } catch (err) {
    return renderCoPage(req, res, access, coNumber, err.message);
  }

  await enterBranch(req, res, access, branch);
});

router.post('/:repoId/branches/:branchId/continue', async (req, res) => {
  const access = await loadAccess(req, res);
  if (!access) return;

  const [[branch]] = await db.query("SELECT * FROM branches WHERE id = ? AND repo_id = ? AND status = 'active'", [
    req.params.branchId,
    access.repo.id,
  ]);
  if (!branch) return renderRepoPage(req, res, access, 'That branch is no longer active.');

  const session = await sessionService.findOrCreateSession(branch.id, req.session.user.id);
  await lockService.acquireLock(access.repo.id, branch.co_number, session.id, req.session.user.id);

  res.redirect(`/repos/${access.repo.id}/branches/${branch.id}`);
});

// Phase 13 branch-management actions (repo page, Active/Stale table).
// Deactivate/delete are blocked while this exact branch's own session holds
// the pipeline lock, so a branch can't be pulled out from under an in-flight
// pipeline run - see lockService.isLockedForBranch.
router.post('/:repoId/branches/:branchId/deactivate', async (req, res) => {
  const access = await loadAccess(req, res);
  if (!access) return;
  const branch = await loadBranch(req, res, access);
  if (!branch) return;

  if (await lockService.isLockedForBranch(access.repo.id, branch.co_number, branch.id)) {
    return renderRepoPage(req, res, access, 'This branch has a pipeline run in progress; wait for it to finish before deactivating.');
  }

  const ok = await branchService.deactivateBranch(branch.id);
  if (ok) {
    await auditLog.logAction({ userId: req.session.user.id, action: 'branch_deactivated', detail: branch.branch_name });
  }
  res.redirect(`/repos/${access.repo.id}?tab=active`);
});

router.post('/:repoId/branches/:branchId/reactivate', async (req, res) => {
  const access = await loadAccess(req, res);
  if (!access) return;
  const branch = await loadBranch(req, res, access);
  if (!branch) return;

  const result = await branchService.reactivateBranch(branch, access.repo, access.org);
  if (result.reactivated) {
    await auditLog.logAction({ userId: req.session.user.id, action: 'branch_reactivated', detail: branch.branch_name });
    return res.redirect(`/repos/${access.repo.id}?tab=active`);
  }
  if (result.deletedInstead) {
    return renderRepoPage(
      req,
      res,
      access,
      `"${branch.branch_name}" no longer exists on GitHub and was marked deleted instead of reactivated.`
    );
  }
  res.redirect(`/repos/${access.repo.id}?tab=stale`);
});

router.post('/:repoId/branches/:branchId/delete', async (req, res) => {
  const access = await loadAccess(req, res);
  if (!access) return;
  const branch = await loadBranch(req, res, access);
  if (!branch) return;

  if (await lockService.isLockedForBranch(access.repo.id, branch.co_number, branch.id)) {
    return renderRepoPage(req, res, access, 'This branch has a pipeline run in progress; wait for it to finish before deleting.');
  }

  await branchService.deleteBranch(branch.id);
  await auditLog.logAction({ userId: req.session.user.id, action: 'branch_deleted', detail: branch.branch_name });
  res.redirect(`/repos/${access.repo.id}?tab=${branch.status === 'stale' ? 'stale' : 'active'}`);
});

async function renderBranchPage(req, res, access, branch, session, error) {
  const [[lock]] = await db.query('SELECT session_id FROM pipeline_locks WHERE repo_id = ? AND co_number = ?', [
    access.repo.id,
    branch.co_number,
  ]);
  const lockHeld = !!lock && lock.session_id === session.id;

  const [branches, conversation, [requirements], [[latestRun]], coSection] = await Promise.all([
    branchService.listActiveBranches(access.repo, access.org),
    clarificationService.getConversation(session.id),
    db.query('SELECT * FROM session_requirements WHERE session_id = ? ORDER BY id ASC', [session.id]),
    db.query('SELECT * FROM pipeline_runs WHERE session_id = ? ORDER BY id DESC LIMIT 1', [session.id]),
    documentsService.getCoSection(access.repo.id, branch.co_number),
  ]);

  const pendingRequirement = requirements.find((r) => r.confirm_status === 'pending_confirm') || null;
  let overlapRequirement = null;
  if (pendingRequirement && pendingRequirement.overlap_flag_requirement_id) {
    const [[row]] = await db.query('SELECT id, requirement_text FROM session_requirements WHERE id = ?', [
      pendingRequirement.overlap_flag_requirement_id,
    ]);
    overlapRequirement = row || null;
  }

  // Eligible for the "Approve & Implement" gate once every requirement has
  // resolved out of pending_confirm and at least one is actually confirmed to
  // proceed (see ROADMAP.md Phase 8). Approval is never "locked in": a new
  // requirement finalized after approval drops the session back out of
  // 'queued' automatically (see clarificationService.js), so this condition
  // re-evaluates true again once that happens.
  const hasConfirmedRequirement = requirements.some((r) => r.confirm_status === 'confirmed_proceed');
  const eligibleForApproval =
    lockHeld && session.status === 'awaiting_approval' && !pendingRequirement && hasConfirmedRequirement;

  // Eligible for resume-from-failed-step (see ROADMAP.md Phase 9) only while
  // the failed attempt's container is still kept alive and hasn't already
  // exhausted its resume budget - pipelineRunner.js tears the container down
  // and clears container_id once that happens, falling back to the plain
  // full-retry button below.
  const eligibleForResume =
    lockHeld &&
    session.status === 'failed' &&
    !!latestRun &&
    !!latestRun.container_id &&
    latestRun.resume_attempt_count < pipelineRunner.MAX_RESUME_ATTEMPTS;

  const topStepper = pipelineStepper.buildTopStepper(session, eligibleForApproval);
  const subStepper = pipelineStepper.buildSubStepper(session, latestRun);

  res.render('branch', {
    user: req.session.user,
    repo: access.repo,
    org: access.org,
    branch,
    session,
    lockHeld,
    branches,
    conversation,
    requirements,
    pendingRequirement,
    overlapRequirement,
    latestRun,
    eligibleForApproval,
    eligibleForResume,
    topStepper,
    subStepper,
    coSection,
    error,
  });
}

router.get('/:repoId/branches/:branchId', async (req, res) => {
  const access = await loadAccess(req, res);
  if (!access) return;

  const loaded = await loadBranchSession(req, res, access);
  if (!loaded) return;
  await renderBranchPage(req, res, access, loaded.branch, loaded.session, null);
});

router.post('/:repoId/branches/:branchId/messages', async (req, res) => {
  const access = await loadAccess(req, res);
  if (!access) return;

  const loaded = await loadBranchSession(req, res, access);
  if (!loaded) return;
  const { branch, session } = loaded;

  const text = (req.body.text || '').trim();
  if (!text) return res.redirect(`/repos/${access.repo.id}/branches/${branch.id}`);

  // The clarification loop stays open through 'queued' (a user can still add
  // more before worker.js picks it up - see ROADMAP.md Phase 8: approval is
  // never "locked in"), but not once a pipeline is actually running or has
  // reached a terminal state.
  if (session.status !== 'awaiting_approval' && session.status !== 'queued') {
    return res.redirect(`/repos/${access.repo.id}/branches/${branch.id}`);
  }

  // Pausing until any overlap flag is resolved is enforced here too, not
  // just by hiding the form in the view - see notes.md / ROADMAP.md Phase 5
  // ("never auto-skip").
  const [[pending]] = await db.query(
    "SELECT id FROM session_requirements WHERE session_id = ? AND confirm_status = 'pending_confirm'",
    [session.id]
  );
  if (pending) return res.redirect(`/repos/${access.repo.id}/branches/${branch.id}`);

  try {
    await clarificationService.submitMessage({
      session,
      branch,
      org: access.org,
      repo: access.repo,
      user: req.session.user,
      text,
    });
  } catch (err) {
    // Network/model failures (GitHub API, NVIDIA NIM) are expected in
    // practice - surface them on the branch page rather than a raw 500,
    // consistent with how createBranch's GitHub-call failures are handled
    // above. The user's message is already persisted, so retrying just
    // resubmits a new message rather than losing their input.
    return renderBranchPage(req, res, access, branch, session, err.message);
  }

  res.redirect(`/repos/${access.repo.id}/branches/${branch.id}`);
});

// Approve & Implement (see ROADMAP.md Phase 8): the human gate a session
// must pass before worker.js will pick it up. Offered once every submitted
// requirement has resolved out of pending_confirm; clicking it sets
// approved_at and flips the session to 'queued'. Approval is never "locked
// in" - see clarificationService.js's finalizeRequirement, which drops a
// 'queued' session back to 'awaiting_approval' the moment a new requirement
// is finalized on it.
router.post('/:repoId/branches/:branchId/approve', async (req, res) => {
  const access = await loadAccess(req, res);
  if (!access) return;

  const loaded = await loadBranchSession(req, res, access);
  if (!loaded) return;
  const { branch, session } = loaded;

  const [[lock]] = await db.query('SELECT session_id FROM pipeline_locks WHERE repo_id = ? AND co_number = ?', [
    access.repo.id,
    branch.co_number,
  ]);
  const [requirements] = await db.query('SELECT confirm_status FROM session_requirements WHERE session_id = ?', [
    session.id,
  ]);
  const hasPending = requirements.some((r) => r.confirm_status === 'pending_confirm');
  const hasConfirmed = requirements.some((r) => r.confirm_status === 'confirmed_proceed');
  const eligible =
    lock && lock.session_id === session.id && session.status === 'awaiting_approval' && !hasPending && hasConfirmed;

  if (!eligible) {
    return renderBranchPage(req, res, access, branch, session, 'This session is not eligible for approval yet.');
  }

  await db.query("UPDATE sessions SET status = 'queued', approved_at = NOW() WHERE id = ?", [session.id]);
  await auditLog.logAction({ sessionId: session.id, userId: req.session.user.id, action: 'session_approved' });

  res.redirect(`/repos/${access.repo.id}/branches/${branch.id}`);
});

// Retry-on-failure (see ROADMAP.md Phase 8): re-queues the *same* session row
// as a full from-scratch re-run - codegen, sandbox build/test, and push all
// happen again. Nothing from the failed pipeline_runs row is reused;
// pipelineRunner.js removes that attempt's kept-alive container the next
// time it runs this session, rather than resuming from it (that's Phase 9's
// resume-from-step retry, a distinct feature from this one).
router.post('/:repoId/branches/:branchId/retry', async (req, res) => {
  const access = await loadAccess(req, res);
  if (!access) return;

  const loaded = await loadBranchSession(req, res, access);
  if (!loaded) return;
  const { branch, session } = loaded;

  const [result] = await db.query(
    "UPDATE sessions SET status = 'queued', approved_at = NOW(), resume_requested = FALSE WHERE id = ? AND status = 'failed'",
    [session.id]
  );
  if (result.affectedRows) {
    await auditLog.logAction({ sessionId: session.id, userId: req.session.user.id, action: 'pipeline_retried' });
  }

  res.redirect(`/repos/${access.repo.id}/branches/${branch.id}`);
});

// Clear-after-failure: abandons a failed session rather than re-running it -
// releases the pipeline lock it's still holding (lockService never releases
// on failure) and starts a brand-new session with no carried-over
// requirements, so the user can describe the work fresh instead of being
// forced to retry the same requirements that led to the failure. The old
// session's own status is left untouched (same precedent as Phase 11's admin
// force-unlock) - it just stops being "the most recent session" once the new
// one exists, so loadBranchSession/branch.ejs naturally move on from it.
router.post('/:repoId/branches/:branchId/clear', async (req, res) => {
  const access = await loadAccess(req, res);
  if (!access) return;

  const loaded = await loadBranchSession(req, res, access);
  if (!loaded) return;
  const { branch, session } = loaded;

  if (session.status !== 'failed') {
    return renderBranchPage(req, res, access, branch, session, 'This session is not in a failed state to clear.');
  }

  await lockService.releaseLock(access.repo.id, branch.co_number, session.id);
  const newSession = await sessionService.createSession(branch.id, req.session.user.id);
  await lockService.acquireLock(access.repo.id, branch.co_number, newSession.id, req.session.user.id);
  await auditLog.logAction({
    sessionId: session.id,
    userId: req.session.user.id,
    action: 'session_cleared',
    detail: `started new session ${newSession.id}`,
  });

  res.redirect(`/repos/${access.repo.id}/branches/${branch.id}`);
});

// Resume-from-failed-step (see ROADMAP.md Phase 9): unlike /retry above, this
// reuses the failed attempt's kept-alive container and whatever the last
// successfully completed step produced - worker.js dispatches to
// pipelineRunner.resume() instead of .run() based on resume_requested, since
// both this and /retry just leave the session 'queued'.
router.post('/:repoId/branches/:branchId/resume', async (req, res) => {
  const access = await loadAccess(req, res);
  if (!access) return;

  const loaded = await loadBranchSession(req, res, access);
  if (!loaded) return;
  const { branch, session } = loaded;

  const [[lock]] = await db.query('SELECT session_id FROM pipeline_locks WHERE repo_id = ? AND co_number = ?', [
    access.repo.id,
    branch.co_number,
  ]);
  const [[latestRun]] = await db.query('SELECT * FROM pipeline_runs WHERE session_id = ? ORDER BY id DESC LIMIT 1', [
    session.id,
  ]);
  const eligible =
    lock &&
    lock.session_id === session.id &&
    session.status === 'failed' &&
    latestRun &&
    latestRun.container_id &&
    latestRun.resume_attempt_count < pipelineRunner.MAX_RESUME_ATTEMPTS;

  if (!eligible) {
    return renderBranchPage(req, res, access, branch, session, 'This session can no longer resume from its failed step.');
  }

  await db.query("UPDATE sessions SET status = 'queued', resume_requested = TRUE WHERE id = ?", [session.id]);
  await auditLog.logAction({ sessionId: session.id, userId: req.session.user.id, action: 'pipeline_resume_requested' });

  res.redirect(`/repos/${access.repo.id}/branches/${branch.id}`);
});

async function resolveOverlap(req, res, confirmStatus, action) {
  const access = await loadAccess(req, res);
  if (!access) return;

  const loaded = await loadBranchSession(req, res, access);
  if (!loaded) return;
  const { branch, session } = loaded;

  const [[requirement]] = await db.query(
    "SELECT * FROM session_requirements WHERE id = ? AND session_id = ? AND confirm_status = 'pending_confirm'",
    [req.params.requirementId, session.id]
  );
  if (requirement) {
    await db.query('UPDATE session_requirements SET confirm_status = ? WHERE id = ?', [confirmStatus, requirement.id]);
    await auditLog.logAction({
      sessionId: session.id,
      userId: req.session.user.id,
      action,
      detail: requirement.requirement_text,
    });
  }

  res.redirect(`/repos/${access.repo.id}/branches/${branch.id}`);
}

router.post('/:repoId/branches/:branchId/requirements/:requirementId/confirm', (req, res) =>
  resolveOverlap(req, res, 'confirmed_proceed', 'overlap_confirmed')
);

router.post('/:repoId/branches/:branchId/requirements/:requirementId/skip', (req, res) =>
  resolveOverlap(req, res, 'confirmed_skip', 'overlap_skipped')
);

module.exports = router;
