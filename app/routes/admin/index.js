const express = require('express');
const requireAdmin = require('../../middleware/requireAdmin');

const router = express.Router();

router.use(requireAdmin);

router.get('/', (req, res) => res.redirect('/admin/orgs'));

router.use('/orgs', require('./orgs'));
router.use('/repo-groups', require('./repoGroups'));
router.use('/repos', require('./repos'));
router.use('/users', require('./users'));
router.use('/permissions', require('./permissions'));

module.exports = router;
