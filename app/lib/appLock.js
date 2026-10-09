// App-wide lock state (see ROADMAP.md Phase 22). Two independent sources,
// evaluated into one answer:
//
//   'maintenance' - an explicit admin toggle with an admin-authored message,
//                   persisted in app_settings. Set from /admin/maintenance.
//   'no_model'    - DERIVED from the model catalog being empty or fully
//                   disabled. Never stored, so an admin cannot leave it stale
//                   or out of sync with the catalog it describes.
//
// The explicit lock wins when both apply: an admin doing a maintenance window
// has written a more specific message than the generic no-model one.
//
// This replaces what used to be a crash. With MODEL gone from the environment
// and no seed row in `models`, a fresh install has no usable model at all; the
// old behaviour would have been an unhandled failure on the first generate()
// call, deep inside whichever service happened to run first.
const appSettings = require('./appSettings');
const modelCatalog = require('./model/modelCatalog');

const MAINTENANCE_LOCKED_KEY = 'maintenance_locked';
const MAINTENANCE_MESSAGE_KEY = 'maintenance_message';

const DEFAULT_MAINTENANCE_MESSAGE = 'The site is under maintenance. Please try again later.';
const NO_MODEL_MESSAGE =
  'No model is available. An administrator must add and enable a model before Apex can run.';

// getLockState() runs on every HTTP request (see the gate in app.js) and on
// every worker poll, so an uncached read would be two queries per request. The
// cache is a TTL rather than write-invalidation on purpose: app.js, worker.js
// and specDocWorker.js are three separate containers (see Makefile) with no
// shared memory, so an in-process invalidation on an admin write would never
// reach the other two. A few seconds of lag on engaging maintenance is
// acceptable; silently serving a stale "unlocked" in the worker forever is not.
// Comfortably longer than worker.js's default PIPELINE_POLL_INTERVAL_MS (5000).
// At equal values the cache could never hit in the worker - the sleep between
// polls always exceeded the TTL - so an idle worker paid both queries on every
// tick forever to re-derive state that changes maybe monthly.
const CACHE_TTL_MS = 30000;
let cache = null;

// One read, one place the two settings are parsed. Both getLockState and
// getAdminView project from this, so the "maintenance wins over no_model"
// decision and the '1' encoding exist exactly once - otherwise the admin page
// could show a state the gate isn't enforcing, which is the drift this module
// exists to avoid.
async function readRawState() {
  const [settings, enabledCount] = await Promise.all([
    appSettings.getMany([MAINTENANCE_LOCKED_KEY, MAINTENANCE_MESSAGE_KEY]),
    modelCatalog.countEnabled(),
  ]);
  return {
    maintenanceLocked: settings[MAINTENANCE_LOCKED_KEY] === '1',
    maintenanceMessage: settings[MAINTENANCE_MESSAGE_KEY] || '',
    enabledCount,
  };
}

async function computeLockState() {
  const raw = await readRawState();

  if (raw.maintenanceLocked) {
    return {
      locked: true,
      reason: 'maintenance',
      message: raw.maintenanceMessage.trim() || DEFAULT_MAINTENANCE_MESSAGE,
    };
  }
  if (raw.enabledCount === 0) {
    return { locked: true, reason: 'no_model', message: NO_MODEL_MESSAGE };
  }
  return { locked: false, reason: null, message: null };
}

async function getLockState() {
  // Date.now() is the clock the TTL is measured against; there is no
  // determinism requirement here, unlike in a workflow script.
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.state;

  const state = await computeLockState();
  cache = { at: now, state };
  return state;
}

// getAdminView() - the uncached, fully-decomposed state for /admin/maintenance,
// which must show the admin what they just saved rather than a value up to
// CACHE_TTL_MS stale, and must show the maintenance toggle and the derived
// no-model condition separately rather than only the winning one.
async function getAdminView() {
  const raw = await readRawState();
  return {
    maintenanceLocked: raw.maintenanceLocked,
    maintenanceMessage: raw.maintenanceMessage,
    defaultMaintenanceMessage: DEFAULT_MAINTENANCE_MESSAGE,
    noModel: raw.enabledCount === 0,
    noModelMessage: NO_MODEL_MESSAGE,
    enabledModelCount: raw.enabledCount,
  };
}

// The flag and its message are ONE logical setting written in ONE statement.
// As two separate upserts they could half-apply: the site goes hard-locked
// carrying the previous window's message, or - on the first ever lock - locked
// with an empty message that resolves to the generic default, while the admin's
// own screen shows the text they typed and reports success.
async function setMaintenance({ locked, message, adminUserId }) {
  await appSettings.setMany(
    {
      [MAINTENANCE_LOCKED_KEY]: locked ? '1' : '0',
      [MAINTENANCE_MESSAGE_KEY]: message || '',
    },
    adminUserId
  );
  invalidate();
}

// invalidate() - clears this process's cache only. Called after an admin write
// so the admin's own next request reflects it immediately; the other two
// processes still converge on the TTL, which is the point of the TTL.
function invalidate() {
  cache = null;
}

module.exports = { getLockState, getAdminView, setMaintenance, invalidate, NO_MODEL_MESSAGE };
