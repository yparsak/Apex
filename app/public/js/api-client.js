// Centralized fetch wrapper for every browser-side call to Apex's JSON API.
// Every route responds with the { success, message, data } / { success:
// false, message, error } envelope - this is the one place that unwraps
// that envelope and normalizes a failure into a thrown Error, so page
// scripts (login.js, repos.js, branches.js) never duplicate response-
// parsing logic. Kept as its own module per the project's convention that
// API-communication code is a dedicated domain, not a shared-utility
// afterthought.

window.ApexApi = (function () {
  async function request(method, path, body) {
    const response = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const payload = await response.json();
    if (!payload.success) {
      const error = new Error(payload.message || 'Request failed');
      error.status = response.status;
      error.detail = payload.error;
      throw error;
    }
    return payload.data;
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
  };
})();
