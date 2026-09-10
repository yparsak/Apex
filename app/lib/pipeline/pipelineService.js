// Phase 4: sandboxed execution. Orchestrates the full pipeline for one
// claimed `queued` session (see worker.js): branch-existence re-check,
// host-side "clone" (tarball download), declarative build/test config,
// two-step non-tool-calling code generation against the model adapter,
// applying those changes to the working tree, a sandboxed build/test run,
// and - only on success - a push via GitHub's Git Data API. Ends with the
// session marked `completed`/`failed`. Deliberately does NOT touch
// `pipeline_locks` and does NOT generate the Spec/Communication Protocol doc
// or the requirements-log file - releasing the lock and both of those are
// Phase 5's job, layered onto an already-pushed branch (see
// app/lib/locks/pipelineLock.js's file comment and roadmap.md's Phase 4/5
// split).
//
// See roadmap.md's "Phase 4 - Sandboxed execution" bullets for the scope
// this implements and agent-prompts.md's "Phase 4" section for the full
// design rationale (why no tool-calling, why no git binary, why the
// container is scoped the way it is, the fenced-block tags this introduces).

const fs = require('fs/promises');
const path = require('path');
const db = require('../db');
const logger = require('../logger');
const { branchExists } = require('../github/branchService');
const { getBranchDiffSummary } = require('../github/diffService');
const { commitAndPushChanges } = require('../github/commitService');
const { runChatTurn } = require('../branches/sessionService');
const { readPipelineConfig } = require('./pipelineConfig');
const { downloadAndExtractTree, listFilePaths, cleanupWorkingTree } = require('./workingTreeService');
const { buildFileSelectionMessages, buildCodeChangesMessages, FILES_NEEDED_TAG, FILE_CHANGES_TAG } = require('./pipelinePrompts');
const { parseFilesNeeded, parseFileChanges } = require('./pipelineResponseParsing');
const { runSandbox } = require('./sandboxRunner');

function makeCodegenError(message) {
  const err = new Error(message);
  err.code = 'CODEGEN_PARSE_FAILED';
  return err;
}

// --- context loading ---------------------------------------------------------

// The worker only knows a bare sessionId when it claims a row, so this
// module resolves everything else itself in one query, joining the same
// repos -> repo_groups -> orgs chain app/lib/repos/repoAccess.js uses for
// the "orgs.name is the GitHub owner login" convention.
async function loadPipelineContext(sessionId) {
  const rows = await db.query(
    `SELECT s.id AS sessionId, s.user_id AS userId, s.status AS sessionStatus, s.branch_id AS branchId,
            b.branch_name AS branchName, b.co_number AS coNumber, b.status AS branchStatus,
            r.id AS repoId, r.name AS repoName, r.default_branch_name AS defaultBranchName,
            o.name AS githubOwner
     FROM sessions s
     JOIN branches b ON b.id = s.branch_id
     JOIN repos r ON r.id = b.repo_id
     JOIN repo_groups rg ON rg.id = r.repo_group_id
     JOIN orgs o ON o.id = rg.org_id
     WHERE s.id = ?`,
    [sessionId]
  );
  const row = rows[0];
  if (!row) return null;

  return {
    session: { id: row.sessionId, userId: row.userId, status: row.sessionStatus },
    branch: { id: row.branchId, branchName: row.branchName, coNumber: row.coNumber, status: row.branchStatus },
    repo: { id: row.repoId, name: row.repoName, defaultBranchName: row.defaultBranchName, githubOwner: row.githubOwner },
  };
}

async function getConfirmedRequirementsForSession(sessionId) {
  const rows = await db.query(
    `SELECT content FROM session_requirements WHERE session_id = ? AND resolution_status = 'confirmed_proceed'
     ORDER BY submitted_at ASC`,
    [sessionId]
  );
  return rows.map((r) => r.content);
}

// --- pipeline_runs bookkeeping ------------------------------------------------

async function createPipelineRun(sessionId) {
  const result = await db.query(`INSERT INTO pipeline_runs (session_id, status) VALUES (?, 'running')`, [sessionId]);
  return result.insertId;
}

async function finishPipelineRun(runId, { status, log, commitSha, errorMessage }) {
  await db.query(
    `UPDATE pipeline_runs SET status = ?, log = ?, commit_sha = ?, error_message = ?, finished_at = NOW() WHERE id = ?`,
    [status, log || null, commitSha || null, errorMessage || null, runId]
  );
}

async function markSessionFailed(sessionId) {
  await db.query(`UPDATE sessions SET status = 'failed', completed_at = NOW() WHERE id = ?`, [sessionId]);
}

async function markSessionCompleted(sessionId) {
  await db.query(`UPDATE sessions SET status = 'completed', completed_at = NOW() WHERE id = ?`, [sessionId]);
}

// --- code generation (two-step, non-tool-calling) -----------------------------

async function selectFilesToRead({ session, repo, branch, requirements, diff, fileListing, treeDir }) {
  const messages = buildFileSelectionMessages({ repo, branch, requirements, diff, fileListing });
  const reply = await runChatTurn({
    session,
    repo,
    coNumber: branch.coNumber,
    actingUserId: session.userId,
    messages,
    persistUserMessage: null,
    replyRole: 'system',
  });

  const selected = parseFilesNeeded(reply);
  if (selected === null) {
    throw makeCodegenError(`Model reply for file selection (expected a fenced "${FILES_NEEDED_TAG}" block) could not be parsed`);
  }

  for (const relPath of selected) {
    try {
      await fs.access(path.join(treeDir, relPath));
    } catch (err) {
      // Fails the whole run rather than silently dropping the path - a
      // hallucinated file path is exactly the kind of ambiguity this phase
      // fails closed on, same as Phase 3's unknown-duplicateOfRequirementId
      // case.
      throw makeCodegenError(`Model requested a file that does not exist in the working tree: ${relPath}`);
    }
  }
  return selected;
}

