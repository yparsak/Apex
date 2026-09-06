// Deterministic parsing for the fenced-code-block convention Phase 3 uses to
// get structured output out of a model adapter that only returns free text
// (see app/lib/model/modelAdapter.js - there is no tool-calling contract to
// build on, by design). See agent-prompts.md's "Phase 3" section for the
// documented convention this implements, and
// app/lib/branches/clarificationPrompts.js for the prompts that instruct the
// model to follow it.
//
// Fail-safe by construction: any parse failure or ambiguity returns null,
// never a partial/best-guess result. Callers are responsible for what "null"
// means in their context - "not finalized yet, treat as a clarifying
// question" for requirements-ready, or "fail closed to pending_confirm" for
// overlap-check - see app/lib/branches/sessionService.js. This module never
// makes that judgment call itself.

const { REQUIREMENTS_READY_TAG, OVERLAP_CHECK_TAG } = require('./clarificationPrompts');

function extractFencedBlock(replyText, tag) {
  if (typeof replyText !== 'string') return null;
  const pattern = new RegExp('```' + tag + '\\s*\\n([\\s\\S]*?)\\n?```', 'i');
  const match = replyText.match(pattern);
  return match ? match[1].trim() : null;
}

function parseRequirementsReady(replyText) {
  const block = extractFencedBlock(replyText, REQUIREMENTS_READY_TAG);
  if (block === null) return null;

  let parsed;
  try {
    parsed = JSON.parse(block);
  } catch (err) {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  const requirements = [];
  for (const item of parsed) {
    if (typeof item !== 'string' || item.trim().length === 0) return null;
    requirements.push(item.trim());
  }
  return requirements;
}

// expectedCount: the model must account for every candidate index exactly
// once, or the whole result is treated as unparseable (fail closed) - a
// partial/mismatched result is exactly the kind of ambiguity this module
// refuses to guess through.
function parseOverlapCheck(replyText, expectedCount) {
  const block = extractFencedBlock(replyText, OVERLAP_CHECK_TAG);
  if (block === null) return null;

  let parsed;
  try {
    parsed = JSON.parse(block);
  } catch (err) {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const results = new Map();
  for (const item of parsed) {
    if (!item || typeof item !== 'object') return null;

    const { requirementIndex, duplicate } = item;
    if (!Number.isInteger(requirementIndex) || typeof duplicate !== 'boolean') return null;
    if (duplicate && !Number.isInteger(item.duplicateOfRequirementId)) return null;
    if (results.has(requirementIndex)) return null; // ambiguous - same index reported twice

    results.set(requirementIndex, {
      duplicate,
      duplicateOfRequirementId: duplicate ? item.duplicateOfRequirementId : null,
      reason: typeof item.reason === 'string' ? item.reason : null,
    });
  }

  for (let i = 0; i < expectedCount; i++) {
    if (!results.has(i)) return null;
  }
  return results;
}

module.exports = { parseRequirementsReady, parseOverlapCheck };
