// Self-service password change (see ROADMAP.md Phase 11) - scoped to the
// logged-in user's own account only, not a replacement for the admin-driven
// User Maintenance screens (app/routes/admin/users.js).
const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const authProvider = require('../lib/auth/authProvider');
const { updatePassword } = require('../lib/userService');
const modelCatalog = require('../lib/model/modelCatalog');

const router = express.Router();

function renderForm(req, res, { error = null, success = false } = {}) {
  res.render('change-password', { user: req.session.user, error, success });
}

router.get('/account/password', requireAuth, (req, res) => {
  if (!authProvider.managesPasswordsLocally) return res.redirect('/');
  renderForm(req, res, {});
});

router.post('/account/password', requireAuth, async (req, res) => {
  if (!authProvider.managesPasswordsLocally) return res.redirect('/');

  const currentPassword = req.body.current_password || '';
  const newPassword = req.body.new_password || '';
  const confirmPassword = req.body.confirm_password || '';

  if (!currentPassword || !newPassword || !confirmPassword) {
    return renderForm(req, res, { error: 'All fields are required.' });
  }
  if (newPassword !== confirmPassword) {
    return renderForm(req, res, { error: 'New password and confirmation do not match.' });
  }

  const verified = await authProvider.authenticate({
    username: req.session.user.username,
    password: currentPassword,
  });
  if (!verified) {
    return renderForm(req, res, { error: 'Current password is incorrect.' });
  }

  await updatePassword(req.session.user.id, newPassword);
  renderForm(req, res, { success: true });
});

// Sticky model preference (see ROADMAP.md Phase 22), set from the picker on
// the repo list. Validated against the *enabled* catalog rather than trusted
// from the form: the id arrives from a client-side select, and a stale page
// could post a model an admin has since disabled.
//
// Storing a preference has no effect on work already created - each session
// carries the model it was stamped with (see app/lib/sessionService.js).
router.post('/account/model', requireAuth, async (req, res) => {
  const modelId = Number(req.body.model_id);
  const model = modelId ? await modelCatalog.getById(modelId) : null;

  if (model && model.enabled) {
    await modelCatalog.setPreferredForUser(req.session.user.id, model.id);
  }

  // The picker lives on the repo list, which scopes its repo table by ?group=
  // (see app/routes/home.js). Redirecting to a bare '/' would silently throw
  // the user back to their first repo group every time they changed model,
  // since the dropdown auto-submits on change.
  const group = Number(req.body.group);
  res.redirect(group ? `/?group=${group}` : '/');
});

module.exports = router;
