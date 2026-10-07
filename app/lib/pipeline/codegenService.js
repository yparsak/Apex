// Codegen step of the sandboxed pipeline (see notes.md / ROADMAP.md Phase 7):
// turns a session's confirmed requirements into file writes inside the
// already-cloned sandbox container. Reads are served from GitHub (the branch
// tip mirrors the container's just-cloned state) layered under an in-memory
// map of this session's own not-yet-pushed writes, so a FETCH_FILE for a
// previously-written path sees this session's own edit, not the stale GitHub
// copy. Mirrors clarificationService.js's FETCH_FILE loop shape, plus WRITE_FILE.
const modelAdapter = require('../model/modelAdapter');
const usageService = require('../model/usageService');
const dockerRunner = require('../docker/dockerRunner');
const repoClarificationInstructions = require('../repoClarificationInstructions');
const repoContext = require('../repoContext');

const MAX_TURNS = 40;
const MAX_CUT_OFF_REPLIES = 2;

const SYSTEM_PROMPT = [
  "You are Apex's code-generation agent. An engineer's requirements below have",
  'already been clarified and confirmed; implement them now, directly in this',
  "repo's working tree, inside an isolated sandbox.",
  '',
  "You are given the repo's file tree, with each file's size and approximate length. You",
  "do not have any file's contents unless you request them, and your own edits are not",
  'visible to you until you re-request them. Use the sizes to choose where to work: a file',
  'marked as too large to read in full cannot be rewritten through this interface at all.',
  '',
  'Respond using exactly ONE of these on every turn, and nothing else:',
  '',
  '1. Request a file: write a single line, exactly `FETCH_FILE: <path>`.',
  '2. Write a file: write a single line `WRITE_FILE: <path>`, then a newline, then the',
  "   COMPLETE new contents of that file (this replaces the file's entire contents). <path>",
  '   must be relative to the repo root, with no leading `/` and no `..` segment.',
  '3. Finish: once every requirement below is fully implemented, write `DONE` and nothing else.',
  '',
  'A write replaces the whole file, so it is only accepted for a file you have fully',
  'seen: one you fetched and were shown in its entirety, one you wrote earlier this',
  'session, or a new file that does not exist yet. Fetch a file before rewriting it. A',
  'fetch that returns only part of a file says so explicitly - a file that large cannot',
  'be rewritten through this interface, and attempting it will be refused.',
  '',
  'Make the smallest set of changes that fully satisfies the requirements. Do not ask',
  'questions - if something is ambiguous, make the most reasonable implementation choice.',
].join('\n');

