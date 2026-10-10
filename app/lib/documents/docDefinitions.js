// The document-type registry (see ROADMAP.md Phase 24). This file replaces
// docTypes.js, which was the same registry as a code module with one hardcoded
// entry; every document that exists is now a `doc_definitions` row an admin
// wrote on /admin/documents.
//
// What moved, and why it could: Phase 23's registry had to be code because
// every field except `label` and `description` was a prompt or a *function* -
// and a function cannot be a column. Phase 24 removes the function. Context
// building is one shared module (docContext.js) rather than a per-entry
// `buildContext`, which leaves nothing in an entry but text, and text is what a
// table is for. The cost of that trade is real and deliberate: an admin
// controls what the model is TOLD, not what it READS.
//
// There are no built-in definitions and none are seeded. A fresh install
// generates nothing until an admin creates one - including the
// Spec/Communication Protocol document, which is reproduced by pasting the
// title, description and prompt out of README.md.
const db = require('../db');

// The create form opens pre-filled with this rather than blank. It is the
// deleted docTypes.js SPEC_SYSTEM_PROMPT verbatim, closing line included.
//
// This is the actual guardrail against a prompt that breaks rendering. There is
// no reliable way to validate "this prompt will produce Markdown", so the
// defense has to be at authoring time: an admin edits a working example instead
// of inventing the output contract, and the one line repo_documents rendering
// depends on - "Respond with the complete document in Markdown, and nothing
// else." - is already there before they start typing.
const STARTER_PROMPT = [
  "You are Apex's documentation agent. Write a concise Spec / Communication Protocol",
  'document for this repo, for engineers on other teams who integrate with it but do not',
  "work in its codebase day to day. Cover what the repo does, its overall structure, how",
  'to build/test/run it, and its integration surface (APIs it exposes, services it',
  'depends on, message formats) - whatever is actually evident from the material below.',
  'Do not invent details that are not supported by it.',
  '',
  'Respond with the complete document in Markdown, and nothing else.',
].join('\n');

const MAX_TITLE_LENGTH = 200;
const MAX_KEY_LENGTH = 50; // doc_definitions.doc_key, and the three doc_type columns it is copied into

// A one-line prompt produces a worthless document, and the failure is invisible
// until the next morning - nothing throws, a thin document is simply written.
// This is a floor against an obvious accident, not a quality check: there is no
// defensible way to validate that a prompt is *good*.
const MIN_PROMPT_LENGTH = 40;

// repo_documents.doc_type is shared with rows no definition generates
// (requirements_log, written inline by requirementsLogService.js as sessions
// complete). A definition slugging to that key would upsert over the
// requirements log on its first run.
const RESERVED_KEYS = ['requirements_log'];

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_KEY_LENGTH)
    .replace(/_+$/, '');
}

