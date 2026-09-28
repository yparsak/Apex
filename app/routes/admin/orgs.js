const express = require('express');
const db = require('../../lib/db');
const { logAdminAction } = require('../../lib/adminAudit');

const router = express.Router();

async function renderOrgs(req, res, error) {
  const [orgs] = await db.query('SELECT id, name, created_at FROM orgs ORDER BY name');
  res.render('admin/orgs', { user: req.session.user, orgs, error });
}

router.get('/', async (req, res) => {
  await renderOrgs(req, res, null);
});

router.post('/', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return renderOrgs(req, res, 'Name is required.');

  try {
    const [result] = await db.query('INSERT INTO orgs (name) VALUES (?)', [name]);
    await logAdminAction({
      adminUserId: req.session.user.id,
      action: 'org.create',
      detail: { orgId: result.insertId, name },
    });
    res.redirect('/admin/orgs');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return renderOrgs(req, res, 'An org with that name already exists.');
    throw err;
  }
});

router.post('/:id/update', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return renderOrgs(req, res, 'Name is required.');

  try {
    await db.query('UPDATE orgs SET name = ? WHERE id = ?', [name, req.params.id]);
    await logAdminAction({
      adminUserId: req.session.user.id,
      action: 'org.update',
      detail: { orgId: Number(req.params.id), name },
    });
    res.redirect('/admin/orgs');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return renderOrgs(req, res, 'An org with that name already exists.');
    throw err;
  }
});

router.post('/:id/delete', async (req, res) => {
  try {
    await db.query('DELETE FROM orgs WHERE id = ?', [req.params.id]);
    await logAdminAction({
      adminUserId: req.session.user.id,
      action: 'org.delete',
      detail: { orgId: Number(req.params.id) },
    });
    res.redirect('/admin/orgs');
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return renderOrgs(req, res, 'Cannot delete: this org still has repo groups.');
    }
    throw err;
  }
});

module.exports = router;
