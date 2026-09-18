// Deterministic parsing for Phase 5's Spec/Communication Protocol doc
// decision + generation replies - same fail-safe-by-construction convention
// Phase 3/4 already established (see app/lib/branches/responseParsing.js,
// app/lib/pipeline/pipelineResponseParsing.js, and agent-prompts.md's
// "Phase 5" section): any parse failure or ambiguous shape returns null,
// never a partial or best-guess result.
//
// Fail-closed is especially deliberate for parseSpecDecision: an unparseable
// reply must NOT be silently treated as "no API surface" (which would skip
// generating a doc that should exist) or as "doc is stale" (which would
// regenerate one that didn't need it, papering over a doc-currency judgment
// the model never actually made). Both are guesses this project refuses to
// make - see specDocService.js, which turns a null result here into a
// pipeline failure (SPEC_DECISION_PARSE_FAILED), the same way Phase 4 turns
// an unparseable files-needed/file-changes reply into
// CODEGEN_PARSE_FAILED.
//
// The fenced-block extraction itself is shared with Phase 3/4's parsers via
// app/lib/parsing/fencedBlock.js.

const { extractFencedBlock } = require('../parsing/fencedBlock');
const { SPEC_DECISION_TAG, SPEC_DOCUMENT_TAG } = require('./specDocPrompts');

function parseSpecDecision(replyText) {
  const block = extractFencedBlock(replyText, SPEC_DECISION_TAG);
  if (block === null) return null;

  let parsed;
  try {
    parsed = JSON.parse(block);
  } catch (err) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const { hasApiSurface, docIsCurrent } = parsed;
  if (typeof hasApiSurface !== 'boolean' || typeof docIsCurrent !== 'boolean') return null;

  return { hasApiSurface, docIsCurrent };
}

// Unlike the JSON tags elsewhere in this project, spec-document content is
// plain Markdown prose, not JSON - the block's trimmed text content IS the
// parsed result. An empty block is treated as a parse failure (null), same
// as every other "the model didn't give us something usable" case.
function parseSpecDocument(replyText) {
  const block = extractFencedBlock(replyText, SPEC_DOCUMENT_TAG);
  if (block === null || block.length === 0) return null;
  return block;
}

module.exports = { parseSpecDecision, parseSpecDocument };
