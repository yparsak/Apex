// DB-backed model circuit breaker (see ROADMAP.md Phase 14). State must live in
// MariaDB, not a per-process in-memory flag: modelAdapter.js is called from
// three separate processes (app.js, worker.js, specDocWorker.js - see Phase
// 12), none of which share memory - consistent with this project's "no Redis"
// stance (see ROADMAP.md Stack decisions).
//
// Keyed on (provider, model) since Phase 22. It was keyed on provider alone,
// which was equivalent while one deployment meant one model; with several
// models behind the same NIM endpoint, one bad model id would otherwise trip
// the breaker for every other model on that provider too. Quota, the thing this
// breaker actually tracks, can be per-model on a metered provider - so the
// narrower key is also the more accurate one.
const db = require('../db');

// A quota/billing-shaped failure locks the provider; a transient network/
// transport error (already retried internally by the adapter - see
// nvidiaNimAdapter.js's own MAX_ATTEMPTS loop) never should, since it says
// nothing about remaining quota.
function isQuotaOrBillingError(err) {
  if (err.httpStatus === 429 || err.httpStatus === 402) return true;
  return /quota|billing|credit|insufficient/i.test(err.message || '');
}

// PROVIDER_WIDE is the `model` value meaning "this lock covers every model on
// the provider". It exists because re-keying this table from PK (provider) to
// PK (provider, model) in Phase 22 backfilled every pre-existing row with ''
// - and a row that was genuinely locked on quota must keep blocking after the
// migration, not silently become unreachable because no query asks for ''
// any more. Treating '' as provider-wide preserves those locks exactly, and
// gives the concept a name for anything that needs to lock a whole provider
// later.
const PROVIDER_WIDE = '';

// Returns the narrowest lock that applies: a model-specific row if there is
// one, otherwise the provider-wide row. A row is only returned when it is
// actually locked-or-worse, so a stale 'healthy' model row can't mask a
// provider-wide lock sitting behind it.
async function getHealth(provider, model) {
  const [rows] = await db.query(
    `SELECT * FROM model_provider_health WHERE provider = ? AND model IN (?, ?)
     ORDER BY model DESC`,
    [provider, model, PROVIDER_WIDE]
  );
  const locked = rows.find((r) => r.status === 'locked');
  if (locked) return locked;
  return rows.find((r) => r.model === model) || { provider, model, status: 'healthy', reason: null, locked_at: null };
}

// listHealth() - every (provider, model) pair that's ever recorded a status,
// for the Usage admin page. Rows accumulate per model now rather than per
// provider, and a row for a model since deleted from the catalog still lists -
// its lock is still real and still needs a visible way to be cleared.
async function listHealth() {
  const [rows] = await db.query('SELECT * FROM model_provider_health ORDER BY provider ASC, model ASC');
  return rows;
}

// assertHealthy(...) - the call-site check modelAdapter.generate() runs
// before ever attempting a call, so a known-exhausted provider fails fast
// with a clear message instead of every in-flight call failing individually
// deep inside whichever service called it (clarification/overlap calls are
// not serialized - see ROADMAP.md Phase 5).
async function assertHealthy(provider, model) {
  const health = await getHealth(provider, model);
  if (health.status === 'locked') {
    const scope =
      health.model === PROVIDER_WIDE
        ? `Provider "${provider}" is locked for all models`
        : `Model "${model}" on provider "${provider}" is locked`;
    throw new Error(
      `${scope} (${health.reason || 'quota/billing error'}) - clear the lock from /admin/usage, or select a different model, before retrying.`
    );
  }
}

// recordFailure(...) - called after every failed generate() call; only a
// quota/billing-classified error actually locks the model, so a transient
// error is a no-op here rather than tripping the breaker on noise.
async function recordFailure(provider, model, err) {
  if (!isQuotaOrBillingError(err)) return;
  await db.query(
    `INSERT INTO model_provider_health (provider, model, status, reason, locked_at) VALUES (?, ?, 'locked', ?, NOW())
     ON DUPLICATE KEY UPDATE status = 'locked', reason = VALUES(reason), locked_at = NOW()`,
    [provider, model, String(err.message || '').slice(0, 500)]
  );
}

// clearLock(...) - the only recovery path (see ROADMAP.md Phase 14 Open:
// recovery semantics resolved to manual-only for now, no auto-expiry on a
// quota reset, since that's not knowable in advance for the current
// provider). Admin-only, called from /admin/usage.
async function clearLock(provider, model) {
  await db.query(
    `INSERT INTO model_provider_health (provider, model, status, reason, locked_at) VALUES (?, ?, 'healthy', NULL, NULL)
     ON DUPLICATE KEY UPDATE status = 'healthy', reason = NULL, locked_at = NULL`,
    [provider, model]
  );
}

module.exports = { getHealth, listHealth, assertHealthy, recordFailure, clearLock, PROVIDER_WIDE };
