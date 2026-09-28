const express = require('express');
const db = require('../../lib/db');
const { logAdminAction } = require('../../lib/adminAudit');

const router = express.Router();

async function renderPermissions(req, res, error) {
  const [grants] = await db.query(
    `SELECT p.id, u.username, rg.name AS repo_group_name, o.name AS org_name
     FROM user_repo_group_permissions p
     JOIN users u ON u.id = p.user_id
     JOIN repo_groups rg ON rg.id = p.repo_group_id
     JOIN orgs o ON o.id = rg.org_id
     ORDER BY u.username, o.name, rg.name`
  );
  const [users] = await db.query('SELECT id, username FROM users ORDER BY username');
  const [repoGroups] = await db.query(
    `SELECT rg.id, rg.name, o.name AS org_name
     FROM repo_groups rg JOIN orgs o ON o.id = rg.org_id
     ORDER BY o.name, rg.name`
  );
  res.render('admin/permissions', { user: req.session.user, grants, users, repoGroups, error });
}

router.get('/', async (req, res) => {
  await renderPermissions(req, res, null);
});

router.post('/', async (req, res) => {
  const userId = Number(req.body.user_id);
  const repoGroupId = Number(req.body.repo_group_id);
  if (!userId || !repoGroupId) return renderPermissions(req, res, 'User and repo group are required.');

  try {
    await db.query(
      'INSERT INTO user_repo_group_permissions (user_id, repo_group_id) VALUES (?, ?)',
      [userId, repoGroupId]
    );
    await logAdminAction({
      adminUserId: req.session.user.id,
      action: 'permission.grant',
      targetUserId: userId,
      detail: { repoGroupId },
    });
    res.redirect('/admin/permissions');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return renderPermissions(req, res, 'That user already has access to this repo group.');
    throw err;
  }
});

router.post('/:id/revoke', async (req, res) => {
  const [[grant]] = await db.query(
    'SELECT user_id, repo_group_id FROM user_repo_group_permissions WHERE id = ?',
    [req.params.id]
  );
  await db.query('DELETE FROM user_repo_group_permissions WHERE id = ?', [req.params.id]);
  await logAdminAction({
    adminUserId: req.session.user.id,
    action: 'permission.revoke',
    targetUserId: grant ? grant.user_id : null,
    detail: { repoGroupId: grant ? grant.repo_group_id : null },
  });
  res.redirect('/admin/permissions');
});

module.exports = router;
