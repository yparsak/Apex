// Small shared DOM/string helpers reused across page scripts (repos.js,
// branches.js). Kept separate from api-client.js since escaping rendered
// text isn't an API-communication concern.

window.ApexDom = {
  escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value === null || value === undefined ? '' : String(value);
    return div.innerHTML;
  },
};
