// Accessor for the generic app_settings key/value table (see ROADMAP.md
// Phase 22). The table was introduced for the maintenance lock and picked up a
// second consumer (the spec-doc model setting) immediately, so the read/write
// SQL lives here once rather than being pasted into each feature.
//
// Values are strings - app_settings.setting_value is TEXT. Callers own their
// own encoding (appLock stores '1'/'0'; the spec-doc setting stores a numeric
// models.id) and own validating it on read, since nothing here knows what a
// given key is supposed to mean.
const db = require('./db');

async function getMany(keys) {
  if (!keys.length) return {};
  const [rows] = await db.query(
    `SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN (${keys.map(() => '?').join(', ')})`,
    keys
  );
  return Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
}

async function get(key) {
  const found = await getMany([key]);
  return Object.prototype.hasOwnProperty.call(found, key) ? found[key] : null;
}

// setMany(entries, adminUserId) - writes every entry in ONE statement, so a
// group of settings that are only meaningful together (the maintenance flag and
// its message, say) can never half-apply and leave the app in a state no admin
// chose.
async function setMany(entries, adminUserId) {
  const keys = Object.keys(entries);
  if (!keys.length) return;

  const values = keys.map(() => '(?, ?, ?)').join(', ');
  const params = keys.flatMap((k) => [k, entries[k], adminUserId]);
  await db.query(
    `INSERT INTO app_settings (setting_key, setting_value, updated_by_user_id) VALUES ${values}
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by_user_id = VALUES(updated_by_user_id)`,
    params
  );
}

async function set(key, value, adminUserId) {
  await setMany({ [key]: value }, adminUserId);
}

module.exports = { get, getMany, set, setMany };
