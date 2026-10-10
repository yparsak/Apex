// Generates admin-defined, repo-level documents (co_number='' sentinel), fully
// regenerated each time trunk moves or the prompt changes rather than
// incrementally patched (see ROADMAP.md Phase 8, Phase 24). Drained by
// docWorker.js, not worker.js - see docScanService.js for why.
//
// Everything document-specific - what the prompt says, what the document is
// called - is a doc_definitions row (see docDefinitions.js). What the model
// READS is not: one shared context builder serves every definition
// (docContext.js). What stays here is the job mechanics every document shares:
// model resolution, the generate call, the usage_events write, the
// repo_documents upsert, the sync write, and the one-try/catch-per-job drain
// loop.
const db = require('../db');
const modelAdapter = require('../model/modelAdapter');
const usageService = require('../model/usageService');
const modelCatalog = require('../model/modelCatalog');
const docDefinitions = require('./docDefinitions');
const docContext = require('./docContext');
const { processLogger } = require('../logger');

async function generateForJob(job, definition) {
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
  // are NULL with nothing to backfill them from. Resolved BEFORE the context is
  // built so an unrunnable job fails without first paying for the GitHub tree
  // fetch and key-file reads. (pipelineRunner.resume has the same kind of
  // fallback for the same reason.)
  let model = job.model;
  if (!model) {
    const fallback = await modelCatalog.resolveDefault();
    if (!fallback) throw new Error('No enabled model is available to generate this document.');
    model = fallback.model_id;
  }

  const context = await docContext.build(org, repo, repo.default_branch_name);
  const result = await modelAdapter.generate(
    [
      // Verbatim. No house template wraps it, and neither the title nor the
      // description is interpolated into it (see ROADMAP.md Phase 24): the
      // field is called a prompt and an admin debugging a bad document has to
      // be able to see the exact text that was sent.
      { role: 'system', content: definition.model_prompt },
      { role: 'user', content: context },
    ],
    { model }
  );
  const content = result.text;
  // Repo-level doc regen has no session to attribute to (see ROADMAP.md
  // Phase 8) - sessionId is null, same as every other repo-wide, not
  // per-CO, record in this codebase.
  //
  // Derived from the key rather than stored per definition (Phase 23's spec
  // entry carried a literal 'spec_doc' call site to protect its spend history;
  // with no built-in types left there is no history to protect and a
  // hand-pickable call site would just be another immutable field to get
  // wrong).
  usageService
    .recordUsage({
      callSite: `doc:${definition.doc_key}`,
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
    [repo.id, definition.doc_key, content]
  );
  // Per (repo, definition), not per repo: two documents go stale independently,
  // and the single repos.spec_doc_synced_commit_sha column it replaced could
  // only ever track one of them (see ROADMAP.md Phase 23).
  //
  // The revision written is the one on the definition read at the TOP of this
  // drain pass, which is also the prompt that was just sent - the two always
  // agree because they come from the same row read. Stamping the revision the
  // job was QUEUED under would be wrong here: the prompt actually used is the
  // current one, so that is the one the sync row has to record.
  await db.query(
    `INSERT INTO repo_doc_sync (repo_id, doc_type, synced_commit_sha, synced_prompt_revision) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE synced_commit_sha = VALUES(synced_commit_sha),
       synced_prompt_revision = VALUES(synced_prompt_revision)`,
    [repo.id, definition.doc_key, job.trunk_commit_sha, definition.prompt_revision]
  );
}

// drainQueuedJobs() - processes every currently-queued job, one at a time,
// each in its own try/catch so one repo's failure doesn't stop the rest.
async function drainQueuedJobs() {
  const [jobs] = await db.query("SELECT * FROM doc_jobs WHERE status = 'queued' ORDER BY id ASC");
  if (!jobs.length) return;

  // Read once for the whole drain rather than per job: definitions cannot
  // change mid-drain (this is a one-shot process), and per-job reads would be
  // one query per queued job for an identical answer. Keyed by doc_key, which
  // is what doc_jobs.doc_type holds.
  const activeByKey = new Map((await docDefinitions.listActive()).map((d) => [d.doc_key, d]));

  for (const job of jobs) {
    const definition = activeByKey.get(job.doc_type);

    // A definition deactivated, archived, or never existing between the scan
    // that queued this job and now. Terminal 'skipped' rather than left
    // 'queued': a job left queued would silently run whenever the definition
    // is reactivated, generating against a trunk sha that may be months stale,
    // and the next scan after reactivating re-finds the repo anyway with the
    // current sha. Nothing is lost by dropping it, and a status an admin can
    // see beats a job that quietly resurrects.
    if (!definition) {
      await db.query("UPDATE doc_jobs SET status = 'skipped' WHERE id = ?", [job.id]);
      processLogger().info(
        { jobId: job.id, repoId: job.repo_id, docType: job.doc_type },
        'doc job skipped - document is inactive, deleted, or no longer defined'
      );
      continue;
    }

    await db.query("UPDATE doc_jobs SET status = 'running' WHERE id = ?", [job.id]);
    try {
      await generateForJob(job, definition);
      await db.query("UPDATE doc_jobs SET status = 'completed' WHERE id = ?", [job.id]);
    } catch (err) {
      await db.query("UPDATE doc_jobs SET status = 'failed' WHERE id = ?", [job.id]);
      processLogger().error({ jobId: job.id, repoId: job.repo_id, docType: job.doc_type, err }, 'doc job failed');
    }
  }
}

module.exports = { drainQueuedJobs };
