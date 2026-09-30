// Global, CO-scoped cross-repo document search (see ROADMAP.md Phase 8). The
// per-repo Documents view lives at GET /repos/:repoId/documents instead
// (app/routes/repos.js), alongside that repo's own branches/sessions.
const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const branchService = require('../lib/branchService');
const documentsService = require('../lib/documents/documentsService');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const coNumber = (req.query.co_number || '').trim();
  let results = [];
  let error = null;

  if (coNumber) {
    if (!branchService.isValidCoNumber(coNumber)) {
      error = 'CO number must match format C12345678 (a C followed by 8 digits).';
    } else {
      results = await documentsService.searchByCoNumber(coNumber, req.session.user.id);
    }
  }

  res.render('documents', { user: req.session.user, coNumber, results, error });
});

module.exports = router;
