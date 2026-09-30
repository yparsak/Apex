// Blocked-allowlist alerts (see ROADMAP.md Phase 10): a real, queried record
// of every GitHub write call that came back HTTP 403 - not a write-only
// table like it was through Phase 9. "403 means allowlist block" is a
// heuristic, not a GitHub guarantee - GitHub returns 403 both for an
// App-permission scope violation and for the dev/** ruleset rejecting an
// out-of-pattern ref. A 422/409 non-fast-forward push is a separate,
// already-handled retry case (see pushService.js's fetch-and-retry) and
// never reaches this table.
const db = require('./db');

async function recordAlert({ repoId = null, sessionId = null, httpStatus, detail = null }) {
  await db.query('INSERT INTO blocked_allowlist_alerts (repo_id, session_id, http_status, detail) VALUES (?, ?, ?, ?)', [
    repoId,
    sessionId,
    httpStatus,
    detail,
  ]);
}

async function listAlerts({ limit = 200 } = {}) {
  const [rows] = await db.query(
    `SELECT a.*, r.name AS repo_name, rg.name AS repo_group_name, o.name AS org_name
     FROM blocked_allowlist_alerts a
     LEFT JOIN repos r ON r.id = a.repo_id
     LEFT JOIN repo_groups rg ON rg.id = r.repo_group_id
     LEFT JOIN orgs o ON o.id = rg.org_id
     ORDER BY a.id DESC
     LIMIT ?`,
    [limit]
  );
  return rows;
}

module.exports = { recordAlert, listAlerts };
