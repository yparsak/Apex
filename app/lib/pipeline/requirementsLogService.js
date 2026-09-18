// Phase 5: mechanical, model-free maintenance of the branch's requirements
// log (see roadmap.md's "User requirements log" row and agent-prompts.md's
// "Phase 5" section). This is a RAW, user-authored record - "what was
// asked" - built entirely from this session's already-confirmed
// session_requirements content plus a heading per CO number. No model call
// is made here, unlike specDocService.js: there is no judgment to make,
// only "append this session's confirmed text under this CO's heading."
//
// Distinct artifact from the Spec/Communication Protocol doc
// (specDocService.js), which IS model-authored from code analysis - see
// roadmap.md's explicit "Distinct from the requirements log" note on that
// row.
//
// Text manipulation is intentionally simple, not a Markdown parser: find the
// "## {CO}" heading (or create one at EOF if this CO hasn't been logged on
// this branch yet), then insert the new entry immediately before the next
// "## " heading (or at EOF if this is the last section). That's sufficient
// because this module is the only writer of this file's structure - it never
// has to cope with arbitrary heading levels or formatting some other tool
// produced.

const fs = require('fs/promises');
const path = require('path');
const { REQUIREMENTS_LOG_PATH } = require('./deliveryPaths');

const HEADING_PATTERN = /^##\s+(.+)$/;

const FILE_HEADER =
  '# Apex user requirements log\n\n' +
  'Raw, chronological record of what was asked, organized under a heading per change order. Append-only - ' +
  'entries are never edited or removed by Apex. Distinct from the Spec/Communication Protocol document (under ' +
  'docs/apex-spec/), which is model-authored from code analysis, not from raw user input - see ' +
  "agent-prompts.md's \"Phase 5\" section.\n";

// Finds the "## {heading}" line and returns the index range [start, end) of
// its section's *body* (everything after the heading line, up to but not
// including the next "## " heading, or EOF) - or null if no such heading
// exists yet.
function findSectionBodyRange(lines, heading) {
  let headingIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(HEADING_PATTERN);
    if (match && match[1].trim() === heading) {
      headingIndex = i;
      break;
    }
  }
  if (headingIndex === -1) return null;

  let sectionEnd = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (HEADING_PATTERN.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }
  return { start: headingIndex + 1, end: sectionEnd };
}

// Appends `entryText` under the "## {heading}" section of `content`,
// creating that heading at the end of the file if it doesn't exist yet.
// Never touches any other section's content.
function appendEntryUnderHeading(content, heading, entryText) {
  const lines = content.length > 0 ? content.split('\n') : [];
  const range = findSectionBodyRange(lines, heading);

  if (range === null) {
    const trimmed = content.replace(/\s+$/, '');
    const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : '';
    return `${prefix}## ${heading}\n\n${entryText}\n`;
  }

  const before = lines.slice(0, range.end);
  const after = lines.slice(range.end);
  // Trim trailing blank lines from this section's existing body so we don't
  // accumulate ever-growing gaps between entries on repeated appends.
  while (before.length > range.start && before[before.length - 1].trim() === '') before.pop();

  return [...before, '', entryText, '', ...after].join('\n');
}

function formatEntry({ branch, session, submittedBy, requirements }) {
  const timestamp = new Date().toISOString();
  const bullets = requirements.map((r) => `- ${r}`).join('\n');
  return (
    `### ${branch.branchName} — session ${session.id} — ${timestamp}\n\n` +
    `Submitted by ${submittedBy.username} (${submittedBy.initials}).\n\n` +
    `${bullets}`
  );
}

// Pure text transform (exported for testability) - given the log's current
// content (or null if the file doesn't exist yet) and this session's
// confirmed requirements, returns the full updated file content.
function buildUpdatedRequirementsLog({ existingContent, branch, session, submittedBy, requirements }) {
  const base = existingContent === null ? `${FILE_HEADER}\n` : existingContent;
  const entry = formatEntry({ branch, session, submittedBy, requirements });
  return appendEntryUnderHeading(base, branch.coNumber, entry);
}

// Reads the log from the working tree (if present), appends this session's
// confirmed requirements under the current CO's heading, and returns a
// ready-to-commit change object in the same shape pipelineService.js's other
// `changes` entries use - so it can be folded straight into the same
// commitAndPushChanges call as the code changes and the spec doc.
async function buildRequirementsLogChange({ treeDir, branch, session, submittedBy, requirements }) {
  const targetPath = path.join(treeDir, REQUIREMENTS_LOG_PATH);

  let existingContent = null;
  try {
    existingContent = await fs.readFile(targetPath, 'utf-8');
  } catch (err) {
    existingContent = null; // File doesn't exist yet on this branch - create it.
  }

  const content = buildUpdatedRequirementsLog({ existingContent, branch, session, submittedBy, requirements });

  return {
    path: REQUIREMENTS_LOG_PATH,
    action: existingContent === null ? 'create' : 'modify',
    content,
  };
}

module.exports = { buildUpdatedRequirementsLog, buildRequirementsLogChange };
