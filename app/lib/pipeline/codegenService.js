// Codegen step of the sandboxed pipeline (see notes.md / ROADMAP.md Phase 7).
//
// **Phase 21 inverted where reads come from, and that is the thing to know
// before reading anything else here.** Through Phase 20 this loop served every
// read from GitHub and sent every write into the container: the clone Phase 7
// makes and the model's view of the repo were disjoint by design. That is now
// reversed - the container is the only source of bytes. Three things forced
// it, in increasing order of importance:
//
//   1. The clone was already there and nobody read it, while the GitHub path
//      cost an API call per fetch and capped out at the contents API's 1 MB.
//   2. A file the model wrote earlier in the session needed a special case
//      (an in-memory overlay map) to be readable at all. Reading the container
//      makes that case disappear rather than handling it.
//   3. **Line numbers.** Ranged reads and anchored writes both address lines
//      by number. Serving a range from GitHub while writing into the container
//      means the two drift apart the moment the model makes one edit - it
//      would be reading coordinates from one artifact and writing into
//      another. There is no safe version of that, so there is only one source.
//
// What the model can do each turn: fetch a whole file, fetch a line range,
// fetch a file's outline, replace a whole file, replace a line range, or
// finish. Phase 19's whole-file-write guard is unchanged and still the
// backstop; Phase 21 simply gives the model something to do other than give
// up when the guard refuses.
const modelAdapter = require('../model/modelAdapter');
const usageService = require('../model/usageService');
const dockerRunner = require('../docker/dockerRunner');
const repoClarificationInstructions = require('../repoClarificationInstructions');
const repoContext = require('../repoContext');
const structuralIndex = require('../structuralIndex');
const rangedWrite = require('./rangedWrite');
const { processLogger } = require('../logger');

const MAX_TURNS = 40;
const MAX_CUT_OFF_REPLIES = 2;

// The read-modify-write ceiling for an anchored write. Larger than anything
// the contents API would have served (its limit was 1 MB) because the file is
// simply on local disk here, and small enough that one pathological file
// cannot pull tens of megabytes through a docker exec pipe. Note this bounds
// the *file*, not the edit: a 20-line change to a 1.5 MB file is fine.
const MAX_CONTAINER_FILE_BYTES = 2 * 1024 * 1024;

const SYSTEM_PROMPT = [
  "You are Apex's code-generation agent. An engineer's requirements below have",
  'already been clarified and confirmed; implement them now, directly in this',
  "repo's working tree, inside an isolated sandbox.",
  '',
  "You are given the repo's file tree, with each file's size and line count. You do not",
  "have any file's contents unless you request them. Every read below is served from the",
  'working tree as it stands right now, including your own edits from earlier this',
  'session, so the line numbers you are shown are always the live ones.',
  '',
  'Respond using exactly ONE of these on every turn, and nothing else:',
  '',
  '1. Read a whole file: a single line, exactly `FETCH_FILE: <path>`.',
  '2. Read part of a file: a single line, exactly `FETCH_RANGE: <path>:<start>-<end>`, with',
  '   1-based inclusive line numbers. Prefer this for any large file - pull the regions you',
  `   need, not the whole file. At most ${repoContext.MAX_RANGE_LINES} lines per request.`,
  "3. List a file's structure: a single line, exactly `FETCH_OUTLINE: <path>`. Returns the",
  "   file's declaration lines with their line ranges - the cheapest way to find where in a",
  '   long file to look before reading a range of it.',
  '4. Replace part of a file:',
  '       REPLACE_LINES: <path>:<start>-<end>',
  '       --- EXPECTED',
  '       <the current contents of exactly those lines, as Apex showed them to you>',
  '       --- REPLACEMENT',
  '       <what those lines should become; leave this section empty to delete them>',
  '       --- END',
  '   The EXPECTED text is checked against the file before anything is written. If it does',
  '   not match, nothing is written and you are told what is actually there. Do not include',
  '   the line-number prefixes Apex adds when displaying a range - they are not in the file.',
  '   To insert without deleting, replace a line with itself plus your new lines.',
  '   When making several edits to one file, work from the bottom upwards, so an earlier',
  '   edit does not shift the line numbers of a later one.',
  '5. Replace a whole file: a single line `WRITE_FILE: <path>`, then a newline, then the',
  "   COMPLETE new contents of that file (this replaces the file's entire contents). <path>",
  '   must be relative to the repo root, with no leading `/` and no `..` segment.',
  '6. Finish: once every requirement below is fully implemented, write `DONE` and nothing else.',
  '',
  'WRITE_FILE replaces everything, so it is only accepted for a file you have fully seen:',
  'one you fetched and were shown in its entirety, one you wrote in full earlier this',
  'session, or a new file that does not exist yet. For any file too large to be shown in',
  'full, use REPLACE_LINES - that is what it is for, and it has no size limit on the file',
  'it edits. Prefer REPLACE_LINES over WRITE_FILE for any substantial existing file even',
  'when both are allowed: a targeted edit is easier to review and cannot accidentally drop',
  'code you did not mean to change.',
  '',
  'Make the smallest set of changes that fully satisfies the requirements. Do not ask',
  'questions - if something is ambiguous, make the most reasonable implementation choice.',
].join('\n');