// allocateKey(title) - the slug, or the slug with a numeric suffix if something
// already holds it. Checked against EVERY row including archived ones: an
// archived definition keeps its key reserved precisely so a new definition
// cannot inherit its generated content (see db/schema.sql).
//
// A title that slugs to nothing at all (e.g. one written entirely in a
// non-Latin script) falls back to a generic stem rather than being rejected -
// the key is an internal identifier that no user ever reads, and refusing the
// title would be refusing it for a reason the admin cannot see or fix.
async function allocateKey(title) {
  const base = slugify(title) || 'document';
  const [rows] = await db.query('SELECT doc_key FROM doc_definitions');
  const taken = new Set(rows.map((r) => r.doc_key).concat(RESERVED_KEYS));

  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `_${n}`;
    const candidate = base.slice(0, MAX_KEY_LENGTH - suffix.length).replace(/_+$/, '') + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

// Archived rows are excluded everywhere except getByKey: a key outlives its
// definition in doc_jobs, repo_doc_sync and repo_documents (none of which can
// carry an FK to this table), so the lookup those callers make has to be able
// to find an archived row and say so.
async function listAll() {
  const [rows] = await db.query(
    'SELECT * FROM doc_definitions WHERE archived_at IS NULL ORDER BY title ASC, id ASC'
  );
  return rows;
}

async function listActive() {
  const [rows] = await db.query(
    'SELECT * FROM doc_definitions WHERE archived_at IS NULL AND is_active = 1 ORDER BY title ASC, id ASC'
  );
  return rows;
}

async function getById(id) {
  const [[row]] = await db.query('SELECT * FROM doc_definitions WHERE id = ?', [id]);
  return row || null;
}

async function getByKey(docKey) {
  const [[row]] = await db.query('SELECT * FROM doc_definitions WHERE doc_key = ?', [docKey]);
  return row || null;
}

// titleTaken(title, exceptId) - unique among non-archived definitions only. An
// archived "Code Review" must not block a new one with the same name: the key
// stays reserved (the new row gets code_review_2), but the human-facing title
// is free to be reused, which is the whole difference between the two fields.
async function titleTaken(title, exceptId = null) {
  const [[row]] = await db.query(
    'SELECT id FROM doc_definitions WHERE archived_at IS NULL AND title = ? AND id <> ?',
    [title, exceptId || 0]
  );
  return !!row;
}

async function create({ title, description, modelPrompt, modelId, isActive, createdBy }) {
  const docKey = await allocateKey(title);
  const [result] = await db.query(
    `INSERT INTO doc_definitions (doc_key, title, description, model_prompt, model_id, is_active, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [docKey, title, description || null, modelPrompt, modelId || null, isActive ? 1 : 0, createdBy]
  );
  return { id: result.insertId, docKey };
}

// update() - doc_key is absent on purpose; it is immutable after create.
//
// prompt_revision is bumped here, in the same statement, and ONLY when
// model_prompt actually changed: that is what makes a prompt edit regenerate on
// the next nightly scan (see docScanService.js). Title and description edits
// deliberately do not bump it - neither reaches the model, so neither can
// change the output, and regenerating every repo's document because someone
// fixed a typo in a description would be an expensive no-op.
//
// Returns whether the prompt changed so the caller can say so in the audit row.
async function update(id, { title, description, modelPrompt, modelId, existing }) {
  const promptChanged = modelPrompt !== existing.model_prompt;
  await db.query(
    `UPDATE doc_definitions
     SET title = ?, description = ?, model_prompt = ?, model_id = ?,
         prompt_revision = prompt_revision + ?
     WHERE id = ?`,
    [title, description || null, modelPrompt, modelId || null, promptChanged ? 1 : 0, id]
  );
  return { promptChanged };
}

async function setActive(id, active) {
  await db.query('UPDATE doc_definitions SET is_active = ? WHERE id = ?', [active ? 1 : 0, id]);
}

// archive() - what "delete" does. The row stays (its key stays reserved) and
// repo_documents rows stay (what was generated stays generated); the definition
// just leaves the admin list and stops being scanned. A genuine purge would be
// a separate, confirmed action and does not exist.
async function archive(id) {
  await db.query('UPDATE doc_definitions SET is_active = 0, archived_at = NOW() WHERE id = ? AND archived_at IS NULL', [
    id,
  ]);
}

// countDocuments(docKey) - how many repos have generated content under this
// definition. Shown on the delete confirmation: "this hides a document 30 repos
// have" is a materially different decision from deleting one nothing ever ran.
async function countDocuments(docKey) {
  const [[row]] = await db.query(
    "SELECT COUNT(*) AS n FROM repo_documents WHERE doc_type = ? AND co_number = ''",
    [docKey]
  );
  return row.n;
}

module.exports = {
  STARTER_PROMPT,
  MAX_TITLE_LENGTH,
  MIN_PROMPT_LENGTH,
  slugify,
  listAll,
  listActive,
  getById,
  getByKey,
  titleTaken,
  create,
  update,
  setActive,
  archive,
  countDocuments,
};
