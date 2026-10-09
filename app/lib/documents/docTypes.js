// The document-type registry (see ROADMAP.md Phase 23). One entry per kind of
// generated, repo-level document; docService.js and docScanService.js are
// generic over an entry and know nothing about any particular one.
//
// This is code, not a table, on purpose. Every field below except `label` and
// `description` is a prompt or a function, so a DB row could never be the
// source of truth for "which types exist" - and two sources of truth for that
// is exactly what makes an admin screen offer a type the code can't run. The
// database stores only what an admin *chooses* (which types are enabled, and
// which model each uses - see docSettings.js); what *exists* is this module.
//
// Adding a type should be a new file plus one line in DOC_TYPES below: no
// schema change, no admin-page edit, no change to docWorker.js, docService.js
// or docScanService.js. If a new type can't be added that way, the
// generalization has a hole in it and the hole is the bug.
//
// Entry shape:
//   key          stable identifier, stored in doc_jobs.doc_type,
//                repo_doc_sync.doc_type, the app_settings `doc_types_enabled`
//                list, and the `doc_model_id:<key>` setting. Never change one
//                in place - an in-flight job or a sync row naming the old
//                string would be orphaned (the same hazard as renaming a
//                models.model_id, see app/routes/admin/models.js).
//   label        what the admin screen and the repo Documents page call it.
//   description  one line of admin-facing "what is this document for".
//   docType      the value written to repo_documents.doc_type. Separate from
//                `key` because repo_documents also holds rows this registry
//                does not generate (requirements_log, written inline by
//                requirementsLogService.js), so the two namespaces are not
//                guaranteed to stay in step.
//   callSite     the usage_events.call_site value billed for this type, so
//                /admin/usage can break spend down per document type.
//   systemPrompt the system message handed to the model.
//   buildContext(org, repo, branchName) -> the user message. Owns its own file
//                selection; a type that wants a map-driven or full-tree
//                context does it here without touching the job mechanics.
const repoContext = require('../repoContext');

// A hardcoded allowlist, which is why this doc is thin for a large repo - it
// is written from packaging metadata and a readme. Phase 20's size-aware map
// makes a map-driven selection possible here, but doing it changes generated
// doc content, which is Phase 15's concern and wants its own before/after
// review (see ROADMAP.md Phase 20).
const SPEC_KEY_FILES = ['README.md', 'package.json', 'apex.pipeline.json'];

const SPEC_SYSTEM_PROMPT = [
  "You are Apex's documentation agent. Write a concise Spec / Communication Protocol",
  'document for this repo, for engineers on other teams who integrate with it but do not',
  "work in its codebase day to day. Cover what the repo does, its overall structure, how",
  'to build/test/run it, and its integration surface (APIs it exposes, services it',
  'depends on, message formats) - whatever is actually evident from the material below.',
  'Do not invent details that are not supported by it.',
  '',
  'Respond with the complete document in Markdown, and nothing else.',
].join('\n');

async function buildSpecContext(org, repo, branchName) {
  const tree = await repoContext.fetchTree(org, repo, branchName);

  // A key file clipped at the read cap is labelled as clipped, same as every
  // other reader (see ROADMAP.md Phase 19) - a doc written from the first 8000
  // characters of a long README, presented as the whole thing, describes a repo
  // that doesn't exist. A read that fails or comes back oversized is skipped
  // rather than blocking doc generation, which is this call site's existing
  // degrade-don't-block posture.
  const fileBlocks = [];
  for (const path of SPEC_KEY_FILES) {
    if (!tree.paths.includes(path)) continue;
    const record = await repoContext.readFileForModel(org.name, repo.name, path, branchName);
    if (record.status !== 'ok') continue;
    fileBlocks.push(repoContext.formatFileForModel(path, record));
  }

  return `=== FILE TREE ===\n${repoContext.renderTree(tree)}\n\n${fileBlocks.join('\n\n')}`;
}

const DOC_TYPES = [
  {
    key: 'spec_communication_protocol',
    label: 'Spec / Communication Protocol',
    description:
      'What the repo does, how it is structured, how to build and run it, and the ' +
      'surface other teams integrate against. Written for engineers outside the repo.',
    docType: 'spec_communication_protocol',
    // Deliberately still 'spec_doc' rather than a value derived from `key`:
    // usage_events rows written before Phase 23 carry that string, and
    // changing it would split one document type's spend history in two on
    // /admin/usage.
    callSite: 'spec_doc',
    systemPrompt: SPEC_SYSTEM_PROMPT,
    buildContext: buildSpecContext,
  },
];

function list() {
  return DOC_TYPES;
}

// get(key) -> entry or null. Null is a normal answer, not an error: a key can
// outlive its registry entry in doc_jobs, repo_doc_sync and app_settings (none
// of which can carry a foreign key to a module), so every caller has to be able
// to shrug one off - see the ignore-unknown-keys note in docSettings.js.
function get(key) {
  return DOC_TYPES.find((t) => t.key === key) || null;
}

module.exports = { list, get };
