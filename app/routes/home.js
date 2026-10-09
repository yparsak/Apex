const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const db = require('../lib/db');
const { enrichRepo } = require('../lib/github/repoEnrichment');
const modelCatalog = require('../lib/model/modelCatalog');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const userId = req.session.user.id;

  // The model catalog has nothing to do with repo groups, so it is fetched
  // alongside them rather than after the repo list and its enrichRepo GitHub
  // fan-out - otherwise every dashboard render serialized an extra DB
  // round-trip behind hundreds of milliseconds of GitHub latency.
  const [[repoGroups], preferredModelId] = await Promise.all([
    db.query(
      `SELECT rg.id, rg.name, o.name AS org_name
       FROM user_repo_group_permissions p
       JOIN repo_groups rg ON rg.id = p.repo_group_id
       JOIN orgs o ON o.id = rg.org_id
       WHERE p.user_id = ?
       ORDER BY o.name, rg.name`,
      [userId]
    ),
    db.query('SELECT preferred_model_id FROM users WHERE id = ?', [userId]).then(([[row]]) => row.preferred_model_id),
  ]);

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

  // The selection is DERIVED from the list already in hand rather than fetched
  // via resolveForUser, which would re-query for a row guaranteed to be in
  // `models`. Two reasons beyond the saved query: a second concurrent query can
  // read a catalog an admin changed in between, yielding a selectedModelId
  // absent from `models` and a dropdown with nothing selected; and listEnabled
  // already orders by `is_default DESC, display_name ASC`, so models[0] IS
  // resolveForUser's fallback tier by construction.
  //
  // Falling back when the preference is missing or disabled (rather than
  // honouring it blindly) keeps the dropdown honest: it shows the model that
  // would actually be used, not a disabled one the work would never run on.
  const models = await modelCatalog.listEnabled();
  const selected = models.find((m) => m.id === preferredModelId) || models[0] || null;

  res.render('dashboard', {
    user: req.session.user,
    repoGroups,
    selectedGroup,
    repos,
    models,
    selectedModelId: selected ? selected.id : null,
  });
});

module.exports = router;
