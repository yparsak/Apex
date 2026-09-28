const express = require('express');
const db = require('../../lib/db');
const { logAdminAction } = require('../../lib/adminAudit');
const { createUser } = require('../../lib/userService');

const router = express.Router();

async function renderUsers(req, res, error) {
  const [users] = await db.query(
    'SELECT id, username, initials, is_admin, created_at FROM users ORDER BY username'
  );
  res.render('admin/users', { user: req.session.user, users, error });
}

router.get('/', async (req, res) => {
  await renderUsers(req, res, null);
});

router.post('/', async (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const initials = (req.body.initials || '').trim().toUpperCase();
  const isAdmin = req.body.is_admin === 'on';

  if (!username || !password || !/^[A-Z0-9]{1,10}$/.test(initials)) {
    return renderUsers(req, res, 'Username, password, and initials (letters/digits only) are required.');
  }

  try {
    const newUserId = await createUser({ username, password, initials, isAdmin });
    await logAdminAction({
      adminUserId: req.session.user.id,
      action: 'user.create',
      targetUserId: newUserId,
      detail: { username, initials, isAdmin },
    });
    res.redirect('/admin/users');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return renderUsers(req, res, 'That username already exists.');
    throw err;
  }
});

router.post('/:id/initials', async (req, res) => {
  const initials = (req.body.initials || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,10}$/.test(initials)) {
    return renderUsers(req, res, 'Initials must be 1-10 letters/digits.');
  }

  await db.query('UPDATE users SET initials = ? WHERE id = ?', [initials, req.params.id]);
  await logAdminAction({
    adminUserId: req.session.user.id,
    action: 'user.update_initials',
    targetUserId: Number(req.params.id),
    detail: { initials },
  });
  res.redirect('/admin/users');
});

router.post('/:id/admin', async (req, res) => {
  const targetUserId = Number(req.params.id);
  const isAdmin = req.body.is_admin === 'true';

  if (!isAdmin && targetUserId === req.session.user.id) {
    return renderUsers(req, res, 'You cannot remove your own admin access.');
  }

  await db.query('UPDATE users SET is_admin = ? WHERE id = ?', [isAdmin, targetUserId]);
  await logAdminAction({
    adminUserId: req.session.user.id,
    action: 'user.set_admin',
    targetUserId,
    detail: { isAdmin },
  });
  res.redirect('/admin/users');
});

module.exports = router;
