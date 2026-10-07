// Anchored, line-ranged writes (see ROADMAP.md Phase 21).
//
// The problem this solves is an output ceiling, not an input one. Codegen's
// only write verb through Phase 20 was WRITE_FILE, which restates the file
// whole - so editing 20 lines of a 3000-line file costs 3000 lines of model
// output, and the provider's max_tokens cuts the reply off somewhere in the
// middle (Phase 19 now at least discards that reply instead of writing it).
// An anchored write costs 20 lines of output for a 20-line edit, which is what
// makes a large file editable at all.
//
// **The anchor is the safety property, and it is the whole reason this is not
// "send a unified diff and git apply it".** The model states the exact text it
// believes occupies the lines it is replacing. If that text does not match
// what is actually on those lines, the write is refused back as a turn - with
// the real contents attached - rather than applied at a guessed offset. A
// patch protocol that fuzzes the offset to make the hunk fit is precisely the
// failure mode this must not have, because the result gets pushed to a real
// branch under an engineer's CO number.
//
// Note what the anchor also buys: it is itself proof the model has seen those
// lines. Phase 19's guard exists because a whole-file write can destroy
// unseen content; a ranged write cannot touch a line outside its range, and
// cannot touch a line inside its range without having reproduced it first. So
// a ranged write needs no prior-read bookkeeping - the anchor is the evidence,
// and reproducing 20 exact lines by guess is not a realistic failure.
//
// Everything here is pure: parse text, splice strings. The container I/O lives
// in codegenService, which is also where the refusals are fed back as turns.
const repoContext = require('../repoContext');

// The line model is repoContext's, not this module's. It was this module's
// first, and that was a latent bug of exactly the kind this phase is about:
// two components that each define "line N" will eventually disagree, and the
// disagreement shows up as an edit landing one line off. repoContext owns
// where a file is cut (Phase 19) and now also owns how it is counted.
const { splitLines, joinLines } = repoContext;

// Caps. The anchor cap bounds what the model has to restate (which is the cost
// this phase exists to remove, so a 2000-line anchor would defeat the point);
// the replacement cap is a sanity bound only - the provider's output limit
// binds long before it.
const MAX_ANCHOR_LINES = 300;
const MAX_REPLACEMENT_LINES = 1000;

