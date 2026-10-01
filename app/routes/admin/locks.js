const express = require('express');
const lockService = require('../../lib/lockService');
const { logAdminAction } = require('../../lib/adminAudit');

const router = express.Router();

router.get('/', async (req, res) => {
  const [activeLocks, contentionEvents] = await Promise.all([
    lockService.listActiveLocks(),
    lockService.listContentionEvents(),
  ]);
  res.render('admin/locks', { user: req.session.user, activeLocks, contentionEvents });
});

// Force-unlock (see ROADMAP.md Phase 11): the only way to free a
// (repo_id, co_number) slot today is lockService.releaseLock on successful
// pipeline completion, scoped to the session's own owner via /retry and
// /resume - this is the admin override when that owner can't act.
router.post('/:id/force-unlock', async (req, res) => {
  const lockId = Number(req.params.id);
  const released = await lockService.forceReleaseLock(lockId);
  if (released) {
    await logAdminAction({
      adminUserId: req.session.user.id,
      action: 'lock.force_unlock',
      detail: {
        lockId,
        repoId: released.repo_id,
        coNumber: released.co_number,
        sessionId: released.session_id,
      },
    });
  }
  res.redirect('/admin/locks');
});

module.exports = router;
