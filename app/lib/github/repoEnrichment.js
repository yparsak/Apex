// Best-effort GitHub enrichment for repo cards (collaborators, last-updated).
// Neither is stored in the schema - both are fetched live and degrade to
// empty/null on any failure (missing creds, insufficient App scope, etc.)
// rather than breaking the dashboard render.
const githubApi = require('./githubApi');
const { timeAgo } = require('../format');

async function enrichRepo(org, repo) {
  try {
    const [info, collaborators] = await Promise.all([
      githubApi.getRepo(org.name, repo.name),
      githubApi.listCollaborators(org.name, repo.name),
    ]);
    return {
      ...repo,
      updatedLabel: info ? timeAgo(info.pushed_at) : null,
      collaboratorLogins: collaborators.map((c) => c.login),
    };
  } catch (err) {
    return { ...repo, updatedLabel: null, collaboratorLogins: [] };
  }
}

module.exports = { enrichRepo };