function buildSystemMessage(map, index, instructions, requirementsText) {
  const treeBlock = repoContext.renderTree(map, index);
  const instructionsBlock = instructions
    ? `\n\n=== ADMIN CLARIFICATION INSTRUCTIONS (authoritative) ===\n${instructions}`
    : '';
  return `${SYSTEM_PROMPT}\n\n=== FILE TREE ===\n${treeBlock}${instructionsBlock}\n\n=== REQUIREMENTS TO IMPLEMENT ===\n${requirementsText}`;
}

function isUnsafePath(path) {
  return path.startsWith('/') || path.split('/').some((seg) => seg === '..' || seg === '');
}

// Phase 19's rule, as a decision: never whole-file-replace a file the model
// did not fully see. Returns null to allow the write, or the refusal text to
// feed back as a turn. The four grounds for allowing it are all cases where
// nothing unseen can be destroyed, and all four survive Phase 21 unchanged:
//   - the model wrote this path in full earlier this session, so it authored
//     all of it
//   - it read the path and was shown the entire file
//   - it read the path and the file genuinely does not exist, so this creates it
//   - it never read the path, but the path is absent from a *complete* file
//     tree, which is equally proof the file does not exist. Still sound now
//     that reads come from the container rather than GitHub: the tree is a
//     snapshot of the branch tip, which is exactly what the container was
//     cloned from, and the only paths that can have appeared since are ones
//     this session created - which are in `written` and caught above.
//
// What Phase 21 does change is what a refusal *means*. It is no longer "this
// file cannot be edited through this interface" - every refusal below now
// points at REPLACE_LINES, which can edit a file of any size without ever
// restating the parts the model has not seen.
function refuseWriteReason({ path, written, reads, tree }) {
  if (written.has(path)) return null;

  const record = reads.get(path);
  if (repoContext.fullyRead(record)) return null;
  if (record && record.status === 'missing') return null;

  if (!record) {
    if (tree.complete && !tree.paths.includes(path)) return null;
    return [
      `Refusing to write "${path}" - WRITE_FILE replaces the file's entire contents, and you`,
      'have not read this file, so Apex cannot confirm whether it already exists or what it',
      `contains. Read it first with \`FETCH_FILE: ${path}\`, then write it.`,
    ].join('\n');
  }

  if (record.status === 'ok' && record.truncated) {
    return [
      `Refusing to write "${path}" - you were shown only the first ${record.shownChars} characters`,
      `(lines 1-${record.shownLines}) of a ${record.totalLines}-line file, so writing its complete`,
      `contents would delete the ${record.totalLines - record.shownLines} lines you never saw.`,
      `Edit this file with REPLACE_LINES instead: read the part you need with \`FETCH_RANGE: ${path}:<start>-<end>\``,
      `(or start from \`FETCH_OUTLINE: ${path}\`), then replace just those lines. A ranged write has`,
      'no file-size limit, because it never touches a line you did not reproduce.',
    ].join('\n');
  }

  if (record.status === 'too_large') {
    return [
      `Refusing to write "${path}" - the file is ${record.bytes} bytes, over the limit for reading or`,
      'rewriting a file whole, so none of its contents are known here and a WRITE_FILE would',
      'delete all of it. REPLACE_LINES is also unavailable on a file this size. Leave it alone.',
    ].join('\n');
  }

  if (record.status === 'binary') {
    return `Refusing to write "${path}" - it is a binary file, not text. Leave it alone.`;
  }

  return [
    `Refusing to write "${path}" - the attempt to read it failed (${record.reason}), so Apex`,
    'cannot tell whether the file exists or what it contains, and a write would replace',
    'contents it never saw. Leave this file alone.',
  ].join('\n');
}

