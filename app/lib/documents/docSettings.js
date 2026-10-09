// Admin-chosen configuration for the document-type registry (see ROADMAP.md
// Phase 23): which types are enabled, and which model each one generates with.
// The registry itself (docTypes.js) is code; this module is the thin layer that
// reads and writes the two things an admin actually gets to decide, both stored
// in app_settings.
const appSettings = require('../appSettings');
const docTypes = require('./docTypes');

const ENABLED_KEY = 'doc_types_enabled';

// Unset means today's behavior, not "nothing enabled": an existing deployment
// that never visits /admin/documents must keep generating exactly what it
// generated before this phase. An explicitly empty value is a real choice
// (every type off) and is honoured as such - which is why this distinguishes
// null from ''.
const LEGACY_DEFAULT_KEYS = ['spec_communication_protocol'];

function parseKeys(raw) {
  if (raw === null || raw === undefined) return LEGACY_DEFAULT_KEYS.slice();
  return raw
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

// getEnabledKeys() - the stored list, verbatim, including keys with no registry
// entry behind them. Only the admin screen wants those (to say so); everything
// else wants listEnabled() below.
async function getEnabledKeys() {
  return parseKeys(await appSettings.get(ENABLED_KEY));
}

// listEnabled() -> registry entries, in registry order. A stored key with no
// entry is ignored rather than throwing: a type removed from docTypes.js while
// its key is still in the list must not wedge the nightly scan, and the scan is
// unattended, so "fails loudly" here means "silently stops generating
// everything else".
async function listEnabled() {
  const keys = new Set(await getEnabledKeys());
  return docTypes.list().filter((t) => keys.has(t.key));
}

async function isEnabled(key) {
  return (await getEnabledKeys()).includes(key);
}

// setEnabledKeys(...) - filtered against the registry on write as well as on
// read, so an unknown key submitted by a hand-rolled POST can't be persisted
// and show up later as a ghost entry nothing can explain.
async function setEnabledKeys(keys, adminUserId) {
  const known = docTypes.list().map((t) => t.key);
  const value = known.filter((k) => keys.includes(k)).join(',');
  await appSettings.set(ENABLED_KEY, value, adminUserId);
}

module.exports = { ENABLED_KEY, LEGACY_DEFAULT_KEYS, getEnabledKeys, listEnabled, isEnabled, setEnabledKeys };
