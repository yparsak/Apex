const express = require('express');
const lockService = require('../../lib/lockService');

const router = express.Router();

router.get('/', async (req, res) => {
  const [activeLocks, contentionEvents] = await Promise.all([
    lockService.listActiveLocks(),
    lockService.listContentionEvents(),
  ]);
  res.render('admin/locks', { user: req.session.user, activeLocks, contentionEvents });
});

module.exports = router;
