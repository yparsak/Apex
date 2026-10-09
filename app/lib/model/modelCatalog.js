// Admin-managed model catalog (see ROADMAP.md Phase 22). Replaces the MODEL /
// MODEL_MAX_TOKENS env vars nvidiaNimAdapter.js used to read at require time,
// which allowed exactly one model per deployment.
//
// There is deliberately no env fallback anywhere in this module: an empty or
// fully-disabled catalog resolves to null, and appLock.js turns that into a
// user-facing maintenance state. A fallback would mean two sources of truth for
// "which model runs" forever, and would hide a misconfigured catalog behind
// whatever MODEL happened to be in .env.
const db = require('../db');
const appSettings = require('../appSettings');

const SELECT_COLUMNS = `id, model_id, display_name, description, provider,
    max_tokens, price_in_per_1m, price_out_per_1m, enabled, is_default,
    created_at, updated_at`;

// Same columns qualified for the one query that joins models to users, so a
// caller can't tell a preference-resolved row from a default-resolved one.
const PREFIXED_COLUMNS = `m.id, m.model_id, m.display_name, m.description, m.provider,
    m.max_tokens, m.price_in_per_1m, m.price_out_per_1m, m.enabled, m.is_default,
    m.created_at, m.updated_at`;

async function listAll() {
  const [rows] = await db.query(`SELECT ${SELECT_COLUMNS} FROM models ORDER BY display_name ASC`);
  return rows;
}

async function listEnabled() {
  const [rows] = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM models WHERE enabled = TRUE
     ORDER BY is_default DESC, display_name ASC`
  );
  return rows;
}

async function getById(id) {
  const [[row]] = await db.query(`SELECT ${SELECT_COLUMNS} FROM models WHERE id = ?`, [id]);
  return row || null;
}

// getByModelId(...) - lookup by the provider's own string rather than the
// surrogate id, for resolving a stamped sessions.model back to its catalog row
// (max_tokens, pricing). Returns null for a model that has since been deleted,
// which callers must tolerate: the stamp outlives the catalog row on purpose.
async function getByModelId(modelId) {
  const [[row]] = await db.query(`SELECT ${SELECT_COLUMNS} FROM models WHERE model_id = ?`, [modelId]);
  return row || null;
}

async function countEnabled() {
  const [[row]] = await db.query('SELECT COUNT(*) AS n FROM models WHERE enabled = TRUE');
  return Number(row.n);
}

// resolveForUser(userId) - the single place a user's effective model is decided,
// called at work-creation time only (never at generate() time - see the stamping
// note on sessions.model in db/schema.sql).
//
// Order: the user's own preference, then the catalog default, then any enabled
// model, then null. The preference join requires enabled = TRUE, so a model an
// admin disables stops being handed out without needing to rewrite every user's
// preferred_model_id - the stale pointer simply stops matching and the next
// tier answers instead.
async function resolveForUser(userId) {
  const [[preferred]] = await db.query(
    `SELECT ${PREFIXED_COLUMNS}
     FROM users u JOIN models m ON m.id = u.preferred_model_id
     WHERE u.id = ? AND m.enabled = TRUE`,
    [userId]
  );
  return preferred || resolveDefault();
}

// resolveDefault() - the no-user equivalent of resolveForUser, also its last
// non-null tier. Used directly for work with no requesting user to attribute it
// to (admin-triggered spec-doc jobs).
async function resolveDefault() {
  const [[row]] = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM models WHERE enabled = TRUE
     ORDER BY is_default DESC, display_name ASC LIMIT 1`
  );
  return row || null;
}

async function setPreferredForUser(userId, modelId) {
  await db.query('UPDATE users SET preferred_model_id = ? WHERE id = ?', [modelId, userId]);
}

// Spec/Communication Protocol doc generation is repo-level and unattended -
// it runs nightly across every stale repo with no requesting user to inherit a
// preference from (see app/lib/documents/docScanService.js). It used to
// take the catalog default, which forced one choice for both unattended doc
// writing and interactive codegen; this lets an admin point it at a cheaper
// model without changing what users get.
//
// Stored as a models.id string in app_settings rather than as a column with a
// foreign key, because app_settings is a generic key/value table. That means
// the pointer can dangle - the row it names can be disabled or deleted with
// nothing to cascade - so it is re-validated on every read and falls back to
// the catalog default rather than failing. Unset is the normal state and means
// exactly the same thing as "follow the default".
const SPEC_DOC_MODEL_KEY = 'spec_doc_model_id';

