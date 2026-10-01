// Self-service password change (see ROADMAP.md Phase 11) - scoped to the
// logged-in user's own account only, not a replacement for the admin-driven
// User Maintenance screens (app/routes/admin/users.js).
const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const authProvider = require('../lib/auth/authProvider');
const { updatePassword } = require('../lib/userService');

const router = express.Router();

function renderForm(req, res, { error = null, success = false } = {}) {
  res.render('change-password', { user: req.session.user, error, success });
}

router.get('/account/password', requireAuth, (req, res) => {
  renderForm(req, res, {});
});

router.post('/account/password', requireAuth, async (req, res) => {
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

module.exports = router;
