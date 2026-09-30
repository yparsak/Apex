const express = require('express');
const blockedAllowlistAlerts = require('../../lib/blockedAllowlistAlerts');

const router = express.Router();

router.get('/', async (req, res) => {
  const alerts = await blockedAllowlistAlerts.listAlerts();
  res.render('admin/alerts', { user: req.session.user, alerts });
});

module.exports = router;
