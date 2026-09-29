// Overlap detection (see notes.md / ROADMAP.md Phase 5): diff the DEV branch
// against the repo's default branch, feed that diff plus this branch's own
// already-confirmed requirement history to the LLM, and ask whether a new
// requirement duplicates work that's already landed.
const db = require('./db');
const githubApi = require('./github/githubApi');
const modelAdapter = require('./model/modelAdapter');

const MAX_DIFF_CHARS = 12000;
const MAX_PATCH_CHARS_PER_FILE = 2000;

// Only requirements that actually proceeded count as "already implemented" -
// a skipped one was judged redundant, and a still-pending one hasn't been
// judged at all, so neither belongs in the pool a new requirement is checked
// against.
async function getPriorRequirements(branchId) {
  const [rows] = await db.query(
    `SELECT sr.id, sr.requirement_text
     FROM session_requirements sr
     JOIN sessions s ON s.id = sr.session_id
     WHERE s.branch_id = ? AND sr.confirm_status = 'confirmed_proceed'
     ORDER BY sr.id ASC`,
    [branchId]
  );
  return rows;
}

function buildDiffText(files) {
  return files
    .map((f) => `--- ${f.filename} ---\n${(f.patch || '(binary or too large to diff)').slice(0, MAX_PATCH_CHARS_PER_FILE)}`)
    .join('\n\n')
    .slice(0, MAX_DIFF_CHARS);
}

// Tolerant parse: the model is asked for strict JSON but nothing here is
// authoritative (see notes.md accepted risk #7 - overlap judgment is a
// heuristic a human confirms/overrides, never an auto-skip) so a parse
// failure fails open to "no overlap detected" rather than blocking the user.
function parseVerdict(raw) {
  try {
    const parsed = JSON.parse(raw.trim());
    if (typeof parsed.overlaps === 'boolean') {
      const id = Number(parsed.matchedRequirementId);
      return { overlaps: parsed.overlaps, matchedRequirementId: Number.isInteger(id) ? id : null };
    }
  } catch (err) {
    // fall through to regex fallback below
  }
  const overlapMatch = raw.match(/"overlaps"\s*:\s*(true|false)/i);
  if (!overlapMatch) return null;
  const idMatch = raw.match(/"matchedRequirementId"\s*:\s*(\d+)/);
  return {
    overlaps: overlapMatch[1].toLowerCase() === 'true',
    matchedRequirementId: idMatch ? Number(idMatch[1]) : null,
  };
}

// checkOverlap(...) -> { matchedRequirementId } if overlap detected, else null.
async function checkOverlap({ org, repo, branch, newRequirementText }) {
  let diff;
  try {
    diff = await githubApi.compareCommits(org.name, repo.name, repo.default_branch_name, branch.branch_name);
  } catch (err) {
    return null; // can't diff - don't block the clarification loop on a GitHub error
  }
  if (!diff.files.length) return null; // nothing implemented on this branch yet - nothing to overlap with

  const priorRequirements = await getPriorRequirements(branch.id);
  if (!priorRequirements.length) return null; // implemented work exists but nothing to attribute it to

  const prompt = [
    'You are checking whether a new requirement for a Change Order duplicates work that is',
    "already implemented on this branch. Below is the branch's diff against the repo's",
    'default branch, followed by the requirements already confirmed for this branch, followed',
    'by the new requirement.',
    '',
    '=== DIFF (branch vs. default branch) ===',
    buildDiffText(diff.files),
    '',
    '=== ALREADY-CONFIRMED REQUIREMENTS ===',
    priorRequirements.map((r) => `[#${r.id}] ${r.requirement_text}`).join('\n'),
    '',
    '=== NEW REQUIREMENT ===',
    newRequirementText,
    '',
    'Respond with ONLY a JSON object, no prose, no markdown fences:',
    '{"overlaps": true|false, "matchedRequirementId": <id from the list above, or null>}',
  ].join('\n');

  let raw;
  try {
    raw = await modelAdapter.generate([{ role: 'user', content: prompt }]);
  } catch (err) {
    return null; // model failure shouldn't block the clarification loop
  }

  const verdict = parseVerdict(raw);
  if (!verdict || !verdict.overlaps) return null;

  const matched = priorRequirements.find((r) => r.id === verdict.matchedRequirementId);
  return { matchedRequirementId: matched ? matched.id : null };
}

module.exports = { checkOverlap, getPriorRequirements };