function buildSystemMessage(map, instructions, requirementsText) {
  const treeBlock = repoContext.renderTree(map);
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
// nothing unseen can be destroyed:
//   - the model wrote this path earlier this session, so it authored all of it
//   - it fetched the path and was shown the entire file
//   - it fetched the path and the file genuinely does not exist, so this creates it
//   - it never fetched the path, but the path is absent from a *complete* file
//     tree, which is equally proof the file does not exist yet. Since Phase 20
//     `tree.paths` is the repo's whole blob list rather than the 500 paths the
//     prompt happened to show, so this ground is sound even for a file the
//     model was never shown - and it covers far more new files than it used to.
// Everything else - a partial read, a >1 MB file, a failed read, or no read at
// all against a tree we know is clipped - is refused. Until Phase 21 provides
// a ranged write, that means codegen cannot edit a file over the read cap,
// which is the honest behavior: failing the step beats pushing a silent
// deletion of code the model never saw.
function refuseWriteReason({ path, written, reads, tree }) {
  if (written.has(path)) return null;

  const record = reads.get(path);
  if (repoContext.fullyRead(record)) return null;
  if (record && record.status === 'missing') return null;

  if (!record) {
    if (tree.complete && !tree.paths.includes(path)) return null;
    return [
      `Refusing to write "${path}" - a write replaces the file's entire contents, and you have`,
      'not fetched this file, so Apex cannot confirm whether it already exists or what it',
      `contains. Fetch it first with \`FETCH_FILE: ${path}\`, then write it.`,
    ].join('\n');
  }

  if (record.status === 'ok' && record.truncated) {
    return [
      `Refusing to write "${path}" - you were shown only the first ${record.shownChars} characters`,
      `(lines 1-${record.shownLines}) of a ${record.totalLines}-line file, so writing its complete`,
      `contents would delete the ${record.totalLines - record.shownLines} lines you never saw.`,
      'Apex has no way to apply a partial edit to a file this large yet. Leave this file',
      'alone and implement the requirements in files you can read in full, or write DONE if',
      'that is not possible.',
    ].join('\n');
  }

  if (record.status === 'too_large') {
    return [
      `Refusing to write "${path}" - the file exists but is too large to read through this`,
      'interface, so none of its contents are known and a whole-file write would delete all',
      'of it. Leave this file alone.',
    ].join('\n');
  }

  return [
    `Refusing to write "${path}" - the attempt to read it failed (${record.reason}), so Apex`,
    'cannot tell whether the file exists or what it contains, and a write would replace',
    'contents it never saw. Leave this file alone.',
  ].join('\n');
}

// runCodegen({...}) -> string[] of repo-relative paths written. Throws (never
// returns a partial result) if the model doesn't emit DONE within MAX_TURNS,
// or emits DONE without writing anything - the caller treats either as a
// codegen-stage pipeline failure, same as any other step failure.
async function runCodegen({ containerId, org, repo, branch, repoRoot, requirementsText, sessionId }) {
  const [tree, instructions] = await Promise.all([
    repoContext.fetchTree(org, repo, branch.branch_name),
    repoClarificationInstructions.getInstructions(repo.id),
  ]);

  const messages = [{ role: 'system', content: buildSystemMessage(tree, instructions, requirementsText) }];
  const written = new Map(); // repo-relative path -> content, this session's own edits
  const reads = new Map(); // repo-relative path -> read record, what the model has actually seen

  let cutOffReplies = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let result;
    try {
      result = await modelAdapter.generate(messages);
    } catch (err) {
      // A reply the provider cut short at max_tokens is a failed turn, not a
      // result (see ROADMAP.md Phase 19): its body ends mid-token, and a
      // WRITE_FILE carried by it would be written verbatim over a real file.
      // The truncated text is discarded rather than appended, so nothing
      // half-finished enters the transcript, and the model gets one chance to
      // produce something that fits. MAX_CUT_OFF_REPLIES bounds it, because
      // retrying a file that is simply too big to emit can't converge.
      if (err.finishReason !== 'length' || ++cutOffReplies > MAX_CUT_OFF_REPLIES) throw err;
      messages.push({
        role: 'user',
        content: [
          'Your previous reply was cut off by the output-length limit before it finished, so it',
          'was discarded entirely - nothing was written. A file you cannot emit in one reply',
          'cannot be written through this interface at all. Pick a smaller change: write a',
          'shorter file, split the work across separate WRITE_FILE turns on different files, or',
          'write DONE if the remaining work does not fit.',
        ].join('\n'),
      });
      continue;
    }
    const reply = result.text.trim();
    usageService
      .recordUsage({
        callSite: 'codegen',
        sessionId,
        repoId: repo.id,
        provider: result.provider,
        model: result.model,
        usage: result.usage,
      })
      .catch(() => {});
    messages.push({ role: 'assistant', content: reply });

    if (reply === 'DONE') {
      if (written.size === 0) {
        throw new Error('Codegen finished without writing any files - nothing to build, test, or push.');
      }
      return Array.from(written.keys());
    }

    const fetchMatch = reply.match(/^FETCH_FILE:\s*(.+)$/);
    if (fetchMatch) {
      const path = fetchMatch[1].trim();
      // This session's own not-yet-pushed write is served from memory and is
      // by definition complete - the model authored every character of it - so
      // it counts as a full read for the write guard below.
      const record = written.has(path)
        ? { status: 'ok', content: written.get(path), truncated: false }
        : await repoContext.readFileForModel(org.name, repo.name, path, branch.branch_name);
      reads.set(path, record);
      messages.push({
        role: 'user',
        content: written.has(path)
          ? `Contents of ${path} (complete file, as you wrote it earlier this session):\n\`\`\`\n${record.content}\n\`\`\``
          : repoContext.formatFileForModel(path, record),
      });
      continue;
    }

    const writeMatch = reply.match(/^WRITE_FILE:\s*(\S+)\r?\n([\s\S]*)$/);
    if (writeMatch) {
      const path = writeMatch[1].trim();
      const content = writeMatch[2];
      if (isUnsafePath(path)) {
        messages.push({
          role: 'user',
          content: `Refusing to write "${path}" - path must be relative to the repo root, with no leading "/" and no ".." segment.`,
        });
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
      messages.push({ role: 'user', content: `Wrote ${path}.` });
      continue;
    }

    messages.push({
      role: 'user',
      content:
        'Unrecognized response. Reply with exactly one of FETCH_FILE: <path>, WRITE_FILE: <path> followed by contents, or DONE.',
    });
  }

  throw new Error(`Codegen did not finish within ${MAX_TURNS} turns.`);
}

module.exports = { runCodegen };
