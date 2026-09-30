// Codegen step of the sandboxed pipeline (see notes.md / ROADMAP.md Phase 7):
// turns a session's confirmed requirements into file writes inside the
// already-cloned sandbox container. Reads are served from GitHub (the branch
// tip mirrors the container's just-cloned state) layered under an in-memory
// map of this session's own not-yet-pushed writes, so a FETCH_FILE for a
// previously-written path sees this session's own edit, not the stale GitHub
// copy. Mirrors clarificationService.js's FETCH_FILE loop shape, plus WRITE_FILE.
const githubApi = require('../github/githubApi');
const modelAdapter = require('../model/modelAdapter');
const dockerRunner = require('../docker/dockerRunner');
const repoClarificationInstructions = require('../repoClarificationInstructions');

const MAX_TURNS = 40;
const MAX_TREE_PATHS = 500;
const MAX_FILE_CHARS = 8000;

const SYSTEM_PROMPT = [
  "You are Apex's code-generation agent. An engineer's requirements below have",
  'already been clarified and confirmed; implement them now, directly in this',
  "repo's working tree, inside an isolated sandbox.",
  '',
  "You are given the repo's file tree. You do not have any file's contents unless",
  'you request them, and your own edits are not visible to you until you re-request them.',
  '',
  'Respond using exactly ONE of these on every turn, and nothing else:',
  '',
  '1. Request a file: write a single line, exactly `FETCH_FILE: <path>`.',
  '2. Write a file: write a single line `WRITE_FILE: <path>`, then a newline, then the',
  "   COMPLETE new contents of that file (this replaces the file's entire contents). <path>",
  '   must be relative to the repo root, with no leading `/` and no `..` segment.',
  '3. Finish: once every requirement below is fully implemented, write `DONE` and nothing else.',
  '',
  'Make the smallest set of changes that fully satisfies the requirements. Do not ask',
  'questions - if something is ambiguous, make the most reasonable implementation choice.',
].join('\n');

async function fetchTree(org, repo, branch) {
  try {
    const paths = await githubApi.getTree(org.name, repo.name, branch.branch_name);
    return paths.slice(0, MAX_TREE_PATHS);
  } catch (err) {
    return [];
  }
}

function buildSystemMessage(tree, instructions, requirementsText) {
  const treeBlock = tree.length ? tree.join('\n') : '(tree unavailable)';
  const instructionsBlock = instructions
    ? `\n\n=== ADMIN CLARIFICATION INSTRUCTIONS (authoritative) ===\n${instructions}`
    : '';
  return `${SYSTEM_PROMPT}\n\n=== FILE TREE ===\n${treeBlock}${instructionsBlock}\n\n=== REQUIREMENTS TO IMPLEMENT ===\n${requirementsText}`;
}

function isUnsafePath(path) {
  return path.startsWith('/') || path.split('/').some((seg) => seg === '..' || seg === '');
}

// runCodegen({...}) -> string[] of repo-relative paths written. Throws (never
// returns a partial result) if the model doesn't emit DONE within MAX_TURNS,
// or emits DONE without writing anything - the caller treats either as a
// codegen-stage pipeline failure, same as any other step failure.
async function runCodegen({ containerId, org, repo, branch, repoRoot, requirementsText }) {
  const [tree, instructions] = await Promise.all([
    fetchTree(org, repo, branch),
    repoClarificationInstructions.getInstructions(repo.id),
  ]);

  const messages = [{ role: 'system', content: buildSystemMessage(tree, instructions, requirementsText) }];
  const written = new Map(); // repo-relative path -> content, this session's own edits

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const reply = (await modelAdapter.generate(messages)).trim();
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
      let content;
      if (written.has(path)) {
        content = written.get(path);
      } else {
        try {
          content = await githubApi.getFileContent(org.name, repo.name, path, branch.branch_name);
        } catch (err) {
          content = null;
        }
      }
      messages.push({
        role: 'user',
        content:
          content === null
            ? `${path} was not found.`
            : `Contents of ${path}:\n\`\`\`\n${content.slice(0, MAX_FILE_CHARS)}\n\`\`\``,
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
