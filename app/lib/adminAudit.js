const db = require('./db');

// Every admin mutation gets a row here (see ROADMAP.md Phase 2). detail is an
// arbitrary JSON-serializable object describing what changed.
async function logAdminAction({ adminUserId, action, targetUserId = null, detail = null }) {
  await db.query(
    'INSERT INTO admin_audit_log (admin_user_id, action, target_user_id, detail) VALUES (?, ?, ?, ?)',
    [adminUserId, action, targetUserId, detail ? JSON.stringify(detail) : null]
  );
}

module.exports = { logAdminAction };
