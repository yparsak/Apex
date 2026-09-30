// JSON API surface for Phase 10's observability data (see ROADMAP.md Phase
// 10) - GET /api/admin/alerts, /api/admin/locks, /api/admin/lock-contention.
// The HTML admin pages (app/routes/admin/alerts.js, admin/locks.js) call the
// same underlying service functions directly rather than hitting these
// routes internally; this router exists because the roadmap names these
// exact paths as "a real queried surface, not write-only" in their own right.
const express = require('express');
const requireAdmin = require('../middleware/requireAdmin');
const blockedAllowlistAlerts = require('../lib/blockedAllowlistAlerts');
const lockService = require('../lib/lockService');

const router = express.Router();
router.use(requireAdmin);

router.get('/alerts', async (req, res) => {
  res.json({ alerts: await blockedAllowlistAlerts.listAlerts() });
});

router.get('/locks', async (req, res) => {
  res.json({ locks: await lockService.listActiveLocks() });
});

router.get('/lock-contention', async (req, res) => {
  res.json({ events: await lockService.listContentionEvents() });
});

module.exports = router;
