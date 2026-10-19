const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const db = require('../lib/db');
const { getAccessibleRepo, accessStateMessage } = require('../lib/repoAccess');
const branchService = require('../lib/branchService');
const sessionService = require('../lib/sessionService');
const lockService = require('../lib/lockService');
const clarificationService = require('../lib/clarificationService');
const auditLog = require('../lib/auditLog');
const pipelineRunner = require('../lib/pipeline/pipelineRunner');
const pipelineStepper = require('../lib/pipelineStepper');
const pipelinePolling = require('../lib/pipelinePolling');
const documentsService = require('../lib/documents/documentsService');
const docDefinitions = require('../lib/documents/docDefinitions');
const docRunService = require('../lib/documents/docRunService');

const router = express.Router();
router.use(requireAuth);

// `need` is 'read', 'docs' or 'write' (see ROADMAP.md Phase 27) and is stated
// at every call site below rather than defaulted - getAccessibleRepo throws if
// it is missing, because neither possible default is safe.
//
// The 403 here and the views' hiding of the same controls are both required and
// neither is redundant: the hidden control is what stops an engineer wasting a
// click, and this is what stops a stale tab, a bookmarked POST target or a
// back-button resubmit getting through anyway.
async function loadAccess(req, res, need) {
  const access = await getAccessibleRepo(req.params.repoId, req.session.user.id, need);
  if (!access) {
    res.status(404).send('Repo not found.');
    return null;
  }
  if (access.forbidden) {
    res.status(403).send('Forbidden: no access to this repo group.');
    return null;
  }
  if (access.denied) {
    res.status(403).send(accessStateMessage(access.denied, access.note));
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
  const access = await loadAccess(req, res, 'read');
  if (!access) return;
  await renderRepoPage(req, res, access, null);
});

// Per-repo Documents view (see ROADMAP.md Phase 8) - the global, CO-scoped
// cross-repo search lives at GET /documents instead (app/routes/documents.js).
router.get('/:repoId/documents', async (req, res) => {
  const access = await loadAccess(req, res, 'read');
  if (!access) return;

  // One read for every repo-level document, then split by type, rather than a
  // query per type: the definitions decide how many there are (see ROADMAP.md
  // Phase 23/24), and a per-type query would mean one more round trip each
  // time an admin creates a document.
  const [branches, docResult, syncResult, definitions] = await Promise.all([
    branchService.listActiveBranches(access.repo, access.org),
    db.query("SELECT doc_type, content, updated_at FROM repo_documents WHERE repo_id = ? AND co_number = ''", [
      access.repo.id,
    ]),
    // Phase 27's frozen marker needs no new column: repo_doc_sync already
    // records the commit each document was generated from. Read unconditionally
    // rather than only for a disabled repo - one indexed read by repo_id, and a
    // branch here would be a second place the state has to be interpreted.
    db.query('SELECT doc_type, synced_commit_sha FROM repo_doc_sync WHERE repo_id = ?', [access.repo.id]),
    docDefinitions.listAll(),
  ]);
  const byType = Object.fromEntries(docResult[0].map((d) => [d.doc_type, d]));
  const syncedByType = Object.fromEntries(syncResult[0].map((r) => [r.doc_type, r]));

  // Built from the definitions, not from the rows that happen to exist, so a
  // document that has never been generated still gets its "not generated yet"
  // block - and so a document an admin created this morning appears here with
  // no view edit.
  //
  // listAll(), not listActive(): an inactive document stops regenerating but
  // what was already written stays readable, which is the whole difference
  // between turning one off and deleting it. A deleted (archived) definition
  // does drop off this page - its content survives in repo_documents but
  // nothing lists it, which is what the admin delete confirmation says.
  const generatedDocs = definitions.map((d) => ({
    label: d.title,
    description: d.description,
    active: !!d.is_active,
    doc: byType[d.doc_key] || null,
    // Short sha for the frozen marker (see ROADMAP.md Phase 27). Null when the
    // document has never been generated, in which case there is nothing frozen
    // to mark and the "not generated yet" block below says so instead.
    syncedSha: syncedByType[d.doc_key] ? syncedByType[d.doc_key].synced_commit_sha.slice(0, 7) : null,
  }));

  res.render('repo-documents', {
    user: req.session.user,
    repo: access.repo,
    org: access.org,
    repoGroup: access.repoGroup,
    branches,
    // The requirements log is not in the registry: it is written inline by
    // requirementsLogService.js as sessions complete, not generated by the
    // nightly worker, so it is rendered separately.
    requirementsLog: byType.requirements_log || null,
    generatedDocs,
  });
});

