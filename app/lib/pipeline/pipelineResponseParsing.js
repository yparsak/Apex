// Deterministic parsing for Phase 4's two-step, non-tool-calling
// code-generation protocol - same fail-safe-by-construction convention
// Phase 3 established (see app/lib/branches/responseParsing.js and
// agent-prompts.md's Phase 3/Phase 4 sections): any parse failure or
// ambiguity returns null, never a partial or best-guess result. Shares the
// fenced-block extraction helper with Phase 3's parser
// (app/lib/parsing/fencedBlock.js) rather than re-implementing the same
// regex.
//
// Path safety is enforced here, at parse time, not deferred to the fs-write
// step - an unsafe path (attempting to escape the extracted working tree)
// fails the whole batch closed, the same way a malformed shape does,
// because it's exactly the kind of ambiguity/untrustworthy model output this
// module refuses to guess through.

const path = require('path');
const { extractFencedBlock } = require('../parsing/fencedBlock');
const { FILES_NEEDED_TAG, FILE_CHANGES_TAG } = require('./pipelinePrompts');

const VALID_ACTIONS = new Set(['create', 'modify', 'delete']);

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  if (value.includes('\0')) return false;
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) return false;
  return true;
}

function normalizePath(value) {
  return path.posix.normalize(value.replace(/\\/g, '/'));
}

// expectedCount is intentionally not enforced here (unlike
// responseParsing.js's parseOverlapCheck) - an empty files-needed array is a
// legitimate, unambiguous answer (see pipelinePrompts.js), not something to
// fail closed on.
function parseFilesNeeded(replyText) {
  const block = extractFencedBlock(replyText, FILES_NEEDED_TAG);
  if (block === null) return null;

  let parsed;
  try {
    parsed = JSON.parse(block);
  } catch (err) {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const paths = [];
  for (const item of parsed) {
    if (!isSafeRelativePath(item)) return null;
    paths.push(normalizePath(item));
  }
  return paths;
}

function parseFileChanges(replyText) {
  const block = extractFencedBlock(replyText, FILE_CHANGES_TAG);
  if (block === null) return null;

  let parsed;
  try {
    parsed = JSON.parse(block);
  } catch (err) {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  const seen = new Set();
  const changes = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') return null;

    const { path: rawPath, action, content } = item;
    if (!isSafeRelativePath(rawPath)) return null;
    if (!VALID_ACTIONS.has(action)) return null;
    if ((action === 'create' || action === 'modify') && typeof content !== 'string') return null;

    const normalized = normalizePath(rawPath);
    if (seen.has(normalized)) return null; // ambiguous - same path reported twice
    seen.add(normalized);

    changes.push({ path: normalized, action, content: action === 'delete' ? null : content });
  }
  return changes;
}

module.exports = { parseFilesNeeded, parseFileChanges };
