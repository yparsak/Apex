const express = require('express');
const requireAuth = require('../middleware/requireAuth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  res.render('dashboard', { user: req.session.user });
});

module.exports = router;