async function getSpecDocModelSetting() {
  const raw = await appSettings.get(SPEC_DOC_MODEL_KEY);
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function setSpecDocModel(modelId, adminUserId) {
  // '' rather than a deleted row: "explicitly set to follow the default" and
  // "never configured" should behave identically, and both read back as null.
  await appSettings.set(SPEC_DOC_MODEL_KEY, modelId ? String(modelId) : '', adminUserId);
}

// resolveForSpecDocs() -> { model, usedFallback } so the admin screen can say
// WHY a model is in effect. Without that, an admin whose chosen model was
// disabled by someone else would see spec docs quietly generated by a different
// model with nothing on the page explaining it.
async function resolveForSpecDocs() {
  const configuredId = await getSpecDocModelSetting();
  if (configuredId) {
    const configured = await getById(configuredId);
    if (configured && configured.enabled) return { model: configured, usedFallback: false };
    return { model: await resolveDefault(), usedFallback: true };
  }
  return { model: await resolveDefault(), usedFallback: false };
}

async function create({
  modelId,
  displayName,
  description,
  provider,
  maxTokens,
  priceInPer1m,
  priceOutPer1m,
  enabled,
}) {
  const [result] = await db.query(
    `INSERT INTO models
      (model_id, display_name, description, provider, max_tokens, price_in_per_1m, price_out_per_1m, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [modelId, displayName, description || null, provider, maxTokens, priceInPer1m, priceOutPer1m, enabled]
  );
  return result.insertId;
}

async function update(id, {
  modelId,
  displayName,
  description,
  provider,
  maxTokens,
  priceInPer1m,
  priceOutPer1m,
}) {
  await db.query(
    `UPDATE models SET model_id = ?, display_name = ?, description = ?, provider = ?,
       max_tokens = ?, price_in_per_1m = ?, price_out_per_1m = ?
     WHERE id = ?`,
    [modelId, displayName, description || null, provider, maxTokens, priceInPer1m, priceOutPer1m, id]
  );
}

async function setEnabled(id, enabled) {
  await db.query('UPDATE models SET enabled = ? WHERE id = ?', [enabled, id]);
}

// setDefault(...) - is_default is single-valued but can't be a unique index
// (FALSE repeats), so the clear-then-set pair has to be atomic: without the
// transaction a concurrent read between the two statements sees a catalog with
// no default at all, and resolveForUser would silently hand out the
// alphabetically-first enabled model instead.
async function setDefault(id) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('UPDATE models SET is_default = FALSE WHERE is_default = TRUE');
    await conn.query('UPDATE models SET is_default = TRUE WHERE id = ?', [id]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// countReferences(modelId) - how much history/in-flight work points at this
// model's provider string. Those columns are deliberately plain VARCHARs, not
// FKs (see db/schema.sql), so the database will not refuse a delete on their
// behalf - this is the check that stands in for the ER_ROW_IS_REFERENCED_2 the
// admin CRUD screens get for free elsewhere.
// `activeSessions` counts every session that is NOT yet completed, which
// deliberately includes 'awaiting_approval' and 'failed' - not just
// queued/running. 'awaiting_approval' is the default status of all not-yet-
// approved work (see db/schema.sql), so a queued/running-only check would
// happily delete a model out from under a session the user is about to approve;
// and a 'failed' session still has a live Retry button. Only 'completed' work
// is genuinely finished with its model.
async function countReferences(modelId) {
  const [[row]] = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM sessions WHERE model = ?) AS sessions,
       (SELECT COUNT(*) FROM sessions WHERE model = ? AND status <> 'completed') AS activeSessions,
       (SELECT COUNT(*) FROM spec_doc_jobs WHERE model = ? AND status IN ('queued', 'running')) AS activeSpecDocJobs,
       (SELECT COUNT(*) FROM usage_events WHERE model = ?) AS usageEvents`,
    [modelId, modelId, modelId, modelId]
  );
  return {
    sessions: Number(row.sessions),
    activeSessions: Number(row.activeSessions),
    activeSpecDocJobs: Number(row.activeSpecDocJobs),
    usageEvents: Number(row.usageEvents),
  };
}

async function remove(id) {
  await db.query('DELETE FROM models WHERE id = ?', [id]);
}

module.exports = {
  listAll,
  listEnabled,
  getById,
  getByModelId,
  countEnabled,
  resolveForUser,
  resolveDefault,
  resolveForSpecDocs,
  getSpecDocModelSetting,
  setSpecDocModel,
  setPreferredForUser,
  create,
  update,
  setEnabled,
  setDefault,
  countReferences,
  remove,
};
