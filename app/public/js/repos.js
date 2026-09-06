// Repo list page behavior - fetches the repos the current user has access
// to (GET /api/repos) and renders links into each repo's branch-selection
// page.

document.addEventListener('DOMContentLoaded', async () => {
  const listEl = document.getElementById('repo-list');
  const errorBox = document.getElementById('repo-error');
  const escapeHtml = window.ApexDom.escapeHtml;

  try {
    const { repos } = await window.ApexApi.get('/api/repos');

    if (repos.length === 0) {
      listEl.innerHTML = '<p class="text-muted">No repos available yet. Ask an admin to grant you access.</p>';
      return;
    }

    listEl.innerHTML = repos
      .map(
        (repo) => `
          <a href="/repos/${repo.id}/branches" class="list-group-item list-group-item-action d-flex justify-content-between align-items-center">
            <span>${escapeHtml(repo.name)}</span>
            <small class="text-muted">${escapeHtml(repo.repoGroupName)}</small>
          </a>`
      )
      .join('');
  } catch (err) {
    errorBox.textContent = `Failed to load repos: ${err.message}`;
    errorBox.classList.remove('d-none');
    listEl.innerHTML = '';
  }
});
