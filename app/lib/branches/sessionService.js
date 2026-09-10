// Phase 3 clarification loop: session lifecycle, Q&A turns against the
// model adapter, requirements finalization, and duplicate/overlap detection.
// See roadmap.md's "Phase 3 - Clarification loop" bullets for the scope this
// implements, and agent-prompts.md's "Phase 3" section for the system-prompt
// strategy, response-parsing convention, and audit-log semantics this module
// follows. Depends on the GitHub diff service and the model adapter, never
// on GitHub/model calls made ad hoc elsewhere - mirrors the separation
// coResolutionService.js keeps for Phase 2.
//
// Session status state machine (not spelled out verbatim in roadmap.md, so
// documented here):
//   - A session is created with status 'running' the first time a user
//     starts the clarification loop on a branch they don't already have a
//     non-terminal (queued/running) session on.
//   - Opening the loop again while a non-terminal session already exists
//     reuses it rather than creating a new row (see startOrResumeSession).
//   - 'running' -> 'queued' once every session_requirements row for the
//     session has left 'pending_confirm' (i.e. is 'confirmed_proceed' or
//     'confirmed_skip') AND at least one is 'confirmed_proceed'. 'queued'
//     means "ready for Phase 4's sandbox pickup" - Phase 4 doesn't exist
//     yet, so a queued session just sits there.
//   - This sync is bidirectional (see syncSessionStatus): if a queued
//     session later gains a new pending_confirm requirement (the user adds
//     more instructions after already being queued), it flips back to
//     'running'. Nothing consumes 'queued' yet, so this can't race a live
//     Phase 4 worker - it exists purely so 'queued' keeps meaning "actually
//     ready" rather than "was ready once."
//   - 'completed'/'failed' are terminal and out of this module's control -
//     they belong to Phase 4/5's pipeline execution, which doesn't exist
//     yet. A terminal session is never resumed; a fresh one is started
//     instead (see startOrResumeSession).

const db = require('../db');
const logger = require('../logger');
const { getModelAdapter } = require('../model');
const { getBranchDiffSummary } = require('../github/diffService');
const { buildStartSummaryMessages, buildQaSystemPrompt, buildOverlapCheckMessages } = require('./clarificationPrompts');
const { parseRequirementsReady, parseOverlapCheck } = require('./responseParsing');

// How many prior audit_log rows (across all users/sessions) to feed into the
// start/resume summary for this (repo, CO). Fixed, non-user-supplied
// constant - inlined into the SQL LIMIT rather than bound as a placeholder,
// since mysql2 prepared statements are unreliable with bound LIMIT values.
const AUDIT_HISTORY_LIMIT = 20;

function makeError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// --- branch/session lookups -------------------------------------------------

async function getActiveBranch({ repoId, branchId }) {
  const rows = await db.query(
    `SELECT id, repo_id AS repoId, initials, co_number AS coNumber, branch_name AS branchName,
            created_by_user_id AS createdByUserId, status
     FROM branches
     WHERE id = ? AND repo_id = ? AND status = 'active'`,
    [branchId, repoId]
  );
  return rows[0] || null;
}

async function getSessionById(sessionId) {
  const rows = await db.query(
    `SELECT id, user_id AS userId, branch_id AS branchId, status, completed_at AS completedAt, created_at AS createdAt
     FROM sessions WHERE id = ?`,
    [sessionId]
  );
  return rows[0] || null;
}

async function getSessionForBranch({ sessionId, branchId }) {
  const rows = await db.query(
    `SELECT id, user_id AS userId, branch_id AS branchId, status, completed_at AS completedAt, created_at AS createdAt
     FROM sessions WHERE id = ? AND branch_id = ?`,
    [sessionId, branchId]
  );
  return rows[0] || null;
}

async function getLatestSessionForUser({ userId, branchId }) {
  const rows = await db.query(
    `SELECT id, user_id AS userId, branch_id AS branchId, status, completed_at AS completedAt, created_at AS createdAt
     FROM sessions WHERE user_id = ? AND branch_id = ? ORDER BY created_at DESC LIMIT 1`,
    [userId, branchId]
  );
  return rows[0] || null;
}