// --- Container-backed reads ---------------------------------------------

// readWholeFile(...) -> { record, content }. `record` is the Phase 19 read
// record the write guard consumes (clipped at MAX_FILE_CHARS, with truncation
// announced); `content` is the *unclipped* text, or null when there isn't any.
// Keeping both apart is the point: the guard and the prompt must only ever see
// the clipped half, while a ranged read and an anchored write need the real
// file. Collapsing them is how a ranged write ends up splicing into the first
// 8000 characters of a file and discarding the rest.
async function readWholeFile(containerId, repoRoot, path) {
  const raw = await dockerRunner.readFile(containerId, `${repoRoot}/${path}`, { maxBytes: MAX_CONTAINER_FILE_BYTES });
  switch (raw.status) {
    case 'ok':
      return { record: repoContext.recordFromText(raw.content), content: raw.content };
    case 'missing':
      return { record: { status: 'missing' }, content: null };
    case 'not_file':
      return { record: { status: 'error', reason: 'that path is a directory, not a file' }, content: null };
    case 'too_large':
      return { record: { status: 'too_large', bytes: raw.bytes }, content: null };
    case 'binary':
      return { record: { status: 'binary', bytes: raw.bytes }, content: null };
    default:
      return { record: { status: 'error', reason: raw.reason }, content: null };
  }
}

// --- The loop ------------------------------------------------------------

