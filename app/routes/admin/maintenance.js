// Maintenance lock admin screen (see ROADMAP.md Phase 22).
//
// Named "Maintenance", not "Locks": /admin/locks already exists and means
// something entirely different (per-(repo, CO) pipeline locks - see
// app/routes/admin/locks.js).
//
// Only the explicit maintenance toggle is editable here. The other lock source,
// an empty or fully-disabled model catalog, is derived from the catalog itself
// and so is shown read-only - there is no toggle for it, because a stored flag
// could drift out of sync with the thing it describes. Clearing it means adding
// a model on /admin/models.
const express = require('express');
const appLock = require('../../lib/appLock');
const { logAdminAction } = require('../../lib/adminAudit');

const router = express.Router();

const MAX_MESSAGE_LENGTH = 1000;

async function renderMaintenance(req, res, error, saved = false) {
  const state = await appLock.getAdminView();
  res.render('admin/maintenance', { user: req.session.user, state, error, saved });
}

router.get('/', async (req, res) => {
  // ?saved=1 carries the success message across the POST's redirect - see the
  // POST handler for why it can't just re-render.
  await renderMaintenance(req, res, null, req.query.saved === '1');
});

router.post('/', async (req, res) => {
  const locked = req.body.locked === 'true';
  const message = (req.body.message || '').trim();

  if (message.length > MAX_MESSAGE_LENGTH) {
    return renderMaintenance(req, res, `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer.`);
  }

  await appLock.setMaintenance({ locked, message, adminUserId: req.session.user.id });
  await logAdminAction({
    adminUserId: req.session.user.id,
    action: locked ? 'maintenance.lock' : 'maintenance.unlock',
    detail: { message },
  });

  // Redirect rather than re-render. appLockGate already computed
  // res.locals.appLock for THIS request, before the write - so a same-request
  // render would show "Saved." next to a banner describing the pre-save state:
  // no banner after locking, and a stale banner still present after unlocking.
  // appLock.invalidate() can't fix locals that were captured before it ran.
  res.redirect('/admin/maintenance?saved=1');
});

module.exports = router;