async function createSession({ userId, branchId }) {
  const result = await db.query(`INSERT INTO sessions (user_id, branch_id, status) VALUES (?, ?, 'running')`, [
    userId,
    branchId,
  ]);
  return getSessionById(result.insertId);
}

async function countConversations(sessionId) {
  const rows = await db.query('SELECT COUNT(*) AS total FROM conversations WHERE session_id = ?', [sessionId]);
  return rows[0].total;
}

// --- conversations / audit_log logging --------------------------------------
//
// audit_log is append-only by design (roadmap.md Accepted Risk #4 treats it
// as the engineering-record audit trail) - every call into the model in this
// module writes exactly one new audit_log row, never an UPDATE. raw_instructions
// holds the real user text for a Q&A turn, or null for a system-triggered call
// (the start/resume summary, the overlap check) that has no user-authored
// instruction behind it. qa_history holds the model's raw reply text
// verbatim, fenced block and all, so a later parse dispute can be re-audited
// against exactly what the model said.
//
// conversations is the visible/replayable transcript. role is 'user' or
// 'assistant' for anything the user should see (Q&A turns, the start
// summary), or 'system' for internal-only turns (the overlap check) that are
// recorded for audit purposes but excluded from the chat transcript the UI
// renders (see getSessionDetail) and from the prior-turn context replayed
// into subsequent Q&A calls (see postMessage).

async function recordConversation({ sessionId, role, content }) {
  await db.query('INSERT INTO conversations (session_id, role, content) VALUES (?, ?, ?)', [sessionId, role, content]);
}

async function recordAudit({ userId, repoId, coNumber, rawInstructions, qaHistory }) {
  await db.query(
    `INSERT INTO audit_log (user_id, repo_id, co_number, raw_instructions, qa_history) VALUES (?, ?, ?, ?, ?)`,
    [userId, repoId, coNumber, rawInstructions || null, qaHistory || null]
  );
}

async function getAuditHistory({ repoId, coNumber }) {
  const rows = await db.query(
    `SELECT id, user_id AS userId, raw_instructions AS rawInstructions, qa_history AS qaHistory, created_at AS createdAt
     FROM audit_log WHERE repo_id = ? AND co_number = ? ORDER BY created_at DESC LIMIT ${AUDIT_HISTORY_LIMIT}`,
    [repoId, coNumber]
  );
  return rows;
}

// One call into the model adapter, plus the conversations/audit_log writes
// that must accompany it. Every model call in this module goes through this
// so the logging convention above can't be forgotten at a call site.
async function runChatTurn({ session, repo, coNumber, actingUserId, messages, persistUserMessage, replyRole }) {
  const { content } = await getModelAdapter().chat({ messages });

  if (persistUserMessage) {
    await recordConversation({ sessionId: session.id, role: 'user', content: persistUserMessage });
  }
  await recordConversation({ sessionId: session.id, role: replyRole, content });
  await recordAudit({
    userId: actingUserId,
    repoId: repo.id,
    coNumber,
    rawInstructions: persistUserMessage || null,
    qaHistory: content,
  });

  return content;
}

// --- session status sync -----------------------------------------------------

async function syncSessionStatus(sessionId) {
  const session = await getSessionById(sessionId);
  if (!session || session.status === 'completed' || session.status === 'failed') return;

  const rows = await db.query(
    `SELECT
       SUM(resolution_status = 'pending_confirm') AS pendingCount,
       SUM(resolution_status = 'confirmed_proceed') AS proceedCount,
       COUNT(*) AS total
     FROM session_requirements WHERE session_id = ?`,
    [sessionId]
  );
  const { pendingCount, proceedCount, total } = rows[0];
  const readyForQueue = Number(total) > 0 && Number(pendingCount) === 0 && Number(proceedCount) > 0;
  const nextStatus = readyForQueue ? 'queued' : 'running';

  if (nextStatus !== session.status) {
    await db.query('UPDATE sessions SET status = ? WHERE id = ?', [nextStatus, sessionId]);
    logger.info('session status transitioned', { sessionId, from: session.status, to: nextStatus });
  }
}