// runCodegen({...}) -> string[] of repo-relative paths changed. Throws (never
// returns a partial result) if the model doesn't emit DONE within MAX_TURNS,
// or emits DONE without changing anything - the caller treats either as a
// codegen-stage pipeline failure, same as any other step failure.
// `model` is the one stamped on this run's session (see db/schema.sql Phase
// 22), threaded in from pipelineRunner rather than resolved here: codegen runs
// in worker.js minutes after the user approved, and must use the model that
// approval was made with, not whatever the user has selected by then.
async function runCodegen({ containerId, org, repo, branch, repoRoot, requirementsText, sessionId, model }) {
  const log = processLogger().child({ sessionId, repoId: repo.id });

  const [tree, instructions] = await Promise.all([
    repoContext.fetchTree(org, repo, branch.branch_name),
    repoClarificationInstructions.getInstructions(repo.id),
  ]);

  // Built before the first model turn, so the tree in the system prompt can
  // carry exact line counts. Failure is logged and otherwise ignored: without
  // an index the tree falls back to Phase 20's estimates and FETCH_OUTLINE
  // answers "no outline", while ranged reads and anchored writes - which read
  // and verify against the container directly - are unaffected. An index is a
  // navigation aid; nothing's correctness rests on it (see structuralIndex.js).
  const index = await structuralIndex.buildIndex({ containerId, repoRoot });
  if (index.available) {
    structuralIndex.saveIndex(repo.id, tree.sha, index).catch(() => {});
    log.info({ indexedFiles: index.fileCount, sha: tree.sha }, 'structural index built');
  } else {
    log.warn({ reason: index.reason }, 'structural index unavailable - codegen continues without outlines');
  }

  const messages = [{ role: 'system', content: buildSystemMessage(tree, index, instructions, requirementsText) }];
  // Phase 19's bookkeeping, narrowed by Phase 21 to what it is actually for:
  // `written` is "the model authored this entire file", which is the only
  // thing that licenses a later WRITE_FILE without a re-read. `reads` is what
  // the model has been shown. `edited` is paths changed by ranged writes -
  // tracked for the return value, and deliberately NOT a licence for a
  // whole-file write, since a ranged edit proves the model saw 20 lines, not
  // 3000.
  const written = new Map();
  const reads = new Map();
  const edited = new Set();

  const changedPaths = () => Array.from(new Set([...written.keys(), ...edited]));

  let cutOffReplies = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let result;
    try {
      result = await modelAdapter.generate(messages, { model });
    } catch (err) {
      // A reply the provider cut short at max_tokens is a failed turn, not a
      // result (see ROADMAP.md Phase 19): its body ends mid-token, and a
      // WRITE_FILE carried by it would be written verbatim over a real file.
      // The truncated text is discarded rather than appended, so nothing
      // half-finished enters the transcript, and the model gets one chance to
      // produce something that fits. MAX_CUT_OFF_REPLIES bounds it, because
      // retrying a file that is simply too big to emit can't converge - which
      // is exactly why the nudge now names REPLACE_LINES: since Phase 21 there
      // genuinely is a smaller way to say the same edit.
      if (err.finishReason !== 'length' || ++cutOffReplies > MAX_CUT_OFF_REPLIES) throw err;
      messages.push({
        role: 'user',
        content: [
          'Your previous reply was cut off by the output-length limit before it finished, so it',
          'was discarded entirely - nothing was written. Say the same edit in less output: use',
          'REPLACE_LINES to change only the lines that differ instead of restating a whole file,',
          'or split the work across several turns. Write DONE if the remaining work does not fit.',
        ].join('\n'),
      });
      continue;
    }
    // Trimmed for dispatch and for the transcript, as it always was. The
    // left-trimmed-only copy exists for WRITE_FILE's payload: a full trim
    // silently ate the trailing newline off every file codegen ever wrote
    // whole, so each one landed with "\ No newline at end of file" in its
    // diff. That was survivable while whole-file replace was the only write
    // verb; now that REPLACE_LINES deliberately preserves a file's trailing
    // newline, the two verbs would disagree about the same file depending on
    // which one last touched it.
    const leftTrimmed = result.text.replace(/^[ \t\r\n]+/, '');
    const reply = leftTrimmed.replace(/[ \t\r\n]+$/, '');
    usageService
      .recordUsage({
        callSite: 'codegen',
        sessionId,
        repoId: repo.id,
        provider: result.provider,
        model: result.model,
        usage: result.usage,
        price: result.price,
      })
      .catch(() => {});
    messages.push({ role: 'assistant', content: reply });

    if (reply === 'DONE') {
      const changed = changedPaths();
      if (changed.length === 0) {
        throw new Error('Codegen finished without writing any files - nothing to build, test, or push.');
      }
      return changed;
    }

    // --- FETCH_FILE: whole file, from the container ---
    const fetchMatch = reply.match(/^FETCH_FILE:\s*(.+)$/);
    if (fetchMatch) {
      const path = fetchMatch[1].trim();
      if (isUnsafePath(path)) {
        messages.push({ role: 'user', content: unsafePathReply(path) });
        continue;
      }
      const { record } = await readWholeFile(containerId, repoRoot, path);
      reads.set(path, record);
      messages.push({ role: 'user', content: repoContext.formatFileForModel(path, record) });
      continue;
    }

    // --- FETCH_RANGE: a span, from the container ---
    const rangeMatch = reply.match(/^FETCH_RANGE:\s*(.+)$/);
    if (rangeMatch) {
      const spec = repoContext.parseRangeSpec(rangeMatch[1]);
      if (!spec) {
        messages.push({
          role: 'user',
          content: 'Malformed FETCH_RANGE. The line must be exactly `FETCH_RANGE: <path>:<start>-<end>`, e.g. `FETCH_RANGE: app/lib/foo.js:1200-1400`.',
        });
        continue;
      }
      if (isUnsafePath(spec.path)) {
        messages.push({ role: 'user', content: unsafePathReply(spec.path) });
        continue;
      }
      const { record, content } = await readWholeFile(containerId, repoRoot, spec.path);
      if (content === null) {
        // Not a readable file at all - the whole-file formatter already says
        // why (missing, binary, too large, unreadable) better than a
        // range-specific message could. The read is recorded too, so the write
        // guard learns from it exactly as it would from a FETCH_FILE.
        reads.set(spec.path, record);
        messages.push({ role: 'user', content: repoContext.formatFileForModel(spec.path, record) });
        continue;
      }
      // Deliberately NOT recorded in `reads`: seeing 200 lines of a file is
      // not seeing the file, and letting a range count as a read would hand
      // Phase 19's guard exactly the false positive it exists to prevent.
      const range = repoContext.extractRange(content, spec.start, spec.end);
      messages.push({ role: 'user', content: repoContext.formatRangeForModel(spec.path, range) });
      continue;
    }

    // --- FETCH_OUTLINE: structure, from the index ---
    const outlineMatch = reply.match(/^FETCH_OUTLINE:\s*(.+)$/);
    if (outlineMatch) {
      const path = outlineMatch[1].trim();
      const outline = structuralIndex.renderOutline(index, path);
      messages.push({
        role: 'user',
        content:
          outline ||
          [
            `No outline is available for ${path}.`,
            index.available
              ? 'The index covers this commit but has no entry for that path - it may not exist, may be a generated or non-text file, or may have been created during this session.'
              : 'The structural index could not be built for this repo, so no file has an outline.',
            `Read it directly instead: \`FETCH_RANGE: ${path}:1-200\`, or \`FETCH_FILE: ${path}\` if it is small.`,
          ].join('\n'),
      });
      continue;
    }

    // --- REPLACE_LINES: anchored, verified, ranged write ---
    const directive = rangedWrite.parseDirective(reply);
    if (directive) {
      messages.push({
        role: 'user',
        content: await applyRangedWrite({ containerId, repoRoot, directive, written, reads, edited }),
      });
      continue;
    }

    // --- WRITE_FILE: whole-file replace, under Phase 19's guard ---
    const writeMatch = leftTrimmed.match(/^WRITE_FILE:\s*(\S+)\r?\n([\s\S]*)$/);
    if (writeMatch) {
      const path = writeMatch[1].trim();
      // Normalized to exactly one trailing newline rather than kept verbatim.
      // The model's own trailing whitespace is noise either way - a run of
      // blank lines at EOF is not a deliberate choice - and a single
      // terminating newline is what git, every linter, and the ranged-write
      // path all assume. An empty file stays genuinely empty.
      const body = writeMatch[2].replace(/[ \t\r\n]+$/, '');
      const content = body === '' ? '' : `${body}\n`;
      if (isUnsafePath(path)) {
        messages.push({ role: 'user', content: unsafePathReply(path) });
        continue;
      }
      // Same shape as the unsafe-path refusal above: fed back as a turn the
      // model can act on, not a pipeline failure, so it can route around the
      // file or finish without it (see ROADMAP.md Phase 19).
      const refusal = refuseWriteReason({ path, written, reads, tree });
      if (refusal) {
        messages.push({ role: 'user', content: refusal });
        continue;
      }
      await dockerRunner.writeFile(containerId, `${repoRoot}/${path}`, content);
      written.set(path, content);
      // A whole-file write is also a complete read of what the file now says,
      // so the guard needs no re-fetch before the next one.
      reads.set(path, repoContext.recordFromText(content));
      messages.push({ role: 'user', content: `Wrote ${path} (${rangedWrite.splitLines(content).lines.length} lines).` });
      continue;
    }

    messages.push({
      role: 'user',
      content: [
        'Unrecognized response. Reply with exactly one of: FETCH_FILE: <path>, FETCH_RANGE:',
        '<path>:<start>-<end>, FETCH_OUTLINE: <path>, REPLACE_LINES: <path>:<start>-<end> followed',
        'by its EXPECTED/REPLACEMENT/END sections, WRITE_FILE: <path> followed by contents, or DONE.',
      ].join('\n'),
    });
  }

  throw new Error(`Codegen did not finish within ${MAX_TURNS} turns.`);
}

