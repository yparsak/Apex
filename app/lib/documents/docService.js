// Generates registry-driven, repo-level documents (co_number='' sentinel),
// fully regenerated each time trunk moves rather than incrementally patched
// (see ROADMAP.md Phase 8). Drained by docWorker.js, not worker.js - see
// docScanService.js for why.
//
// Everything type-specific - which files go into the prompt, what the prompt
// says, what the document is called - lives in docTypes.js (see ROADMAP.md
// Phase 23). What stays here is the job mechanics every type shares: model
// resolution, the generate call, the usage_events write, the repo_documents
// upsert, the sync-sha write, and the one-try/catch-per-job drain loop.
const db = require('../db');
const modelAdapter = require('../model/modelAdapter');
const usageService = require('../model/usageService');
const modelCatalog = require('../model/modelCatalog');
const docTypes = require('./docTypes');
const docSettings = require('./docSettings');
const { processLogger } = require('../logger');

async function generateForJob(job, docType) {
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

  const context = await docType.buildContext(org, repo, repo.default_branch_name);
  const result = await modelAdapter.generate(
    [
      { role: 'system', content: docType.systemPrompt },
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
      callSite: docType.callSite,
      sessionId: null,
      repoId: repo.id,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      price: result.price,
    })
    .catch(() => {});

  await db.query(
    `INSERT INTO repo_documents (repo_id, doc_type, co_number, content) VALUES (?, ?, '', ?)
     ON DUPLICATE KEY UPDATE content = VALUES(content)`,
    [repo.id, docType.docType, content]
  );
  // Per (repo, type), not per repo: two types go stale independently, and the
  // single repos.spec_doc_synced_commit_sha column it replaced could only ever
  // track one of them (see ROADMAP.md Phase 23).
  await db.query(
    `INSERT INTO repo_doc_sync (repo_id, doc_type, synced_commit_sha) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE synced_commit_sha = VALUES(synced_commit_sha)`,
    [repo.id, docType.key, job.trunk_commit_sha]
  );
}

// drainQueuedJobs() - processes every currently-queued job, one at a time,
// each in its own try/catch so one repo's failure doesn't stop the rest.
async function drainQueuedJobs() {
  const [jobs] = await db.query("SELECT * FROM doc_jobs WHERE status = 'queued' ORDER BY id ASC");
  if (!jobs.length) return;

  // Read once for the whole drain rather than per job: it cannot change
  // mid-drain (this is a one-shot process), and per-job reads would be one
  // query per queued job for an identical answer.
  const enabledKeys = new Set(await docSettings.getEnabledKeys());

  for (const job of jobs) {
    const docType = docTypes.get(job.doc_type);

    // A type disabled (or de-registered) between the scan that queued this job
    // and now. Terminal 'skipped' rather than left 'queued': a job left queued
    // would silently run whenever the type is re-enabled, generating against a
    // trunk sha that may be months stale, and the next scan after re-enabling
    // re-finds the repo anyway with the current sha. Nothing is lost by
    // dropping it, and a status an admin can see beats a job that quietly
    // resurrects.
    if (!docType || !enabledKeys.has(job.doc_type)) {
      await db.query("UPDATE doc_jobs SET status = 'skipped' WHERE id = ?", [job.id]);
      processLogger().info(
        { jobId: job.id, repoId: job.repo_id, docType: job.doc_type },
        'doc job skipped - document type is disabled or no longer registered'
      );
      continue;
    }

    await db.query("UPDATE doc_jobs SET status = 'running' WHERE id = ?", [job.id]);
    try {
      await generateForJob(job, docType);
      await db.query("UPDATE doc_jobs SET status = 'completed' WHERE id = ?", [job.id]);
    } catch (err) {
      await db.query("UPDATE doc_jobs SET status = 'failed' WHERE id = ?", [job.id]);
      processLogger().error({ jobId: job.id, repoId: job.repo_id, docType: job.doc_type, err }, 'doc job failed');
    }
  }
}

module.exports = { drainQueuedJobs };