// --- start / resume ----------------------------------------------------------

async function generateStartSummary({ session, repo, branch, actingUserId }) {
  const diff = await getBranchDiffSummary({
    owner: repo.githubOwner,
    repoName: repo.name,
    base: repo.defaultBranchName,
    head: branch.branchName,
  });
  const history = await getAuditHistory({ repoId: repo.id, coNumber: branch.coNumber });

  const messages = buildStartSummaryMessages({ repo, branch, diff, history });

  await runChatTurn({
    session,
    repo,
    coNumber: branch.coNumber,
    actingUserId,
    messages,
    persistUserMessage: null,
    replyRole: 'assistant',
  });
}

async function startOrResumeSession({ repo, branch, user }) {
  let session = await getLatestSessionForUser({ userId: user.id, branchId: branch.id });
  let needsSummary = false;

  if (!session || session.status === 'completed' || session.status === 'failed') {
    session = await createSession({ userId: user.id, branchId: branch.id });
    needsSummary = true;
  } else if ((await countConversations(session.id)) === 0) {
    // Defensive: a non-terminal session with no summary yet. Should only
    // happen if a prior start attempt failed after the INSERT but before
    // the summary call completed - treat it the same as brand-new.
    needsSummary = true;
  }

  if (needsSummary) {
    await generateStartSummary({ session, repo, branch, actingUserId: user.id });
  }

  return session;
}

// --- Q&A turn + finalization --------------------------------------------------

async function getConfirmedRequirementsOnBranch({ branchId }) {
  const rows = await db.query(
    `SELECT sr.id, sr.content
     FROM session_requirements sr
     JOIN sessions s ON s.id = sr.session_id
     WHERE s.branch_id = ? AND sr.resolution_status = 'confirmed_proceed'
     ORDER BY sr.submitted_at ASC`,
    [branchId]
  );
  return rows;
}

async function insertRequirements({ sessionId, requirements }) {
  // Sequential inserts, not a batch - Q&A finalization typically yields a
  // handful of requirements at once, so the simplicity of tracking each
  // insertId this way outweighs any batch-insert performance gain here.
  const inserted = [];
  for (const content of requirements) {
    const result = await db.query(
      `INSERT INTO session_requirements (session_id, content, resolution_status) VALUES (?, ?, NULL)`,
      [sessionId, content]
    );
    inserted.push({ id: result.insertId, content, resolutionStatus: null, overlapFlagRequirementId: null });
  }
  return inserted;
}

// Checks each newly finalized requirement against already-`confirmed_proceed`
// requirements on this same branch (any user's session) - the best available
// proxy for "already implemented" at this phase (see roadmap.md Accepted
// Risk #8; there is no actual code-execution signal yet). Fails closed on
// any parse ambiguity: an unparseable or unverifiable judgment defaults every
// affected item to pending_confirm rather than letting it through, since a
// human confirmation is the whole point of this feature, not an optimization
// to skip when the model is unsure.
async function applyOverlapCheck({ session, repo, branch, inserted }) {
  const diff = await getBranchDiffSummary({
    owner: repo.githubOwner,
    repoName: repo.name,
    base: repo.defaultBranchName,
    head: branch.branchName,
  });
  const existing = await getConfirmedRequirementsOnBranch({ branchId: branch.id });

  const messages = buildOverlapCheckMessages({
    repo,
    branch,
    diff,
    existingRequirements: existing,
    candidateRequirements: inserted.map((r) => r.content),
  });

  const reply = await runChatTurn({
    session,
    repo,
    coNumber: branch.coNumber,
    actingUserId: session.userId,
    messages,
    persistUserMessage: null,
    replyRole: 'system',
  });

  const parsed = parseOverlapCheck(reply, inserted.length);
  const existingIds = new Set(existing.map((r) => r.id));

  for (let i = 0; i < inserted.length; i++) {
    const row = inserted[i];
    let resolutionStatus;
    let overlapFlagRequirementId = null;

    if (parsed === null) {
      resolutionStatus = 'pending_confirm';
      logger.warn('overlap-check reply failed to parse, defaulting to pending_confirm', {
        sessionId: session.id,
        requirementId: row.id,
      });
    } else {
      const verdict = parsed.get(i);
      if (verdict.duplicate && existingIds.has(verdict.duplicateOfRequirementId)) {
        resolutionStatus = 'pending_confirm';
        overlapFlagRequirementId = verdict.duplicateOfRequirementId;
      } else if (verdict.duplicate) {
        // The model named an id we never offered it as "already agreed" -
        // an unverifiable reference is exactly the kind of ambiguity this
        // fails closed on, same as a parse failure.
        resolutionStatus = 'pending_confirm';
        logger.warn('overlap-check named an unknown duplicateOfRequirementId, defaulting to pending_confirm', {
          sessionId: session.id,
          requirementId: row.id,
          claimedId: verdict.duplicateOfRequirementId,
        });
      } else {
        resolutionStatus = 'confirmed_proceed';
      }
    }

    await db.query('UPDATE session_requirements SET resolution_status = ?, overlap_flag_requirement_id = ? WHERE id = ?', [
      resolutionStatus,
      overlapFlagRequirementId,
      row.id,
    ]);
    row.resolutionStatus = resolutionStatus;
    row.overlapFlagRequirementId = overlapFlagRequirementId;
  }

  return inserted;
}