async function generateFileChanges({ session, repo, branch, requirements, diff, treeDir, selectedFiles }) {
  const fileContents = {};
  for (const relPath of selectedFiles) {
    fileContents[relPath] = await fs.readFile(path.join(treeDir, relPath), 'utf-8');
  }

  const messages = buildCodeChangesMessages({ repo, branch, requirements, diff, fileContents });
  const reply = await runChatTurn({
    session,
    repo,
    coNumber: branch.coNumber,
    actingUserId: session.userId,
    messages,
    persistUserMessage: null,
    replyRole: 'system',
  });

  const changes = parseFileChanges(reply);
  if (changes === null) {
    throw makeCodegenError(`Model reply for code changes (expected a fenced "${FILE_CHANGES_TAG}" block) could not be parsed`);
  }
  return changes;
}

// Paths were already validated as safe, repo-relative paths at parse time
// (pipelineResponseParsing.js) - by the time this runs, path.join(treeDir,
// change.path) cannot escape treeDir.
async function applyChangesToWorkingTree(treeDir, changes) {
  for (const change of changes) {
    const target = path.join(treeDir, change.path);
    if (change.action === 'delete') {
      await fs.rm(target, { force: true });
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, change.content, 'utf-8');
  }
}

function buildCommitMessage({ coNumber, requirements }) {
  const bullets = requirements.map((r) => `- ${r}`).join('\n');
  return `Apex: implement requirements for ${coNumber}\n\n${bullets}`;
}

// --- orchestration -------------------------------------------------------------

async function runPipelineForSession(sessionId) {
  const ctx = await loadPipelineContext(sessionId);
  if (!ctx) {
    logger.error('pipeline: session not found after worker claimed it', { sessionId });
    return;
  }
  const { session, branch, repo } = ctx;
  const runId = await createPipelineRun(sessionId);
  let workDir = null;

  try {
    // Second of the two on-demand deletion checkpoints (the first is
    // Phase 2's branch-list render) - re-verify right before doing any work,
    // since queueing and worker pickup can be arbitrarily far apart in time.
    const exists = await branchExists({ owner: repo.githubOwner, repoName: repo.name, branch: branch.branchName });
    if (!exists) {
      await db.query("UPDATE branches SET status = 'deleted', last_checked_at = NOW() WHERE id = ?", [branch.id]);
      await markSessionFailed(sessionId);
      await finishPipelineRun(runId, {
        status: 'failed',
        errorMessage: 'Target branch no longer exists on GitHub - halted before starting work',
      });
      logger.warn('pipeline halted: branch deleted before pickup', {
        sessionId,
        branchId: branch.id,
        branchName: branch.branchName,
      });
      return;
    }

    const requirements = await getConfirmedRequirementsForSession(sessionId);
    if (requirements.length === 0) {
      throw new Error('No confirmed requirements found for this queued session');
    }

    const { workDir: dir, treeDir } = await downloadAndExtractTree({
      owner: repo.githubOwner,
      repoName: repo.name,
      ref: branch.branchName,
    });
    workDir = dir;

    // Fails loudly (PIPELINE_CONFIG_INVALID) if apex.pipeline.json is
    // missing or malformed - never an invented default build/test command.
    const config = await readPipelineConfig(treeDir);

    const diff = await getBranchDiffSummary({
      owner: repo.githubOwner,
      repoName: repo.name,
      base: repo.defaultBranchName,
      head: branch.branchName,
    });
    const fileListing = await listFilePaths(treeDir);

    const selectedFiles = await selectFilesToRead({ session, repo, branch, requirements, diff, fileListing, treeDir });
    const changes = await generateFileChanges({ session, repo, branch, requirements, diff, treeDir, selectedFiles });

    await applyChangesToWorkingTree(treeDir, changes);

    const containerName = `apex-pipeline-${sessionId}-${runId}`;
    const sandboxResult = await runSandbox({
      image: config.image,
      treeDir,
      buildCommand: config.buildCommand,
      testCommand: config.testCommand,
      timeoutSeconds: config.timeoutSeconds,
      containerName,
    });

    if (!sandboxResult.success) {
      const reason = sandboxResult.timedOut
        ? `Build/test timed out after ${config.timeoutSeconds}s`
        : `Build/test failed (exit code ${sandboxResult.exitCode})`;
      await markSessionFailed(sessionId);
      await finishPipelineRun(runId, { status: 'failed', log: sandboxResult.log, errorMessage: reason });
      logger.warn('pipeline sandbox run failed', { sessionId, reason });
      return;
    }

    const commitMessage = buildCommitMessage({ coNumber: branch.coNumber, requirements });
    const commitSha = await commitAndPushChanges({
      owner: repo.githubOwner,
      repoName: repo.name,
      branch: branch.branchName,
      changes,
      commitMessage,
    });

    await markSessionCompleted(sessionId);
    await finishPipelineRun(runId, { status: 'completed', log: sandboxResult.log, commitSha });
    logger.info('pipeline completed', { sessionId, commitSha });
  } catch (err) {
    logger.error('pipeline run failed', { sessionId, error: err.message });
    await markSessionFailed(sessionId).catch(() => {});
    await finishPipelineRun(runId, { status: 'failed', errorMessage: err.message }).catch(() => {});
  } finally {
    if (workDir) await cleanupWorkingTree(workDir);
  }
}

module.exports = { runPipelineForSession };
