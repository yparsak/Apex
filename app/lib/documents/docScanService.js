// Staleness scan for every active document definition (see ROADMAP.md Phase 8,
// generalized in Phase 23, admin-defined in Phase 24). Decoupled from
// worker.js's AI-pipeline poll loop - driven by a nightly, one-shot cron
// invocation (see docWorker.js, ROADMAP.md Phase 15) so a backlog of queued AI
// sessions can't delay doc regeneration, or vice versa.
const db = require('../db');
const githubApi = require('../github/githubApi');
const modelCatalog = require('../model/modelCatalog');
const docDefinitions = require('./docDefinitions');
const { processLogger } = require('../logger');

// resolvePlans() - one { definition, model } per active definition, with its
// model resolved once for the whole scan and stamped on every job it enqueues
// rather than read at drain time (see the note in docService.generateForJob).
//
// A definition with no model available is dropped from the scan rather than
// queued: with no enabled model there is nothing a queued job could ever run
// against, so enqueueing one would only bank work that fails. The next nightly
// scan re-finds the same stale repos once an admin has added a model.
async function resolvePlans() {
  const plans = [];
  for (const definition of await docDefinitions.listActive()) {
    const { model, usedFallback } = await modelCatalog.resolveForDocDefinition(definition);
    if (!model) {
      processLogger().warn(
        { docType: definition.doc_key },
        'doc scan skipped for this document: no enabled model in the catalog'
      );
      continue;
    }
    if (usedFallback) {
      // Worth a line: the admin picked a model for this document and is
      // silently not getting it, which is otherwise only visible on the admin
      // screen.
      processLogger().warn(
        { docType: definition.doc_key, model: model.model_id },
        'configured model for this document is missing or disabled - falling back to the catalog default'
      );
    }
    plans.push({ definition, model });
  }
  return plans;
}

// scanForStaleRepos() - for every repo, compares its default branch's current
// HEAD sha AND each active definition's prompt_revision against that
// definition's repo_doc_sync row (a missing row counts as stale - that document
// has never been generated). Enqueues a doc_jobs row only if something actually
// moved and no queued/running job already covers that (repo, definition).
async function scanForStaleRepos() {
  const plans = await resolvePlans();
  if (!plans.length) {
    processLogger().info('doc scan skipped: no document is both active and runnable');
    return;
  }

  const [repos] = await db.query(
    `SELECT r.id, r.name, r.default_branch_name, o.name AS org_name
     FROM repos r
     JOIN repo_groups rg ON rg.id = r.repo_group_id
     JOIN orgs o ON o.id = rg.org_id`
  );

  for (const repo of repos) {
    // Once per repo, NOT once per (repo x definition): every definition
    // compares against the same trunk head, so looping definitions around this
    // call would multiply GitHub traffic by the number of definitions for an
    // identical answer.
    let branch;
    try {
      branch = await githubApi.getBranch(repo.org_name, repo.name, repo.default_branch_name);
    } catch (err) {
      continue; // can't reach GitHub for this repo right now - try again next scan
    }
    if (!branch) continue; // default branch itself missing - nothing to summarize

    const trunkSha = branch.commit.sha;

    const [syncRows] = await db.query(
      'SELECT doc_type, synced_commit_sha, synced_prompt_revision FROM repo_doc_sync WHERE repo_id = ?',
      [repo.id]
    );
    const syncedByType = Object.fromEntries(syncRows.map((r) => [r.doc_type, r]));

    for (const { definition, model } of plans) {
      const synced = syncedByType[definition.doc_key];
      // Two reasons to regenerate, not one. Trunk moving is the original
      // (Phase 8); a prompt edit is the new one, and it has to be here because
      // editing a prompt moves nothing in git - without this an admin fixes a
      // prompt, sees nothing change for weeks, and concludes the feature is
      // broken. Regeneration is deliberately not immediate: it rides the next
      // nightly run like everything else.
      const upToDate =
        synced &&
        synced.synced_commit_sha === trunkSha &&
        synced.synced_prompt_revision === definition.prompt_revision;
      if (upToDate) continue;

      const [[pending]] = await db.query(
        "SELECT id FROM doc_jobs WHERE repo_id = ? AND doc_type = ? AND status IN ('queued', 'running')",
        [repo.id, definition.doc_key]
      );
      if (pending) continue; // already covered by an in-flight job

      await db.query(
        'INSERT INTO doc_jobs (repo_id, doc_type, status, trunk_commit_sha, model) VALUES (?, ?, ?, ?, ?)',
        [repo.id, definition.doc_key, 'queued', trunkSha, model.model_id]
      );
    }
  }
}

module.exports = { scanForStaleRepos };
