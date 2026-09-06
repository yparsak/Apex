// Shared JSON response envelope helpers - { success, message, data } on
// success, { success: false, message, error } on failure - per the
// project's API design convention. Extracted from app/routes/auth.js once
// a second route file (Phase 2's repo/branch routes) needed the same
// shape, so it isn't duplicated per route file.

function sendSuccess(res, data, message = '') {
  return res.json({ success: true, message, data });
}

function sendFailure(res, status, message, error = {}) {
  return res.status(status).json({ success: false, message, error });
}

module.exports = { sendSuccess, sendFailure };