// Phase 18: entering a CO on the repo page no longer creates a branch. It
// validates the CO and hands off to the discovery page below, which shows
// what already exists on GitHub for that CO before anything is created.
// Plain POST-redirect-GET so the discovery page is reloadable/bookmarkable
// and the CO lives in the URL.
router.post('/:repoId/co', async (req, res) => {
  const access = await loadAccess(req, res, 'write');
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
  const access = await loadAccess(req, res, 'read');
  if (!access) return;
  const coNumber = coNumberParam(req, res);
  if (!coNumber) return;

  await renderCoPage(req, res, access, coNumber, null);
});

// Adopt an existing GitHub branch Apex has no row for. branchService
// re-discovers and re-checks adoptability rather than trusting the submitted
// name - the page the user clicked on is a snapshot.
router.post('/:repoId/co/:coNumber/adopt', async (req, res) => {
  const access = await loadAccess(req, res, 'write');
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
  const access = await loadAccess(req, res, 'write');
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
  const access = await loadAccess(req, res, 'write');
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
  const access = await loadAccess(req, res, 'write');
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
  const access = await loadAccess(req, res, 'write');
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
  const access = await loadAccess(req, res, 'write');
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

// Eligible for the "Approve & Implement" gate once every requirement has
// resolved out of pending_confirm and at least one is actually confirmed to
// proceed (see ROADMAP.md Phase 8). Approval is never "locked in": a new
// requirement finalized after approval drops the session back out of
// 'queued' automatically (see clarificationService.js), so this condition
// re-evaluates true again once that happens.
//
// Extracted from renderBranchPage for Phase 31's status endpoint, which needs
// the same flag to feed the same pipelineStepper: two derivations of "which
// step are we on" would drift, and the drift would show up as the stepper
// disagreeing with itself across a refresh.
function computeApprovalEligibility(session, lockHeld, requirements) {
  const pendingRequirement = requirements.find((r) => r.confirm_status === 'pending_confirm') || null;
  const hasConfirmedRequirement = requirements.some((r) => r.confirm_status === 'confirmed_proceed');
  return {
    pendingRequirement,
    eligibleForApproval:
      lockHeld && session.status === 'awaiting_approval' && !pendingRequirement && hasConfirmedRequirement,
  };
}

async function renderBranchPage(req, res, access, branch, session, error) {
  const [[lock]] = await db.query('SELECT session_id FROM pipeline_locks WHERE repo_id = ? AND co_number = ?', [
    access.repo.id,
    branch.co_number,
  ]);
  const lockHeld = !!lock && lock.session_id === session.id;

  const [branches, conversation, [requirements], [[latestRun]], coSection, runnableDocuments] = await Promise.all([
    branchService.listActiveBranches(access.repo, access.org),
    clarificationService.getConversation(session.id),
    db.query('SELECT * FROM session_requirements WHERE session_id = ? ORDER BY id ASC', [session.id]),
    db.query('SELECT * FROM pipeline_runs WHERE session_id = ? ORDER BY id DESC LIMIT 1', [session.id]),
    documentsService.getCoSection(access.repo.id, branch.co_number),
    // Empty when the repo has on-demand runs off, which the view reads as "no
    // panel at all" (see ROADMAP.md Phase 25).
    docRunService.listRunnableDocuments(access.repo),
  ]);

  const { pendingRequirement, eligibleForApproval } = computeApprovalEligibility(session, lockHeld, requirements);
  let overlapRequirement = null;
  if (pendingRequirement && pendingRequirement.overlap_flag_requirement_id) {
    const [[row]] = await db.query('SELECT id, requirement_text FROM session_requirements WHERE id = ?', [
      pendingRequirement.overlap_flag_requirement_id,
    ]);
    overlapRequirement = row || null;
  }

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

  // Phase 29: the holder may let go of the (repo, CO) slot themselves, but
  // only while nothing is executing - see the /release-lock route below for
  // why 'queued' and 'running' are excluded. Both the button and the route's
  // refusal read the same constant, so the two cannot drift apart.
  const eligibleForRelease = lockHeld && RELEASABLE_SESSION_STATUSES.includes(session.status);

  const topStepper = pipelineStepper.buildTopStepper(session, eligibleForApproval);
  const subStepper = pipelineStepper.buildSubStepper(session, latestRun);
  // Phase 31: the same view-model the /status endpoint returns, so the first
  // paint and every poll after it are produced by one code path.
  const progress = pipelinePolling.buildBranchStatus({ session, latestRun, eligibleForApproval });

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
    eligibleForRelease,
    topStepper,
    subStepper,
    progress,
    coSection,
    runnableDocuments,
    error,
  });
}

