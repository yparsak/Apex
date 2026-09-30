// Orchestrates one queued session's full pipeline: clone -> codegen -> build
// -> test -> push (see notes.md / ROADMAP.md Phase 7). Invoked by worker.js
// for a single session at a time.
const db = require('../db');
const auditLog = require('../auditLog');
const lockService = require('../lockService');
const githubApi = require('../github/githubApi');
const { getCloneOnlyToken } = require('../github/githubAppAuth');
const dockerRunner = require('../docker/dockerRunner');
const pipelineConfig = require('./pipelineConfig');
const codegenService = require('./codegenService');
const pushService = require('./pushService');
const requirementsLogService = require('../documents/requirementsLogService');

const WORKSPACE = '/workspace';
const SANDBOX_NETWORK = process.env.SANDBOX_NETWORK || 'apex-net';
const STEP_TIMEOUT_MS = Number(process.env.PIPELINE_STEP_TIMEOUT_MS || 10 * 60 * 1000);
const MAX_LOG_CHARS = 50000;

function truncate(text) {
  return text.length > MAX_LOG_CHARS ? `${text.slice(0, MAX_LOG_CHARS)}\n...[truncated]` : text;
}

function redactToken(text, token) {
  return token ? text.split(token).join('***') : text;
}

async function loadContext(sessionId) {
  const [[session]] = await db.query('SELECT * FROM sessions WHERE id = ?', [sessionId]);
  const [[branch]] = await db.query('SELECT * FROM branches WHERE id = ?', [session.branch_id]);
  const [[repo]] = await db.query(
    'SELECT r.*, rg.org_id AS org_id FROM repos r JOIN repo_groups rg ON rg.id = r.repo_group_id WHERE r.id = ?',
    [branch.repo_id]
  );
  const [[org]] = await db.query('SELECT * FROM orgs WHERE id = ?', [repo.org_id]);
  const [requirements] = await db.query(
    "SELECT requirement_text FROM session_requirements WHERE session_id = ? AND confirm_status = 'confirmed_proceed' ORDER BY id ASC",
    [sessionId]
  );
  return { session, branch, repo, org, requirements };
}

async function createRun(sessionId) {
  const [[{ attempts }]] = await db.query('SELECT COUNT(*) AS attempts FROM pipeline_runs WHERE session_id = ?', [
    sessionId,
  ]);
  const [result] = await db.query('INSERT INTO pipeline_runs (session_id, attempt_number, status) VALUES (?, ?, ?)', [
    sessionId,
    attempts + 1,
    'running',
  ]);
  return result.insertId;
}

async function setStage(runId, stage) {
  await db.query('UPDATE pipeline_runs SET stage = ? WHERE id = ?', [stage, runId]);
}

async function setContainerId(runId, containerId) {
  await db.query('UPDATE pipeline_runs SET container_id = ? WHERE id = ?', [containerId, runId]);
}

async function completeRun(runId, { commitSha, buildLog, testLog }) {
  await db.query(
    'UPDATE pipeline_runs SET status = ?, commit_sha = ?, build_log = ?, test_log = ?, container_id = NULL WHERE id = ?',
    ['completed', commitSha, buildLog, testLog, runId]
  );
}

async function failRun(runId, { buildLog, testLog, errorMessage }) {
  await db.query('UPDATE pipeline_runs SET status = ?, build_log = ?, test_log = ?, error_message = ? WHERE id = ?', [
    'failed',
    buildLog || null,
    testLog || null,
    errorMessage || null,
    runId,
  ]);
}

// A retry (see ROADMAP.md Phase 8) re-queues the same session for a full
// from-scratch re-run - this abandons any earlier attempt's kept-alive
// container (see ROADMAP.md Phase 7) rather than reusing it, since nothing
// from a failed pipeline_runs row carries over. Best-effort: a container
// that's already gone (e.g. manually cleaned up) shouldn't fail the retry.
async function cleanupPriorContainers(sessionId) {
  const [rows] = await db.query('SELECT id, container_id FROM pipeline_runs WHERE session_id = ? AND container_id IS NOT NULL', [
    sessionId,
  ]);
  for (const row of rows) {
    await dockerRunner.removeContainer(row.container_id).catch(() => {});
    await db.query('UPDATE pipeline_runs SET container_id = NULL WHERE id = ?', [row.id]);
  }
}

