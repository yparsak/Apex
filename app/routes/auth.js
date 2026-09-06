// Auth routes — depend only on the AuthProvider interface (getAuthProvider),
// never on a concrete provider implementation. This is what makes swapping
// in SSO later a change confined to app/lib/auth/, not here.

const express = require('express');
const { getAuthProvider } = require('../lib/auth');
const { isNonEmptyString } = require('../lib/validate');
const { sendSuccess, sendFailure } = require('../lib/respond');
const logger = require('../lib/logger');

const router = express.Router();

const USERNAME_MAX_LENGTH = 100;
const INITIALS_MAX_LENGTH = 10;
const PASSWORD_MIN_LENGTH = 8;

// All fields required — no admin-provisioning flow exists yet (Phase 6), and
// `users.initials` is NOT NULL with no default, so registration must collect it.
router.post('/register', async (req, res) => {
  const { username, password, initials } = req.body || {};

  if (!isNonEmptyString(username, { maxLength: USERNAME_MAX_LENGTH })) {
    return sendFailure(res, 400, `username is required (max ${USERNAME_MAX_LENGTH} characters)`);
  }
  if (!isNonEmptyString(password) || password.length < PASSWORD_MIN_LENGTH) {
    return sendFailure(res, 400, `password is required (minimum ${PASSWORD_MIN_LENGTH} characters)`);
  }
  if (!isNonEmptyString(initials, { maxLength: INITIALS_MAX_LENGTH })) {
    return sendFailure(res, 400, `initials is required (max ${INITIALS_MAX_LENGTH} characters)`);
  }

  try {
    const authProvider = getAuthProvider();
    const user = await authProvider.register(username.trim(), password, initials.trim());
    req.session.user = user;
    return sendSuccess(res, { user }, 'Registered successfully');
  } catch (err) {
    if (err.code === 'USERNAME_TAKEN') {
      return sendFailure(res, 409, 'Username already exists');
    }
    logger.error('register failed', { error: err.message });
    return sendFailure(res, 500, 'Registration failed', { code: 'INTERNAL_ERROR' });
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};

  if (!isNonEmptyString(username) || !isNonEmptyString(password)) {
    return sendFailure(res, 400, 'username and password are required');
  }

  try {
    const authProvider = getAuthProvider();
    const user = await authProvider.verify(username.trim(), password);
    if (!user) {
      return sendFailure(res, 401, 'Invalid username or password');
    }
    req.session.user = user;
    return sendSuccess(res, { user }, 'Logged in successfully');
  } catch (err) {
    logger.error('login failed', { error: err.message });
    return sendFailure(res, 500, 'Login failed', { code: 'INTERNAL_ERROR' });
  }
});

router.post('/logout', (req, res) => {
  if (!req.session) {
    return sendSuccess(res, {}, 'Logged out successfully');
  }

  req.session.destroy((err) => {
    if (err) {
      logger.error('logout failed', { error: err.message });
      return sendFailure(res, 500, 'Logout failed', { code: 'INTERNAL_ERROR' });
    }
    res.clearCookie('connect.sid');
    return sendSuccess(res, {}, 'Logged out successfully');
  });
});

router.get('/me', (req, res) => {
  if (!req.session || !req.session.user) {
    return sendFailure(res, 401, 'Not authenticated');
  }
  return sendSuccess(res, { user: req.session.user });
});

module.exports = router;