router.get('/:repoId/branches/:branchId', async (req, res) => {
  const access = await loadAccess(req, res, 'read');
  if (!access) return;

  const loaded = await loadBranchSession(req, res, access);
  if (!loaded) return;
  await renderBranchPage(req, res, access, loaded.branch, loaded.session, null);
});

// Read-only JSON twin of the stepper on the page above (see ROADMAP.md Phase
// 31), polled by public/js/branch-poll.js while a run is in flight.
//
// Behind the same loadAccess(req, res, 'read') as the page: a JSON endpoint
// must not be a cheaper way to read a repo than the page it belongs to, and
// going through the same loader is what gives it Phase 27's access states for
// free. Both failure paths it inherits answer in text/plain rather than JSON,
// which the client treats as "stop polling" on any non-OK response - it never
// parses the body of a refusal.
//
// Nothing here writes, and nothing here is the authority on what the page
// shows once the run ends: the client's response to a terminal status is one
// full reload, because completion also brings the build and test logs, the
// commit SHA, the failure actions and a released pipeline lock, and only a
// server-side render gets all of those consistent with each other.
router.get('/:repoId/branches/:branchId/status', async (req, res) => {
  const access = await loadAccess(req, res, 'read');
  if (!access) return;

  const loaded = await loadBranchSession(req, res, access);
  if (!loaded) return;
  const { branch, session } = loaded;

  const [[lock]] = await db.query('SELECT session_id FROM pipeline_locks WHERE repo_id = ? AND co_number = ?', [
    access.repo.id,
    branch.co_number,
  ]);
  const lockHeld = !!lock && lock.session_id === session.id;

  const [[requirements], [[latestRun]]] = await Promise.all([
    db.query('SELECT confirm_status FROM session_requirements WHERE session_id = ? ORDER BY id ASC', [session.id]),
    db.query('SELECT * FROM pipeline_runs WHERE session_id = ? ORDER BY id DESC LIMIT 1', [session.id]),
  ]);
  const { eligibleForApproval } = computeApprovalEligibility(session, lockHeld, requirements);

  res.json(pipelinePolling.buildBranchStatus({ session, latestRun, eligibleForApproval }));
});

// On-demand document run against this branch (see ROADMAP.md Phase 25). The
// report is generated IN this request and rendered in its response: nothing is
// written to repo_documents, repo_doc_sync or doc_jobs, so the nightly trunk
// document for this repo is bit-identical to what it would have been had the
// run never happened, and the download button on the result page builds its
// file client-side from the text already on screen.
//
// The accepted risk this route carries (see ROADMAP.md Phase 25): the web tier
// now calls a model synchronously, which until Phase 25 only worker.js and
// docWorker.js did. A 30-60 second request is exposed to gateway and
// load-balancer timeouts no other route here can hit, and the failure mode is an
// opaque 504 rather than a reported error. Accepted in exchange for no results
// table, no polling and no expiry story; the mitigations are docContext's diff
// cap keeping generations bounded and the panel saying plainly that the run
// takes a minute. If deployment timeouts prove this wrong, the fix is a
// progress-polled run, not a bigger timeout.
router.post('/:repoId/branches/:branchId/document-run', async (req, res) => {
  const access = await loadAccess(req, res, 'docs');
  if (!access) return;

  const loaded = await loadBranchSession(req, res, access);
  if (!loaded) return;
  const { branch, session } = loaded;

  let result;
  try {
    result = await docRunService.runForBranch({
      org: access.org,
      repo: access.repo,
      branch,
      docKey: (req.body.doc_key || '').trim(),
      user: req.session.user,
    });
  } catch (err) {
    // Every gate in docRunService throws a refusal with a sentence worth
    // showing; a GitHub or provider failure arrives here too, and gets the same
    // treatment rather than a raw 500, consistent with the clarification loop
    // above. Either way the user is back on the branch page with the reason,
    // and can simply try again.
    return renderBranchPage(req, res, access, branch, session, err.message);
  }

  // Logged because usage_events has no user column: repo_id answers "what is
  // this repo costing us", and this row is the only thing that answers "who
  // asked for it". It is also the only record that the run happened at all,
  // the report itself being deliberately unstored.
  await auditLog.logAction({
    sessionId: session.id,
    userId: req.session.user.id,
    action: 'document_run',
    detail: `${result.definition.doc_key} against ${branch.branch_name}`,
  });

  res.render('document-run', {
    user: req.session.user,
    repo: access.repo,
    org: access.org,
    branch,
    branches: await branchService.listActiveBranches(access.repo, access.org),
    definition: result.definition,
    model: result.model,
    usedFallback: result.usedFallback,
    content: result.content,
    // Built here rather than in the browser so the slashes in a dev/ branch
    // name cannot become path separators in a download, and so the filename
    // says which document and which branch it came from - the report carries
    // no other provenance once it leaves the page.
    downloadFilename: `${result.definition.doc_key}-${branch.branch_name.replace(/[^A-Za-z0-9._-]+/g, '-')}.md`,
  });
});