// run(sessionId) - never throws; failures are recorded on the session/run
// rows and swallowed so worker.js's poll loop keeps going.
async function run(sessionId) {
  let session, branch, repo, org, requirements, runId;
  try {
    ({ session, branch, repo, org, requirements } = await loadContext(sessionId));
    runId = await createRun(sessionId);
    await db.query("UPDATE sessions SET status = 'running' WHERE id = ?", [sessionId]);
  } catch (err) {
    // Couldn't even start bookkeeping for this session - still must move it
    // out of 'queued', or worker.js's poll loop would retry the same broken
    // session forever.
    await db.query("UPDATE sessions SET status = 'failed' WHERE id = ?", [sessionId]).catch(() => {});
    console.error(`[pipelineRunner] failed to start session ${sessionId}:`, err);
    return;
  }

  let containerId = null;
  try {
    // A prior failed attempt on this same session (see ROADMAP.md Phase 8's
    // retry-on-failure) left its container kept alive - this run abandons it
    // rather than resuming it, so clean it up before doing anything else.
    await cleanupPriorContainers(sessionId);

    // Branch-existence re-check at session start (see ROADMAP.md Phase 7) -
    // another engineer or admin may have deleted the branch on GitHub since
    // it was created.
    const ghBranch = await githubApi.getBranch(org.name, repo.name, branch.branch_name);
    if (!ghBranch) {
      await db.query("UPDATE branches SET status = 'deleted' WHERE id = ?", [branch.id]);
      throw new Error(`Branch ${branch.branch_name} no longer exists on GitHub.`);
    }

    const config = await pipelineConfig.fetchPipelineConfig(org, repo, branch);

    await setStage(runId, 'cloning');
    containerId = await dockerRunner.createContainer(config.image, SANDBOX_NETWORK);
    await setContainerId(runId, containerId);

    const cloneToken = await getCloneOnlyToken();
    const cloneUrl = `https://x-access-token:${cloneToken}@github.com/${org.name}/${repo.name}.git`;
    const cloneResult = await dockerRunner.exec(containerId, [
      'git',
      'clone',
      '--branch',
      branch.branch_name,
      '--single-branch',
      cloneUrl,
      WORKSPACE,
    ]);
    if (cloneResult.code !== 0) {
      throw new Error(`Clone failed: ${redactToken(cloneResult.stderr, cloneToken)}`);
    }

    await setStage(runId, 'codegen');
    await dockerRunner.exec(containerId, ['git', '-C', WORKSPACE, 'config', 'user.email', 'apex-bot@local']);
    await dockerRunner.exec(containerId, ['git', '-C', WORKSPACE, 'config', 'user.name', 'Apex']);

    const requirementsText = requirements.map((r) => `- ${r.requirement_text}`).join('\n');
    await codegenService.runCodegen({ containerId, org, repo, branch, repoRoot: WORKSPACE, requirementsText });

    const commitResult = await dockerRunner.exec(containerId, [
      'sh',
      '-c',
      `cd ${WORKSPACE} && git add -A && git commit -m "Apex: CO ${branch.co_number}"`,
    ]);
    if (commitResult.code !== 0) {
      throw new Error(`Codegen produced no committable changes: ${(commitResult.stderr || commitResult.stdout).trim()}`);
    }

    // Seal the sandbox before build/test run (see ROADMAP.md Phase 7) - no
    // registry egress once codegen's model-adapter calls are done.
    await dockerRunner.disconnectNetwork(containerId, SANDBOX_NETWORK);

    await setStage(runId, 'building');
    const buildResult = await dockerRunner.exec(containerId, ['sh', '-c', `cd ${WORKSPACE} && ${config.buildCommand}`], {
      timeoutMs: STEP_TIMEOUT_MS,
    });
    const buildLog = truncate(buildResult.stdout + buildResult.stderr);
    if (buildResult.code !== 0) {
      const err = new Error('Build failed.');
      err.buildLog = buildLog;
      throw err;
    }

    await setStage(runId, 'testing');
    const testResult = await dockerRunner.exec(containerId, ['sh', '-c', `cd ${WORKSPACE} && ${config.testCommand}`], {
      timeoutMs: STEP_TIMEOUT_MS,
    });
    const testLog = truncate(testResult.stdout + testResult.stderr);
    if (testResult.code !== 0) {
      const err = new Error('Tests failed.');
      err.buildLog = buildLog;
      err.testLog = testLog;
      throw err;
    }

    await setStage(runId, 'pushing');
    const commitSha = await pushService.pushBranch({ containerId, workspacePath: WORKSPACE, org, repo, branch });

    // Requirements log update is synchronous and inline, not queued/cron'd
    // like the Spec/Communication Protocol doc (see ROADMAP.md Phase 8) -
    // and happens exactly once, since a session only ever reaches
    // 'completed' once in its lifetime.
    await requirementsLogService.recordCompletedSession({ repo, branch, session, requirements });

    await completeRun(runId, { commitSha, buildLog, testLog });
    await db.query("UPDATE sessions SET status = 'completed' WHERE id = ?", [sessionId]);
    await lockService.releaseLock(repo.id, branch.co_number, sessionId);
    await auditLog.logAction({ sessionId, userId: session.user_id, action: 'pipeline_completed', detail: { commitSha } });
    await dockerRunner.removeContainer(containerId);
  } catch (err) {
    // Container lifecycle on failure: kept alive, not torn down (see
    // ROADMAP.md Phase 7 / Phase 9's future resume-from-step retry) - only
    // the success path above removes it. The pipeline_locks row is likewise
    // left held; this session still occupies the (repo, CO) slot until it
    // succeeds or a later phase's retry/abandon logic releases it.
    await failRun(runId, { buildLog: err.buildLog, testLog: err.testLog, errorMessage: err.message });
    await db.query("UPDATE sessions SET status = 'failed' WHERE id = ?", [sessionId]);
    await auditLog.logAction({ sessionId, userId: session.user_id, action: 'pipeline_failed', detail: err.message });
  }
}

module.exports = { run };
