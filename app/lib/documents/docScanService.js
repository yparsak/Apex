// Trunk-staleness scan for every enabled document type (see ROADMAP.md
// Phase 8, generalized in Phase 23). Decoupled from worker.js's AI-pipeline
// poll loop - driven by a nightly, one-shot cron invocation (see docWorker.js,
// ROADMAP.md Phase 15) so a backlog of queued AI sessions can't delay doc
// regeneration, or vice versa.
const db = require('../db');
const githubApi = require('../github/githubApi');
const modelCatalog = require('../model/modelCatalog');
const docSettings = require('./docSettings');
const { processLogger } = require('../logger');

// resolvePlans() - one { docType, model } per enabled type, with its model
// resolved once for the whole scan and stamped on every job it enqueues rather
// than read at drain time (see the note in docService.generateForJob).
//
// A type with no model available is dropped from the scan rather than queued:
// with no enabled model there is nothing a queued job could ever run against,
// so enqueueing one would only bank work that fails. The next nightly scan
// re-finds the same stale repos once an admin has added a model.
async function resolvePlans() {
  const plans = [];
  for (const docType of await docSettings.listEnabled()) {
    const { model, usedFallback } = await modelCatalog.resolveForDocType(docType.key);
    if (!model) {
      processLogger().warn({ docType: docType.key }, 'doc scan skipped for type: no enabled model in the catalog');
      continue;
    }
    if (usedFallback) {
      // Worth a line: the admin picked a model for this type and is silently
      // not getting it, which is otherwise only visible on the admin screen.
      processLogger().warn(
        { docType: docType.key, model: model.model_id },
        'configured model for this document type is missing or disabled - falling back to the catalog default'
      );
    }
    plans.push({ docType, model });
  }
  return plans;
}

// scanForStaleRepos() - for every repo, compares its default branch's current
// HEAD sha on GitHub to each enabled type's repo_doc_sync row (a missing row
// counts as stale - that document has never been generated). Enqueues a
// doc_jobs row only if trunk actually moved and no queued/running job already
// covers that (repo, type).
async function scanForStaleRepos() {
  const plans = await resolvePlans();
  if (!plans.length) {
    processLogger().info('doc scan skipped: no document type is both enabled and runnable');
    return;
  }

  const [repos] = await db.query(
    `SELECT r.id, r.name, r.default_branch_name, o.name AS org_name
     FROM repos r
     JOIN repo_groups rg ON rg.id = r.repo_group_id
     JOIN orgs o ON o.id = rg.org_id`
  );

  for (const repo of repos) {
    // Once per repo, NOT once per (repo x type): every enabled type compares
    // against the same trunk head, so looping types around this call would
    // multiply GitHub traffic by the number of types for an identical answer.
    let branch;
    try {
      branch = await githubApi.getBranch(repo.org_name, repo.name, repo.default_branch_name);
    } catch (err) {
      continue; // can't reach GitHub for this repo right now - try again next scan
    }
    if (!branch) continue; // default branch itself missing - nothing to summarize

    const trunkSha = branch.commit.sha;

    const [syncRows] = await db.query('SELECT doc_type, synced_commit_sha FROM repo_doc_sync WHERE repo_id = ?', [
      repo.id,
    ]);
    const syncedByType = Object.fromEntries(syncRows.map((r) => [r.doc_type, r.synced_commit_sha]));

    for (const { docType, model } of plans) {
      if (syncedByType[docType.key] === trunkSha) continue; // already up to date

      const [[pending]] = await db.query(
        "SELECT id FROM doc_jobs WHERE repo_id = ? AND doc_type = ? AND status IN ('queued', 'running')",
        [repo.id, docType.key]
      );
      if (pending) continue; // already covered by an in-flight job

      await db.query(
        'INSERT INTO doc_jobs (repo_id, doc_type, status, trunk_commit_sha, model) VALUES (?, ?, ?, ?, ?)',
        [repo.id, docType.key, 'queued', trunkSha, model.model_id]
      );
    }
  }
}

module.exports = { scanForStaleRepos };
