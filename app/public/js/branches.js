// Branch-selection page behavior for a single repo. Handles: fetching the
// on-demand-refreshed active-branch list (optionally CO-filtered), the
// mine/others secondary toggle (client-side, over already-fetched data),
// and resolving a CO - either continuing on an existing branch or creating
// the next available branch under the current user's own initials.

document.addEventListener('DOMContentLoaded', () => {
  const CO_PATTERN = /^C[0-9]{8}$/;
  const escapeHtml = window.ApexDom.escapeHtml;

  const repoId = document.body.dataset.repoId;
  const coInput = document.getElementById('co-input');
  const filterBtn = document.getElementById('filter-btn');
  const clearFilterBtn = document.getElementById('clear-filter-btn');
  const errorBox = document.getElementById('branch-error');
  const resultBox = document.getElementById('resolve-result');
  const rowsEl = document.getElementById('branch-rows');
  const createArea = document.getElementById('create-branch-area');
  const createBtn = document.getElementById('create-branch-btn');
  const ownerFilterRadios = document.getElementsByName('owner-filter');

  let currentBranches = [];
  let currentCo = '';

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.remove('d-none');
  }

  function hideMessages() {
    errorBox.classList.add('d-none');
    resultBox.classList.add('d-none');
  }

  function getOwnerFilter() {
    for (const radio of ownerFilterRadios) {
      if (radio.checked) return radio.value;
    }
    return 'all';
  }

  function sessionBadge(status) {
    if (!status) return '<span class="text-muted">&mdash;</span>';
    const variant = { queued: 'secondary', running: 'info', completed: 'success', failed: 'danger' }[status] || 'secondary';
    return `<span class="badge bg-${variant}">${escapeHtml(status)}</span>`;
  }

  function renderRows() {
    const ownerFilter = getOwnerFilter();
    const visible = currentBranches.filter((b) => (ownerFilter === 'mine' ? b.isMine : true));

    if (visible.length === 0) {
      rowsEl.innerHTML = '<tr><td colspan="6" class="text-muted">No active branches match.</td></tr>';
    } else {
      rowsEl.innerHTML = visible
        .map((b) => {
          const ownerLabel = b.isMine
            ? `<span class="badge bg-primary">You (${escapeHtml(b.initials)})</span>`
            : `<span class="badge bg-secondary">${escapeHtml(b.initials)}</span>`;
          const created = new Date(b.createdAt).toLocaleString();
          return `<tr>
            <td><code>${escapeHtml(b.branchName)}</code></td>
            <td>${escapeHtml(b.coNumber)}</td>
            <td>${ownerLabel}</td>
            <td>${sessionBadge(b.mySessionStatus)}</td>
            <td>${escapeHtml(created)}</td>
            <td><button type="button" class="btn btn-sm btn-outline-primary continue-btn" data-branch-id="${b.id}">Continue</button></td>
          </tr>`;
        })
        .join('');

      rowsEl.querySelectorAll('.continue-btn').forEach((btn) => {
        btn.addEventListener('click', () => resolveCo('continue', Number(btn.dataset.branchId)));
      });
    }

    createArea.classList.toggle('d-none', !currentCo);
  }

  async function loadBranches(co) {
    hideMessages();
    rowsEl.innerHTML = '<tr><td colspan="6" class="text-muted">Loading&hellip;</td></tr>';
    createArea.classList.add('d-none');

    const query = co ? `?co=${encodeURIComponent(co)}` : '';
    try {
      const data = await window.ApexApi.get(`/api/repos/${repoId}/branches${query}`);
      currentBranches = data.branches;
      currentCo = co || '';
      renderRows();
    } catch (err) {
      showError(err.message || 'Failed to load branches');
      rowsEl.innerHTML = '';
    }
  }

  async function resolveCo(action, branchId) {
    hideMessages();

    if (!CO_PATTERN.test(currentCo)) {
      showError('Enter a valid CO number (format C followed by 8 digits) before continuing or creating a branch.');
      return;
    }

    try {
      const data = await window.ApexApi.post(`/api/repos/${repoId}/resolve`, {
        coNumber: currentCo,
        action,
        branchId,
      });
      resultBox.textContent = `Resolved: ${data.branch.branchName} (CO ${data.changeOrder.coNumber})`;
      resultBox.classList.remove('d-none');
      await loadBranches(currentCo);
    } catch (err) {
      showError(err.message || 'Failed to resolve change order');
    }
  }

  filterBtn.addEventListener('click', () => {
    const co = coInput.value.trim().toUpperCase();
    if (co && !CO_PATTERN.test(co)) {
      showError('CO number must match format C followed by 8 digits (e.g. C12345678).');
      return;
    }
    loadBranches(co);
  });

  clearFilterBtn.addEventListener('click', () => {
    coInput.value = '';
    loadBranches('');
  });

  createBtn.addEventListener('click', () => resolveCo('create'));

  ownerFilterRadios.forEach((radio) => radio.addEventListener('change', renderRows));

  loadBranches('');
});
