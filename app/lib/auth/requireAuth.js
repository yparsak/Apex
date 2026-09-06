// Route-protection middleware - 401s via the standard JSON envelope when no
// authenticated session is present. Phase 0/1 had no protected routes
// (/auth/* is self-gating); Phase 2's repo/branch routes are the first that
// need one, so it's applied uniformly to every new route (both the JSON API
// and the server-rendered pages) per the project's single-envelope
// convention for success and failure alike.

const { sendFailure } = require('../respond');

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return sendFailure(res, 401, 'Not authenticated');
  }
  return next();
}

module.exports = requireAuth;