function unsafePathReply(path) {
  return `Refusing "${path}" - the path must be relative to the repo root, with no leading "/" and no ".." segment.`;
}

// applyRangedWrite(...) -> the user-turn text to feed back, applied or
// refused. Read-modify-write on the host: the container hands over the whole
// file, the splice happens here, and the result goes back through the same
// writeFile the whole-file path uses. That is the right place for it even
// though it reads the whole file to change 20 lines, because the cost this
// phase exists to remove is *model output tokens*, not bytes over a local
// pipe - and host-side splicing means the verification and the write see the
// identical copy of the file, with no in-container editing tool to get the
// offsets wrong.
async function applyRangedWrite({ containerId, repoRoot, directive, written, reads, edited }) {
  if (directive.error) return directive.error;

  const { path } = directive;
  if (isUnsafePath(path)) return unsafePathReply(path);

  const { record, content } = await readWholeFile(containerId, repoRoot, path);
  if (content === null) {
    reads.set(path, record);
    return [
      `Cannot apply REPLACE_LINES to ${path} - it could not be read.`,
      repoContext.formatFileForModel(path, record),
    ].join('\n');
  }

  const applied = rangedWrite.applyDirective(content, directive);
  if (!applied.ok) {
    // The refusal quotes what is actually there, which is what makes an anchor
    // mismatch self-correcting instead of a loop: the model's next attempt has
    // the real text in front of it rather than having to guess again.
    const lines = [
      `Refusing REPLACE_LINES on ${path} - ${applied.reason}. Nothing was written.`,
      `The file currently has ${applied.totalLines} lines.`,
    ];
    if (applied.actualLines) {
      lines.push(
        `Lines ${directive.start}-${directive.end} actually contain:`,
        '```',
        applied.actualLines.map((line, i) => `${directive.start + i}\t${line}`).join('\n'),
        '```',
        'Re-read the region you mean to change and try again with the real text in EXPECTED.',
        'Note the line-number prefixes above are display only - do not put them in EXPECTED.'
      );
    } else {
      lines.push(`Read it first with \`FETCH_RANGE: ${path}:1-${Math.min(applied.totalLines, repoContext.MAX_RANGE_LINES)}\`.`);
    }
    return lines.join('\n');
  }

  await dockerRunner.writeFile(containerId, `${repoRoot}/${path}`, applied.content);
  edited.add(path);
  // A ranged edit invalidates whatever the model had been shown of this file -
  // every line after the edit has moved. Dropping the read record forces a
  // re-read before Phase 19's guard will allow a whole-file write, and the
  // reply states the new length so the model can re-aim without one.
  if (written.has(path)) written.set(path, applied.content);
  else reads.delete(path);

  const delta = applied.lineDelta === 0 ? 'no change in length' : `${applied.lineDelta > 0 ? '+' : ''}${applied.lineDelta} lines`;
  return [
    `Applied: ${path} lines ${directive.start}-${directive.end} replaced (${delta}).`,
    `The file is now ${applied.totalLines} lines. Every line after ${directive.start} has shifted - if you`,
    'are making further edits to this file, re-read the region first or work bottom-up.',
  ].join('\n');
}

module.exports = { runCodegen, MAX_CONTAINER_FILE_BYTES };
