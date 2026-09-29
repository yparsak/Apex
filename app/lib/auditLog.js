const db = require('./db');

// Every clarification-loop event gets a row here (see ROADMAP.md Phase 5) -
// distinct from admin_audit_log (app/lib/adminAudit.js), which covers admin
// mutations, not AI-pipeline activity.
async function logAction({ sessionId = null, userId = null, action, detail = null }) {
  await db.query('INSERT INTO audit_log (session_id, user_id, action, detail) VALUES (?, ?, ?, ?)', [
    sessionId,
    userId,
    action,
    detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail),
  ]);
}

module.exports = { logAction };
