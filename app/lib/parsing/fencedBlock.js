// Shared fenced-code-block extraction helper for the model's structured-
// output convention (see agent-prompts.md's "Phase 3" and "Phase 4"
// sections). The model adapter is free-text-only (no tool-calling - see
// app/lib/model/modelAdapter.js), so every structured reply is recovered by
// matching a labeled fenced code block and parsing its contents as JSON.
// Used by both app/lib/branches/responseParsing.js (Phase 3) and
// app/lib/pipeline/pipelineResponseParsing.js (Phase 4) so the same
// tag-matching regex isn't duplicated per phase.

function extractFencedBlock(replyText, tag) {
  if (typeof replyText !== 'string') return null;
  const pattern = new RegExp('```' + tag + '\\s*\\n([\\s\\S]*?)\\n?```', 'i');
  const match = replyText.match(pattern);
  return match ? match[1].trim() : null;
}

module.exports = { extractFencedBlock };
