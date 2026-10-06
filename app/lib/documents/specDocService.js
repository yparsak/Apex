// Generates the Spec/Communication Protocol doc: a repo-level (co_number=''
// sentinel) document, fully regenerated each time trunk moves rather than
// incrementally patched (see ROADMAP.md Phase 8). Drained by
// specDocWorker.js, not worker.js - see specDocScanService.js for why.
const db = require('../db');
const githubApi = require('../github/githubApi');
const modelAdapter = require('../model/modelAdapter');
const usageService = require('../model/usageService');
const { processLogger } = require('../logger');

const MAX_TREE_PATHS = 500;
const MAX_FILE_CHARS = 8000;
const KEY_FILES = ['README.md', 'package.json', 'apex.pipeline.json'];

const SYSTEM_PROMPT = [
  "You are Apex's documentation agent. Write a concise Spec / Communication Protocol",
  'document for this repo, for engineers on other teams who integrate with it but do not',
  "work in its codebase day to day. Cover what the repo does, its overall structure, how",
  'to build/test/run it, and its integration surface (APIs it exposes, services it',
  'depends on, message formats) - whatever is actually evident from the material below.',
  'Do not invent details that are not supported by it.',
  '',
  'Respond with the complete document in Markdown, and nothing else.',
].join('\n');

async function buildContext(org, repo, branchName) {
  let tree = [];
  try {
    tree = (await githubApi.getTree(org.name, repo.name, branchName)).slice(0, MAX_TREE_PATHS);
  } catch (err) {
    // degrade to no tree context rather than blocking doc generation
  }

  const fileBlocks = [];
  for (const path of KEY_FILES) {
    if (!tree.includes(path)) continue;
    try {
      const content = await githubApi.getFileContent(org.name, repo.name, path, branchName);
      if (content !== null) fileBlocks.push(`=== ${path} ===\n${content.slice(0, MAX_FILE_CHARS)}`);
    } catch (err) {
      // skip a file that failed to fetch rather than blocking doc generation
    }
  }

  return `=== FILE TREE ===\n${tree.length ? tree.join('\n') : '(tree unavailable)'}\n\n${fileBlocks.join('\n\n')}`;
}

async function generateForRepo(job) {
  const [[repo]] = await db.query(
    `SELECT r.*, o.name AS org_name FROM repos r
     JOIN repo_groups rg ON rg.id = r.repo_group_id
     JOIN orgs o ON o.id = rg.org_id
     WHERE r.id = ?`,
    [job.repo_id]
  );
  const org = { name: repo.org_name };

  const context = await buildContext(org, repo, repo.default_branch_name);
  const result = await modelAdapter.generate([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: context },
  ]);
  const content = result.text;
  // Repo-level doc regen has no session to attribute to (see ROADMAP.md
  // Phase 8) - sessionId is null, same as every other repo-wide, not
  // per-CO, record in this codebase.
  usageService
    .recordUsage({
      callSite: 'spec_doc',
      sessionId: null,
      repoId: repo.id,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
    })
    .catch(() => {});

  await db.query(
    `INSERT INTO repo_documents (repo_id, doc_type, co_number, content) VALUES (?, 'spec_communication_protocol', '', ?)
     ON DUPLICATE KEY UPDATE content = VALUES(content)`,
    [repo.id, content]
  );
  await db.query('UPDATE repos SET spec_doc_synced_commit_sha = ? WHERE id = ?', [job.trunk_commit_sha, repo.id]);
}

// drainQueuedJobs() - processes every currently-queued job, one at a time,
// each in its own try/catch so one repo's failure doesn't stop the rest.
async function drainQueuedJobs() {
  const [jobs] = await db.query("SELECT * FROM spec_doc_jobs WHERE status = 'queued' ORDER BY id ASC");
  for (const job of jobs) {
    await db.query("UPDATE spec_doc_jobs SET status = 'running' WHERE id = ?", [job.id]);
    try {
      await generateForRepo(job);
      await db.query("UPDATE spec_doc_jobs SET status = 'completed' WHERE id = ?", [job.id]);
    } catch (err) {
      await db.query("UPDATE spec_doc_jobs SET status = 'failed' WHERE id = ?", [job.id]);
      processLogger().error({ jobId: job.id, repoId: job.repo_id, err }, 'spec doc job failed');
    }
  }
}

module.exports = { drainQueuedJobs };
