const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const db = require('../lib/db');
const { getAccessibleRepo } = require('../lib/repoAccess');
const branchService = require('../lib/branchService');
const sessionService = require('../lib/sessionService');
const lockService = require('../lib/lockService');
const clarificationService = require('../lib/clarificationService');
const auditLog = require('../lib/auditLog');

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
  const branches = await branchService.listActiveBranches(access.repo, access.org);
  res.render('repo', {
    user: req.session.user,
    repo: access.repo,
    org: access.org,
    repoGroup: access.repoGroup,
    branches,
    error,
  });
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

router.post('/:repoId/branches', async (req, res) => {
  const access = await loadAccess(req, res);
  if (!access) return;

  const coNumber = (req.body.co_number || '').trim();
  let branch;
  try {
    branch = await branchService.createBranch({ repo: access.repo, org: access.org, coNumber, user: req.session.user });
  } catch (err) {
    return renderRepoPage(req, res, access, err.message);
  }

  const session = await sessionService.findOrCreateSession(branch.id, req.session.user.id);
  await lockService.acquireLock(access.repo.id, coNumber, session.id, req.session.user.id);

  res.redirect(`/repos/${access.repo.id}/branches/${branch.id}`);
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

async function renderBranchPage(req, res, access, branch, session, error) {
  const [[lock]] = await db.query('SELECT session_id FROM pipeline_locks WHERE repo_id = ? AND co_number = ?', [
    access.repo.id,
    branch.co_number,
  ]);
  const lockHeld = !!lock && lock.session_id === session.id;

  const [branches, conversation, [requirements], [[latestRun]]] = await Promise.all([
    branchService.listActiveBranches(access.repo, access.org),
    clarificationService.getConversation(session.id),
    db.query('SELECT * FROM session_requirements WHERE session_id = ? ORDER BY id ASC', [session.id]),
    db.query('SELECT * FROM pipeline_runs WHERE session_id = ? ORDER BY id DESC LIMIT 1', [session.id]),
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
    "UPDATE sessions SET status = 'queued', approved_at = NOW() WHERE id = ? AND status = 'failed'",
    [session.id]
  );
  if (result.affectedRows) {
    await auditLog.logAction({ sessionId: session.id, userId: req.session.user.id, action: 'pipeline_retried' });
  }

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
