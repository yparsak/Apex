// Trunk-staleness scan for the Spec/Communication Protocol doc (see
// ROADMAP.md Phase 8). Decoupled from worker.js's AI-pipeline poll loop -
// driven by a nightly, one-shot cron invocation (see docWorker.js,
// ROADMAP.md Phase 15) so a backlog of queued AI sessions can't delay doc
// regeneration, or vice versa.
const db = require('../db');
const githubApi = require('../github/githubApi');
const repoMap = require('../repoMap');
const modelCatalog = require('../model/modelCatalog');
const { processLogger } = require('../logger');

// scanForStaleRepos() - for every repo, compares its default branch's
// current HEAD sha on GitHub to repos.spec_doc_synced_commit_sha (NULL counts
// as stale - no doc has ever been generated). Enqueues a spec_doc_jobs row
// only if trunk actually moved and no queued/running job already covers it.
async function scanForStaleRepos() {
  // Spec-doc regen is repo-level with no requesting user to attribute it to, so
  // it uses the admin-configured spec-doc model, falling back to the catalog
  // default when that is unset or no longer usable (see ROADMAP.md Phase 22).
  // Resolved once here and stamped on every job this scan enqueues, rather than
  // read at drain time - see the note in docService.generateForRepo. With
  // no enabled model there is nothing a queued job could ever run against, so
  // enqueueing one would only bank work that fails; the next nightly scan
  // re-finds the same stale repos once an admin has added a model.
  const { model, usedFallback } = await modelCatalog.resolveForSpecDocs();
  if (!model) {
    processLogger().warn('spec-doc scan skipped: no enabled model in the catalog');
    return;
  }
  if (usedFallback) {
    // Worth a line: the admin picked a model for this job and is silently not
    // getting it, which is otherwise only visible on the admin screen.
    processLogger().warn(
      { model: model.model_id },
      'configured spec-doc model is missing or disabled - falling back to the catalog default'
    );
  }

  const [repos] = await db.query(
    `SELECT r.id, r.name, r.default_branch_name, r.spec_doc_synced_commit_sha, o.name AS org_name
     FROM repos r
     JOIN repo_groups rg ON rg.id = r.repo_group_id
     JOIN orgs o ON o.id = rg.org_id`
  );

  for (const repo of repos) {
    let branch;
    try {
      branch = await githubApi.getBranch(repo.org_name, repo.name, repo.default_branch_name);
    } catch (err) {
      continue; // can't reach GitHub for this repo right now - try again next scan
    }
    if (!branch) continue; // default branch itself missing - nothing to summarize

    const trunkSha = branch.commit.sha;
    if (trunkSha === repo.spec_doc_synced_commit_sha) continue; // already up to date

    const [[pending]] = await db.query(
      "SELECT id FROM spec_doc_jobs WHERE repo_id = ? AND status IN ('queued', 'running')",
      [repo.id]
    );
    if (pending) continue; // already covered by an in-flight job

    await db.query('INSERT INTO spec_doc_jobs (repo_id, status, trunk_commit_sha, model) VALUES (?, ?, ?, ?)', [
      repo.id,
      'queued',
      trunkSha,
      model.model_id,
    ]);
  }

  // Phase 20's file maps ride this scanner rather than inventing a second
  // schedule: rebuild is already handled by the (repo_id, commit_sha) key -
  // a moved trunk simply misses the cache - so the only thing left to do on a
  // timer is retire maps for shas nobody reads any more. Failure here is not
  // worth failing the scan over; a map table that grows a little is harmless.
  try {
    const removed = await repoMap.pruneUnused();
    if (removed) processLogger().info({ removed }, 'pruned unused repo file maps');
  } catch (err) {
    processLogger().error({ err }, 'repo file map prune failed');
  }
}

module.exports = { scanForStaleRepos };
