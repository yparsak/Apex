// Clarification-session page behavior for a single branch. Starts/resumes
// the current user's session on this branch, renders the transcript plus
// the pending-confirmation and other-users'-sessions panels, and drives the
// message-send / requirement-resolve API calls. Follows the same
// ApexApi/ApexDom conventions as branches.js.

document.addEventListener('DOMContentLoaded', () => {
  const escapeHtml = window.ApexDom.escapeHtml;
  const repoId = document.body.dataset.repoId;
  const branchId = document.body.dataset.branchId;
  const basePath = `/api/repos/${repoId}/branches/${branchId}/sessions`;

  const errorBox = document.getElementById('session-error');
  const statusBanner = document.getElementById('session-status-banner');
  const transcriptEl = document.getElementById('transcript');
  const messageInput = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');
  const requirementsPanel = document.getElementById('requirements-panel');
  const pendingList = document.getElementById('pending-requirements');
  const finalizedPanel = document.getElementById('finalized-panel');
  const finalizedList = document.getElementById('finalized-requirements');
  const otherSessionsEl = document.getElementById('other-sessions');

  let sessionId = null;

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.remove('d-none');
  }

  function hideError() {
    errorBox.classList.add('d-none');
  }

  function statusVariant(status) {
    return { queued: 'info', running: 'secondary', completed: 'success', failed: 'danger' }[status] || 'secondary';
  }

  function renderStatusBanner(status) {
    if (status === 'queued') {
      statusBanner.className = 'alert alert-success';
      statusBanner.textContent = 'All requirements resolved - this session is queued for pickup.';
    } else {
      statusBanner.className = `alert alert-${statusVariant(status)}`;
      statusBanner.textContent = `Session status: ${status}`;
    }
    statusBanner.classList.remove('d-none');
  }

  function renderTranscript(conversations) {
    if (conversations.length === 0) {
      transcriptEl.innerHTML = '<p class="text-muted">No messages yet.</p>';
      return;
    }
    transcriptEl.innerHTML = conversations
      .map((c) => {
        const isUser = c.role === 'user';
        const label = isUser ? 'You' : 'Agent';
        const align = isUser ? 'text-end' : 'text-start';
        const bg = isUser ? 'bg-primary text-white' : 'bg-light';
        return `<div class="mb-2 ${align}">
          <div class="d-inline-block p-2 rounded ${bg}" style="max-width: 80%; white-space: pre-wrap; text-align: left;">
            <div class="small fw-bold mb-1">${label}</div>${escapeHtml(c.content)}
          </div>
        </div>`;
      })
      .join('');
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  function renderRequirements(requirements) {
    const pending = requirements.filter((r) => r.resolutionStatus === 'pending_confirm');
    const decided = requirements.filter((r) => r.resolutionStatus === 'confirmed_proceed' || r.resolutionStatus === 'confirmed_skip');

    requirementsPanel.classList.toggle('d-none', pending.length === 0);
    pendingList.innerHTML = pending
      .map(
        (r) => `
        <li class="list-group-item" data-requirement-id="${r.id}">
          <p class="mb-2">${escapeHtml(r.content)}</p>
          ${
            r.overlapFlagRequirementId
              ? `<p class="small text-muted mb-2">Possible overlap with an already-agreed requirement (id ${r.overlapFlagRequirementId}) on this branch.</p>`
              : ''
          }
          <button type="button" class="btn btn-sm btn-success me-2 proceed-btn" data-requirement-id="${r.id}">Proceed anyway</button>
          <button type="button" class="btn btn-sm btn-outline-secondary skip-btn" data-requirement-id="${r.id}">Skip</button>
        </li>`
      )
      .join('');

    pendingList
      .querySelectorAll('.proceed-btn')
      .forEach((btn) => btn.addEventListener('click', () => resolveRequirement(Number(btn.dataset.requirementId), 'confirmed_proceed')));
    pendingList
      .querySelectorAll('.skip-btn')
      .forEach((btn) => btn.addEventListener('click', () => resolveRequirement(Number(btn.dataset.requirementId), 'confirmed_skip')));

    finalizedPanel.classList.toggle('d-none', decided.length === 0);
    finalizedList.innerHTML = decided
      .map((r) => {
        const variant = r.resolutionStatus === 'confirmed_proceed' ? 'success' : 'secondary';
        return `<li class="list-group-item d-flex justify-content-between align-items-start">
          <span>${escapeHtml(r.content)}</span>
          <span class="badge bg-${variant}">${escapeHtml(r.resolutionStatus)}</span>
        </li>`;
      })
      .join('');
  }

  function renderOtherSessions(otherSessions) {
    if (otherSessions.length === 0) {
      otherSessionsEl.innerHTML = '<li class="list-group-item text-muted">No other sessions on this branch.</li>';
      return;
    }
    otherSessionsEl.innerHTML = otherSessions
      .map((s) => {
        const reqList =
          s.requirements.length === 0
            ? '<span class="text-muted">No requirements submitted yet.</span>'
            : `<ul class="mb-0 ps-3">${s.requirements
                .map((r) => `<li>${escapeHtml(r.content)} <span class="badge bg-light text-dark border">${escapeHtml(r.resolutionStatus || 'undecided')}</span></li>`)
                .join('')}</ul>`;
        return `<li class="list-group-item">
          <div class="d-flex justify-content-between align-items-center mb-1">
            <strong>${escapeHtml(s.initials)}</strong>
            <span class="badge bg-${statusVariant(s.status)}">${escapeHtml(s.status)}</span>
          </div>
          ${reqList}
        </li>`;
      })
      .join('');
  }

  function renderDetail(detail) {
    sessionId = detail.session.id;
    renderStatusBanner(detail.session.status);
    renderTranscript(detail.conversations);
    renderRequirements(detail.requirements);
    renderOtherSessions(detail.otherSessions);
  }

  async function loadOrStartSession() {
    hideError();
    try {
      const detail = await window.ApexApi.post(basePath);
      renderDetail(detail);
    } catch (err) {
      showError(err.message || 'Failed to start or resume session');
    }
  }

  async function refreshSession() {
    try {
      const detail = await window.ApexApi.get(`${basePath}/${sessionId}`);
      renderDetail(detail);
    } catch (err) {
      showError(err.message || 'Failed to refresh session');
    }
  }

  async function sendMessage() {
    const message = messageInput.value.trim();
    if (!message) return;
    hideError();
    sendBtn.disabled = true;
    try {
      await window.ApexApi.post(`${basePath}/${sessionId}/messages`, { message });
      messageInput.value = '';
      await refreshSession();
    } catch (err) {
      showError(err.message || 'Failed to send message');
    } finally {
      sendBtn.disabled = false;
    }
  }

  async function resolveRequirement(requirementId, resolution) {
    hideError();
    try {
      await window.ApexApi.post(`${basePath}/${sessionId}/requirements/${requirementId}/resolve`, { resolution });
      await refreshSession();
    } catch (err) {
      showError(err.message || 'Failed to resolve requirement');
    }
  }

  sendBtn.addEventListener('click', sendMessage);
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  loadOrStartSession();
});
