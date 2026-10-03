// DB-backed model-provider circuit breaker (see ROADMAP.md Phase 14). State
// must live in MariaDB, not a per-process in-memory flag: modelAdapter.js is
// called from three separate processes (app.js, worker.js, specDocWorker.js -
// see Phase 12), none of which share memory - consistent with this project's
// "no Redis" stance (see ROADMAP.md Stack decisions).
const db = require('../db');

// A quota/billing-shaped failure locks the provider; a transient network/
// transport error (already retried internally by the adapter - see
// nvidiaNimAdapter.js's own MAX_ATTEMPTS loop) never should, since it says
// nothing about remaining quota.
function isQuotaOrBillingError(err) {
  if (err.httpStatus === 429 || err.httpStatus === 402) return true;
  return /quota|billing|credit|insufficient/i.test(err.message || '');
}

async function getHealth(provider) {
  const [[row]] = await db.query('SELECT * FROM model_provider_health WHERE provider = ?', [provider]);
  return row || { provider, status: 'healthy', reason: null, locked_at: null };
}

// listHealth() - every provider that's ever recorded a status, for the Usage
// admin page. Today that's at most one row (nvidia_nim) since no second
// adapter is implemented yet (see "Non-NIM model provider" in
// undecided_topics.md).
async function listHealth() {
  const [rows] = await db.query('SELECT * FROM model_provider_health ORDER BY provider ASC');
  return rows;
}

// assertHealthy(...) - the call-site check modelAdapter.generate() runs
// before ever attempting a call, so a known-exhausted provider fails fast
// with a clear message instead of every in-flight call failing individually
// deep inside whichever service called it (clarification/overlap calls are
// not serialized - see ROADMAP.md Phase 5).
async function assertHealthy(provider) {
  const health = await getHealth(provider);
  if (health.status === 'locked') {
    throw new Error(
      `Model provider "${provider}" is locked (${health.reason || 'quota/billing error'}) - clear the lock from /admin/usage before retrying.`
    );
  }
}

// recordFailure(...) - called after every failed generate() call; only a
// quota/billing-classified error actually locks the provider, so a transient
// error is a no-op here rather than tripping the breaker on noise.
async function recordFailure(provider, err) {
  if (!isQuotaOrBillingError(err)) return;
  await db.query(
    `INSERT INTO model_provider_health (provider, status, reason, locked_at) VALUES (?, 'locked', ?, NOW())
     ON DUPLICATE KEY UPDATE status = 'locked', reason = VALUES(reason), locked_at = NOW()`,
    [provider, String(err.message || '').slice(0, 500)]
  );
}

// clearLock(...) - the only recovery path (see ROADMAP.md Phase 14 Open:
// recovery semantics resolved to manual-only for now, no auto-expiry on a
// quota reset, since that's not knowable in advance for the current
// provider). Admin-only, called from /admin/usage.
async function clearLock(provider) {
  await db.query(
    `INSERT INTO model_provider_health (provider, status, reason, locked_at) VALUES (?, 'healthy', NULL, NULL)
     ON DUPLICATE KEY UPDATE status = 'healthy', reason = NULL, locked_at = NULL`,
    [provider]
  );
}

module.exports = { getHealth, listHealth, assertHealthy, recordFailure, clearLock };
