const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const db = require('../lib/db');
const { enrichRepo } = require('../lib/github/repoEnrichment');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const [repoGroups] = await db.query(
    `SELECT rg.id, rg.name, o.name AS org_name
     FROM user_repo_group_permissions p
     JOIN repo_groups rg ON rg.id = p.repo_group_id
     JOIN orgs o ON o.id = rg.org_id
     WHERE p.user_id = ?
     ORDER BY o.name, rg.name`,
    [userId]
  );

  const requestedGroupId = Number(req.query.group) || null;
  const selectedGroup = repoGroups.find((g) => g.id === requestedGroupId) || repoGroups[0] || null;

  let repos = [];
  if (selectedGroup) {
    const [rows] = await db.query(
      'SELECT id, name, description, default_branch_name FROM repos WHERE repo_group_id = ? ORDER BY name',
      [selectedGroup.id]
    );
    repos = await Promise.all(rows.map((r) => enrichRepo({ name: selectedGroup.org_name }, r)));
  }

  res.render('dashboard', { user: req.session.user, repoGroups, selectedGroup, repos });
});

module.exports = router;