router.post('/:repoId/branches/:branchId/messages', async (req, res) => {
  const access = await loadAccess(req, res, 'write');
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
  const access = await loadAccess(req, res, 'write');
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
  const access = await loadAccess(req, res, 'write');
  if (!access) return;

  const loaded = await loadBranchSession(req, res, access);
  if (!loaded) return;
  const { branch, session } = loaded;

  // Re-stamp before re-queueing. A full from-scratch re-run should use the
  // user's current model, and more importantly a session that failed *because*
  // of its stamp (a NULL left by a pre-Phase-22 row, or a model since renamed
  // out of the catalog) would otherwise fail identically on every retry - the
  // Retry button being the only thing the failure page offers. Unlike /resume,
  // nothing here is reused from the failed attempt, so there is no partial
  // output for a different model to be stitched onto.
  await sessionService.restampSession(session.id, req.session.user.id);

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
  const access = await loadAccess(req, res, 'write');
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

// Release-my-own-lock (see ROADMAP.md Phase 29): the abandon verb, and
// deliberately not /clear above. /clear exists to *keep working* on the branch
// - it releases and immediately re-acquires for a fresh session, so the user
// still holds the slot afterwards. This one ends with the (repo, CO) slot free
// and the user holding nothing, so a colleague can take it without an admin
// running the force-unlock override.
//
// Refused while anything is actually executing: a 'queued' or 'running'
// session belongs to the worker, and freeing the slot under it would let a
// second session start a pipeline against the same CO on the same repo - the
// exact collision the lock exists to prevent.
const RELEASABLE_SESSION_STATUSES = ['awaiting_approval', 'failed'];

router.post('/:repoId/branches/:branchId/release-lock', async (req, res) => {
  const access = await loadAccess(req, res, 'write');
  if (!access) return;

  const loaded = await loadBranchSession(req, res, access);
  if (!loaded) return;
  const { branch, session } = loaded;

  const [[lock]] = await db.query('SELECT session_id FROM pipeline_locks WHERE repo_id = ? AND co_number = ?', [
    access.repo.id,
    branch.co_number,
  ]);
  if (!lock || lock.session_id !== session.id) {
    return renderBranchPage(req, res, access, branch, session, 'You do not hold the pipeline lock for this CO.');
  }

  if (!RELEASABLE_SESSION_STATUSES.includes(session.status)) {
    return renderBranchPage(
      req,
      res,
      access,
      branch,
      session,
      `This session is ${session.status} — a run is in flight, so the pipeline lock can't be released yet.`
    );
  }

  // Scoped to the holding session by releaseLock's own WHERE clause, which is
  // exactly the authorization this needs - no new data model, and the session's
  // own status is left untouched (same precedent as Phase 11's force-unlock and
  // Phase 13's /clear). It stays readable as the record of what happened and
  // stops being actionable because the lock it needed is gone.
  await lockService.releaseLock(access.repo.id, branch.co_number, session.id);
  // logAction, not logAdminAction: this is the holder resolving their own
  // situation, and the admin trail stays reserved for the force-unlock
  // override so the two remain distinguishable when a slot is found empty.
  await auditLog.logAction({
    sessionId: session.id,
    userId: req.session.user.id,
    action: 'pipeline_lock_released',
    detail: `CO ${branch.co_number}`,
  });

  res.redirect(`/repos/${access.repo.id}/branches/${branch.id}`);
});

// Resume-from-failed-step (see ROADMAP.md Phase 9): unlike /retry above, this
// reuses the failed attempt's kept-alive container and whatever the last
// successfully completed step produced - worker.js dispatches to
// pipelineRunner.resume() instead of .run() based on resume_requested, since
// both this and /retry just leave the session 'queued'.
router.post('/:repoId/branches/:branchId/resume', async (req, res) => {
  const access = await loadAccess(req, res, 'write');
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
  const access = await loadAccess(req, res, 'write');
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