async function finalizeRequirements({ session, repo, branch, requirements }) {
  const inserted = await insertRequirements({ sessionId: session.id, requirements });
  const resolved = await applyOverlapCheck({ session, repo, branch, inserted });
  await syncSessionStatus(session.id);
  return resolved;
}

async function postMessage({ session, repo, branch, actingUserId, message }) {
  if (session.status === 'completed' || session.status === 'failed') {
    throw makeError('This session has already finished and cannot accept new messages', 'SESSION_TERMINAL');
  }

  // Prior visible turns only (user/assistant) - the overlap check's
  // system-role turn is intentionally excluded from what's replayed back
  // into the ongoing Q&A conversation; it's a separate, internal concern.
  const priorRows = await db.query(
    `SELECT role, content FROM conversations WHERE session_id = ? AND role IN ('user', 'assistant') ORDER BY created_at ASC`,
    [session.id]
  );

  const messages = [{ role: 'system', content: buildQaSystemPrompt({ repo, branch }) }, ...priorRows, { role: 'user', content: message }];

  const reply = await runChatTurn({
    session,
    repo,
    coNumber: branch.coNumber,
    actingUserId,
    messages,
    persistUserMessage: message,
    replyRole: 'assistant',
  });

  const finalRequirements = parseRequirementsReady(reply);
  if (finalRequirements === null) {
    return { finalized: false, reply };
  }

  const requirements = await finalizeRequirements({ session, repo, branch, requirements: finalRequirements });
  return { finalized: true, reply, requirements };
}

// --- resolve / confirm --------------------------------------------------------

async function resolveRequirement({ session, requirementId, resolution, actingUserId }) {
  // Defense in depth: route layer already enforces that only the session's
  // owner can reach this (see app/routes/sessions.js's loadOwnedSession),
  // but the invariant is re-checked here too since this is where it
  // actually matters - no auto-skip, no override by anyone but the
  // submitting user, per roadmap.md's confirm/override decision.
  if (actingUserId !== session.userId) {
    throw makeError('Only the session owner can resolve its requirements', 'FORBIDDEN');
  }
  if (resolution !== 'confirmed_proceed' && resolution !== 'confirmed_skip') {
    throw makeError('resolution must be "confirmed_proceed" or "confirmed_skip"', 'INVALID_RESOLUTION');
  }

  const rows = await db.query(
    `SELECT id, session_id AS sessionId, content, resolution_status AS resolutionStatus
     FROM session_requirements WHERE id = ? AND session_id = ?`,
    [requirementId, session.id]
  );
  const requirement = rows[0];
  if (!requirement) {
    throw makeError('Requirement not found on this session', 'NOT_FOUND');
  }
  if (requirement.resolutionStatus !== 'pending_confirm') {
    throw makeError(`Requirement is not awaiting confirmation (current status: ${requirement.resolutionStatus})`, 'INVALID_STATE');
  }

  await db.query('UPDATE session_requirements SET resolution_status = ? WHERE id = ?', [resolution, requirementId]);
  await syncSessionStatus(session.id);

  return { ...requirement, resolutionStatus: resolution };
}

