// Usage/cost reporting admin page (see ROADMAP.md Phase 14): reporting only,
// no spend caps or enforcement - plus the model-provider circuit breaker's
// status indicator and manual clear-lock action.
const express = require('express');
const usageService = require('../../lib/model/usageService');
const providerHealth = require('../../lib/model/providerHealth');
const { logAdminAction } = require('../../lib/adminAudit');

const router = express.Router();

function defaultRange() {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

router.get('/', async (req, res) => {
  const { from, to } = req.query.from && req.query.to ? req.query : defaultRange();
  const toInclusive = `${to} 23:59:59`;

  const [summary, byRepoGroup, byCallSite, trend, providers] = await Promise.all([
    usageService.getSummary({ from, to: toInclusive }),
    usageService.getBreakdownByRepoGroup({ from, to: toInclusive }),
    usageService.getBreakdownByCallSite({ from, to: toInclusive }),
    usageService.getTrend({ from, to: toInclusive }),
    providerHealth.listHealth(),
  ]);

  res.render('admin/usage', { user: req.session.user, from, to, summary, byRepoGroup, byCallSite, trend, providers });
});

// Manual-only recovery (see ROADMAP.md Phase 14 Open: recovery semantics) -
// there's no auto-expiry, so a locked model stays locked until an admin clears
// it here. The model comes from the body rather than the path: it's the
// provider's own id (e.g. 'google/gemma-4-31b-it'), whose slashes would need
// escaping to survive a path segment.
router.post('/providers/:provider/clear-lock', async (req, res) => {
  const { provider } = req.params;
  const model = req.body.model || '';
  await providerHealth.clearLock(provider, model);
  await logAdminAction({
    adminUserId: req.session.user.id,
    action: 'provider.clear_lock',
    detail: { provider, model },
  });
  res.redirect('/admin/usage');
});

module.exports = router;
