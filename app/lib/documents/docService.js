// Generates the Spec/Communication Protocol doc: a repo-level (co_number=''
// sentinel) document, fully regenerated each time trunk moves rather than
// incrementally patched (see ROADMAP.md Phase 8). Drained by
// docWorker.js, not worker.js - see docScanService.js for why.
const db = require('../db');
const modelAdapter = require('../model/modelAdapter');
const usageService = require('../model/usageService');
const modelCatalog = require('../model/modelCatalog');
const repoContext = require('../repoContext');
const { processLogger } = require('../logger');

// A hardcoded allowlist, which is why this doc is thin for a large repo - it
// is written from packaging metadata and a readme. Phase 20's size-aware map
// makes a map-driven selection possible here, but doing it changes generated
// doc content, which is Phase 15's concern and wants its own before/after
// review (see ROADMAP.md Phase 20).
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
  const tree = await repoContext.fetchTree(org, repo, branchName);

  // A key file clipped at the read cap is labelled as clipped, same as every
  // other reader (see ROADMAP.md Phase 19) - a doc written from the first 8000
  // characters of a long README, presented as the whole thing, describes a repo
  // that doesn't exist. A read that fails or comes back oversized is skipped
  // rather than blocking doc generation, which is this call site's existing
  // degrade-don't-block posture.
  const fileBlocks = [];
  for (const path of KEY_FILES) {
    if (!tree.paths.includes(path)) continue;
    const record = await repoContext.readFileForModel(org.name, repo.name, path, branchName);
    if (record.status !== 'ok') continue;
    fileBlocks.push(repoContext.formatFileForModel(path, record));
  }

  return `=== FILE TREE ===\n${repoContext.renderTree(tree)}\n\n${fileBlocks.join('\n\n')}`;
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

  // job.model is stamped when the job is enqueued (see docScanService.js),
  // not resolved here: the nightly scan and the drain are separate runs, and a
  // job must generate with the model it was queued under even if the catalog's
  // default changed in between.
  //
  // The fallback covers jobs enqueued before Phase 22 added this column, which
  // are NULL with nothing to backfill them from. Resolved BEFORE buildContext so
  // an unrunnable job fails without first paying for the GitHub tree fetch and
  // key-file reads. (pipelineRunner.resume has the same kind of fallback for the
  // same reason.)
  let model = job.model;
  if (!model) {
    const fallback = await modelCatalog.resolveDefault();
    if (!fallback) throw new Error('No enabled model is available to generate this document.');
    model = fallback.model_id;
  }

  const context = await buildContext(org, repo, repo.default_branch_name);
  const result = await modelAdapter.generate(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: context },
    ],
    { model }
  );
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
      price: result.price,
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