// --- read views ---------------------------------------------------------------

async function listOtherSessionsForBranch({ branchId, excludingUserId }) {
  const sessions = await db.query(
    `SELECT s.id, s.user_id AS userId, u.username, u.initials, s.status, s.created_at AS createdAt
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.branch_id = ? AND s.user_id != ?
     ORDER BY s.created_at DESC`,
    [branchId, excludingUserId]
  );
  if (sessions.length === 0) return [];

  const sessionIds = sessions.map((s) => s.id);
  const placeholders = sessionIds.map(() => '?').join(', ');
  const requirementRows = await db.query(
    `SELECT session_id AS sessionId, content, resolution_status AS resolutionStatus
     FROM session_requirements WHERE session_id IN (${placeholders}) ORDER BY submitted_at ASC`,
    sessionIds
  );

  const requirementsBySession = new Map();
  for (const row of requirementRows) {
    if (!requirementsBySession.has(row.sessionId)) requirementsBySession.set(row.sessionId, []);
    requirementsBySession.get(row.sessionId).push({ content: row.content, resolutionStatus: row.resolutionStatus });
  }

  return sessions.map((s) => ({
    sessionId: s.id,
    username: s.username,
    initials: s.initials,
    status: s.status,
    createdAt: s.createdAt,
    requirements: requirementsBySession.get(s.id) || [],
  }));
}

// Phase 4's latest pipeline_runs row for this session, if any - included in
// getSessionDetail below so the UI's Pipeline panel can render status/log/
// commit link off the same GET .../sessions/:id call, per the "don't add a
// new endpoint for this" instruction. This is a plain read of a table Phase
// 4 owns (app/lib/pipeline/pipelineService.js writes it); kept here rather
// than importing pipelineService.js to avoid a require cycle, since
// pipelineService.js already depends on this module for runChatTurn below.
async function getLatestPipelineRun(sessionId) {
  const rows = await db.query(
    `SELECT id, status, started_at AS startedAt, finished_at AS finishedAt, log,
            commit_sha AS commitSha, error_message AS errorMessage
     FROM pipeline_runs WHERE session_id = ? ORDER BY started_at DESC LIMIT 1`,
    [sessionId]
  );
  return rows[0] || null;
}

async function getSessionDetail({ session, repo, branch }) {
  const conversations = await db.query(
    `SELECT id, role, content, created_at AS createdAt FROM conversations
     WHERE session_id = ? AND role IN ('user', 'assistant') ORDER BY created_at ASC`,
    [session.id]
  );
  const requirements = await db.query(
    `SELECT id, content, submitted_at AS submittedAt, overlap_flag_requirement_id AS overlapFlagRequirementId,
            resolution_status AS resolutionStatus
     FROM session_requirements WHERE session_id = ? ORDER BY submitted_at ASC`,
    [session.id]
  );
  const otherSessions = await listOtherSessionsForBranch({ branchId: branch.id, excludingUserId: session.userId });
  const pipelineRun = await getLatestPipelineRun(session.id);

  return { session, repo, branch, conversations, requirements, otherSessions, pipelineRun };
}

module.exports = {
  getActiveBranch,
  getSessionForBranch,
  startOrResumeSession,
  postMessage,
  resolveRequirement,
  getSessionDetail,
  // Reused as-is by Phase 4's app/lib/pipeline/pipelineService.js for its two
  // system-triggered model calls (file-selection, code-changes), so every
  // model call in the whole app goes through the same conversations/
  // audit_log discipline established here - see agent-prompts.md's Phase 4
  // section.
  runChatTurn,
};