const DIRECTIVE = /^REPLACE_LINES:[ \t]*(\S+?):(\d+)-(\d+)[ \t]*\r?\n([\s\S]*)$/;
const SECTIONS = /^---[ \t]*EXPECTED[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*REPLACEMENT[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*END[ \t]*\r?\n?$/;

// Trailing whitespace is normalized away before comparison; leading whitespace
// is not. The asymmetry is deliberate: leading whitespace is semantic in
// Python, YAML and Make, so a mismatch there is a real disagreement about the
// file and must refuse. Trailing whitespace is semantic nowhere and is exactly
// what a model silently drops when restating a line - treating that as a
// mismatch would produce the anchor-mismatch loop this protocol has to avoid.
// Accepting it is safe because the anchor is only ever *evidence*: what gets
// written is the replacement text, never the normalized anchor.
function normalizeAnchorLine(line) {
  return line.replace(/[ \t\r]+$/, '');
}

function anchorsMatch(actualLines, expectedLines) {
  if (actualLines.length !== expectedLines.length) return false;
  for (let i = 0; i < actualLines.length; i++) {
    if (normalizeAnchorLine(actualLines[i]) !== normalizeAnchorLine(expectedLines[i])) return false;
  }
  return true;
}

// parseDirective(reply) -> null if this reply is not a REPLACE_LINES at all,
// { error } if it is one but malformed, or the parsed directive. The
// three-way return matters: codegenService must not answer "unrecognized
// response" to a directive the model clearly intended, or it will retry the
// same malformed shape until it runs out of turns.
function parseDirective(reply) {
  const head = reply.match(DIRECTIVE);
  if (!head) {
    if (/^REPLACE_LINES\b/.test(reply)) {
      return {
        error: [
          'Malformed REPLACE_LINES. The first line must be exactly',
          '`REPLACE_LINES: <path>:<startLine>-<endLine>` - both line numbers are required, even',
          'for a single line (use `:42-42`), and nothing else may share that line.',
        ].join('\n'),
      };
    }
    return null;
  }

  const [, path, startText, endText, body] = head;
  const sections = body.match(SECTIONS);
  if (!sections) {
    return {
      error: [
        'Malformed REPLACE_LINES body. After the first line it must be exactly these three',
        'markers, each alone on its own line, in this order:',
        '--- EXPECTED',
        '<the current contents of those lines, exactly as Apex showed them to you>',
        '--- REPLACEMENT',
        '<what those lines should become; leave empty to delete them>',
        '--- END',
      ].join('\n'),
    };
  }

  const start = Number(startText);
  const end = Number(endText);
  const expectedRaw = sections[1];
  const replacementRaw = sections[2];

  if (start < 1) return { error: 'Line numbers start at 1.' };
  if (end < start) return { error: `Invalid range ${start}-${end}: the end line is before the start line.` };

  // An empty EXPECTED section is rejected rather than read as "replace these
  // lines with no anchor at all" - an anchorless ranged write is a blind write
  // at a guessed offset, which is the one thing this protocol exists to
  // prevent. Deleting lines is still expressible: EXPECTED carries them,
  // REPLACEMENT is empty.
  if (expectedRaw === '') {
    return {
      error: [
        'The EXPECTED section is empty. It must contain the current contents of lines',
        `${start}-${end}, which is how Apex verifies the write lands where you think it does.`,
        'To delete those lines, put them in EXPECTED and leave REPLACEMENT empty.',
      ].join('\n'),
    };
  }

  const expectedLines = expectedRaw.split('\n');
  const replacementLines = replacementRaw === '' ? [] : replacementRaw.split('\n');

  if (end - start + 1 > MAX_ANCHOR_LINES) {
    return {
      error: [
        `Range ${start}-${end} is ${end - start + 1} lines, over the ${MAX_ANCHOR_LINES}-line limit for a single`,
        'REPLACE_LINES. Split the edit into several smaller ranged writes, working from the',
        'bottom of the file upwards so earlier edits do not shift the line numbers of later ones.',
      ].join('\n'),
    };
  }
  if (replacementLines.length > MAX_REPLACEMENT_LINES) {
    return { error: `The REPLACEMENT section is ${replacementLines.length} lines, over the ${MAX_REPLACEMENT_LINES}-line limit.` };
  }
  if (expectedLines.length !== end - start + 1) {
    return {
      error: [
        `You named lines ${start}-${end} (${end - start + 1} lines) but the EXPECTED section has`,
        `${expectedLines.length}. They must agree exactly - the range and the anchor are two statements`,
        'about the same lines, and Apex will not guess which one you meant.',
      ].join('\n'),
    };
  }

  return { path, start, end, expectedLines, replacementLines };
}

// applyDirective(content, directive) -> { ok: true, content, ... } or
// { ok: false, reason, actualLines }. The caller turns a failure into a model
// turn that quotes `actualLines`, so an anchor mismatch is self-correcting on
// the next attempt rather than a loop.
function applyDirective(content, { start, end, expectedLines, replacementLines }) {
  const { lines, endsWithNewline } = splitLines(content);

  if (end > lines.length) {
    return {
      ok: false,
      reason: `the file has ${lines.length} lines, so lines ${start}-${end} do not all exist`,
      totalLines: lines.length,
      actualLines: null,
    };
  }

  const actualLines = lines.slice(start - 1, end);
  if (!anchorsMatch(actualLines, expectedLines)) {
    return {
      ok: false,
      reason: `the EXPECTED text does not match what is actually on lines ${start}-${end}`,
      totalLines: lines.length,
      actualLines,
    };
  }

  const next = lines.slice(0, start - 1).concat(replacementLines, lines.slice(end));
  return {
    ok: true,
    content: joinLines(next, endsWithNewline),
    totalLines: next.length,
    previousTotalLines: lines.length,
    lineDelta: next.length - lines.length,
  };
}

module.exports = {
  MAX_ANCHOR_LINES,
  MAX_REPLACEMENT_LINES,
  splitLines,
  joinLines,
  anchorsMatch,
  parseDirective,
  applyDirective,
};
