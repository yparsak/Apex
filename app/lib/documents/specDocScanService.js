// Trunk-staleness scan for the Spec/Communication Protocol doc (see
// ROADMAP.md Phase 8). Decoupled from worker.js's AI-pipeline poll loop -
// driven by a nightly, one-shot cron invocation (see specDocWorker.js,
// ROADMAP.md Phase 15) so a backlog of queued AI sessions can't delay doc
// regeneration, or vice versa.
const db = require('../db');
const githubApi = require('../github/githubApi');

// scanForStaleRepos() - for every repo, compares its default branch's
// current HEAD sha on GitHub to repos.spec_doc_synced_commit_sha (NULL counts
// as stale - no doc has ever been generated). Enqueues a spec_doc_jobs row
// only if trunk actually moved and no queued/running job already covers it.
async function scanForStaleRepos() {
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

    await db.query('INSERT INTO spec_doc_jobs (repo_id, status, trunk_commit_sha) VALUES (?, ?, ?)', [
      repo.id,
      'queued',
      trunkSha,
    ]);
  }
}

module.exports = { scanForStaleRepos };
