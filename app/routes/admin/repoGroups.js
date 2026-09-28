const express = require('express');
const db = require('../../lib/db');
const { logAdminAction } = require('../../lib/adminAudit');

const router = express.Router();

async function renderRepoGroups(req, res, error) {
  const [repoGroups] = await db.query(
    `SELECT rg.id, rg.name, rg.org_id, o.name AS org_name
     FROM repo_groups rg JOIN orgs o ON o.id = rg.org_id
     ORDER BY o.name, rg.name`
  );
  const [orgs] = await db.query('SELECT id, name FROM orgs ORDER BY name');
  res.render('admin/repo-groups', { user: req.session.user, repoGroups, orgs, error });
}

router.get('/', async (req, res) => {
  await renderRepoGroups(req, res, null);
});

router.post('/', async (req, res) => {
  const name = (req.body.name || '').trim();
  const orgId = Number(req.body.org_id);
  if (!name || !orgId) return renderRepoGroups(req, res, 'Org and name are required.');

  try {
    const [result] = await db.query('INSERT INTO repo_groups (org_id, name) VALUES (?, ?)', [orgId, name]);
    await logAdminAction({
      adminUserId: req.session.user.id,
      action: 'repo_group.create',
      detail: { repoGroupId: result.insertId, orgId, name },
    });
    res.redirect('/admin/repo-groups');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return renderRepoGroups(req, res, 'That org already has a repo group with this name.');
    throw err;
  }
});

router.post('/:id/update', async (req, res) => {
  const name = (req.body.name || '').trim();
  const orgId = Number(req.body.org_id);
  if (!name || !orgId) return renderRepoGroups(req, res, 'Org and name are required.');

  try {
    await db.query('UPDATE repo_groups SET org_id = ?, name = ? WHERE id = ?', [orgId, name, req.params.id]);
    await logAdminAction({
      adminUserId: req.session.user.id,
      action: 'repo_group.update',
      detail: { repoGroupId: Number(req.params.id), orgId, name },
    });
    res.redirect('/admin/repo-groups');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return renderRepoGroups(req, res, 'That org already has a repo group with this name.');
    throw err;
  }
});

router.post('/:id/delete', async (req, res) => {
  try {
    await db.query('DELETE FROM repo_groups WHERE id = ?', [req.params.id]);
    await logAdminAction({
      adminUserId: req.session.user.id,
      action: 'repo_group.delete',
      detail: { repoGroupId: Number(req.params.id) },
    });
    res.redirect('/admin/repo-groups');
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return renderRepoGroups(req, res, 'Cannot delete: this repo group still has repos or permission grants.');
    }
    throw err;
  }
});

module.exports = router;
