const express = require('express');
const db = require('../../lib/db');
const { logAdminAction } = require('../../lib/adminAudit');

const router = express.Router();

async function renderRepos(req, res, error) {
  const [repos] = await db.query(
    `SELECT r.id, r.name, r.description, r.default_branch_name, r.repo_group_id,
            rg.name AS repo_group_name, o.name AS org_name
     FROM repos r
     JOIN repo_groups rg ON rg.id = r.repo_group_id
     JOIN orgs o ON o.id = rg.org_id
     ORDER BY o.name, rg.name, r.name`
  );
  const [repoGroups] = await db.query(
    `SELECT rg.id, rg.name, o.name AS org_name
     FROM repo_groups rg JOIN orgs o ON o.id = rg.org_id
     ORDER BY o.name, rg.name`
  );
  res.render('admin/repos', { user: req.session.user, repos, repoGroups, error });
}

router.get('/', async (req, res) => {
  await renderRepos(req, res, null);
});

router.post('/', async (req, res) => {
  const name = (req.body.name || '').trim();
  const repoGroupId = Number(req.body.repo_group_id);
  const description = (req.body.description || '').trim() || null;
  const defaultBranchName = (req.body.default_branch_name || '').trim() || 'main';
  if (!name || !repoGroupId) return renderRepos(req, res, 'Repo group and name are required.');

  try {
    const [result] = await db.query(
      'INSERT INTO repos (repo_group_id, name, description, default_branch_name) VALUES (?, ?, ?, ?)',
      [repoGroupId, name, description, defaultBranchName]
    );
    await logAdminAction({
      adminUserId: req.session.user.id,
      action: 'repo.create',
      detail: { repoId: result.insertId, repoGroupId, name },
    });
    res.redirect('/admin/repos');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return renderRepos(req, res, 'That repo group already has a repo with this name.');
    throw err;
  }
});

router.post('/:id/update', async (req, res) => {
  const name = (req.body.name || '').trim();
  const repoGroupId = Number(req.body.repo_group_id);
  const description = (req.body.description || '').trim() || null;
  const defaultBranchName = (req.body.default_branch_name || '').trim() || 'main';
  if (!name || !repoGroupId) return renderRepos(req, res, 'Repo group and name are required.');

  try {
    await db.query(
      'UPDATE repos SET repo_group_id = ?, name = ?, description = ?, default_branch_name = ? WHERE id = ?',
      [repoGroupId, name, description, defaultBranchName, req.params.id]
    );
    await logAdminAction({
      adminUserId: req.session.user.id,
      action: 'repo.update',
      detail: { repoId: Number(req.params.id), repoGroupId, name },
    });
    res.redirect('/admin/repos');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return renderRepos(req, res, 'That repo group already has a repo with this name.');
    throw err;
  }
});

router.post('/:id/delete', async (req, res) => {
  try {
    await db.query('DELETE FROM repos WHERE id = ?', [req.params.id]);
    await logAdminAction({
      adminUserId: req.session.user.id,
      action: 'repo.delete',
      detail: { repoId: Number(req.params.id) },
    });
    res.redirect('/admin/repos');
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return renderRepos(req, res, 'Cannot delete: this repo still has change orders, branches, or documents.');
    }
    throw err;
  }
});

module.exports = router;
