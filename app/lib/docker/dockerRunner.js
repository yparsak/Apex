// Thin wrapper over the docker CLI for Phase 7's ephemeral sandbox containers
// (see notes.md / ROADMAP.md Phase 7). Shells out via child_process rather
// than a Docker SDK client, consistent with this project's "plain Docker
// containers" stack decision.
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

const RUNTIME = process.env.SANDBOX_RUNTIME || 'docker';
const MAX_OUTPUT_CHARS = 5 * 1024 * 1024;

// Decoded through a StringDecoder rather than `chunk.toString('utf8')`.
// Per-chunk decoding splits any multibyte character that happens to straddle a
// chunk boundary into two replacement characters, and a stream boundary falls
// wherever the pipe decides - so the corruption is real but intermittent,
// which is the worst way for it to be. It was survivable while this output was
// only ever build logs a human reads; since Phase 21 it is also file contents
// that get spliced and written back into the working tree, so a mangled
// character would be committed to a real branch. StringDecoder holds a partial
// sequence back until the next chunk completes it.
function run(args, { input, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(RUNTIME, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;

    if (timeoutMs) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`${RUNTIME} ${args[0]} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    child.stdout.on('data', (chunk) => {
      const text = outDecoder.write(chunk);
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += text;
    });
    child.stderr.on('data', (chunk) => {
      const text = errDecoder.write(chunk);
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += text;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // end() flushes any trailing incomplete sequence - as replacement
      // characters, which is correct: at end of stream it genuinely is
      // malformed input rather than a chunk boundary, and readFile's binary
      // check should see it.
      stdout += outDecoder.end();
      stderr += errDecoder.end();
      resolve({ code, stdout, stderr });
    });

    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}

// createContainer(image, network) -> containerId. Started with `sleep
// infinity` as its entrypoint override so it stays alive for the exec-driven
// steps that follow, rather than running the image's own default command.
async function createContainer(image, network) {
  const result = await run(['run', '-d', '--network', network, '--entrypoint', 'sleep', image, 'infinity']);
  if (result.code !== 0) {
    throw new Error(`Failed to create sandbox container from image "${image}": ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

// disconnectNetwork(containerId, network) - seals the container before
// build/test (see ROADMAP.md Phase 7: network policy is a per-step toggle,
// open only for clone/codegen).
async function disconnectNetwork(containerId, network) {
  const result = await run(['network', 'disconnect', network, containerId]);
  if (result.code !== 0) {
    throw new Error(`Failed to seal sandbox network for container ${containerId}: ${result.stderr.trim()}`);
  }
}

// exec(containerId, argv, opts) -> { code, stdout, stderr }. Never throws on
// a non-zero exit - callers decide whether that's a step failure.
function exec(containerId, argv, { input, timeoutMs } = {}) {
  const args = ['exec', ...(input != null ? ['-i'] : []), containerId, ...argv];
  return run(args, { input, timeoutMs });
}

// writeFile(containerId, path, content) - creates parent directories as
// needed. Content is streamed over stdin rather than embedded in an argv
// string, so it isn't subject to shell-escaping or ARG_MAX limits.
async function writeFile(containerId, path, content) {
  const result = await exec(containerId, ['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', '_', path], {
    input: content,
  });
  if (result.code !== 0) {
    throw new Error(`Failed to write ${path} inside sandbox container: ${result.stderr.trim()}`);
  }
}

// readFile(containerId, path, { maxBytes }) -> { status, content, bytes }.
// The read half of Phase 21: until this phase the container was write-only to
// codegen (every read came from GitHub), which is exactly why line numbers
// could not be trusted - the model's view and the tree it was editing were two
// different artifacts. Ranged reads and anchored writes both address lines by
// number, so they have to read the same bytes the write lands in.
//
// Never throws on a per-file problem; the statuses below are all outcomes the
// model is shown as a turn:
//   { status: 'ok', content, bytes }      - whole file, under the cap
//   { status: 'missing' }
//   { status: 'not_file' }                - a directory, symlink to nowhere, etc.
//   { status: 'too_large', bytes }        - over maxBytes; content not returned
//   { status: 'binary', bytes }           - not usable as text; see below
//   { status: 'error', reason }
//
// "Binary" is two checks, and the second is the one that matters. A NUL byte
// is the obvious signal. The subtler one is U+FFFD: this module decodes the
// container's stdout as UTF-8, so a file that is *not* valid UTF-8 - a
// latin-1-encoded source file with an accented character in a comment, say -
// comes back with replacement characters already substituted in. Reading it is
// harmless, but Phase 21's anchored writes read-modify-write the whole file,
// so writing it back would commit mojibake over every non-ASCII character in a
// file the model never meant to touch. Refusing the read is the only safe
// answer, and a legitimate source file containing a literal U+FFFD is rare
// enough that costing it a refusal is the right trade.
//
// The size is emitted on its own first line by the shell *before* any content,
// rather than inferred from what came back, because dockerRunner's own
// MAX_OUTPUT_CHARS clips stdout silently - inferring the size from a clipped
// read is how a ranged write ends up splicing into a file it only half has.
async function readFile(containerId, path, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const script = [
    'p=$1; n=$2',
    '[ -e "$p" ] || exit 44',
    '[ -f "$p" ] || exit 45',
    'sz=$(wc -c < "$p" | tr -dc 0-9) || exit 46',
    'echo "$sz"',
    '[ "$sz" -gt "$n" ] && exit 0',
    'cat -- "$p"',
  ].join('\n');

  let result;
  try {
    result = await exec(containerId, ['sh', '-c', script, '_', path, String(maxBytes)]);
  } catch (err) {
    return { status: 'error', reason: err.message || String(err) };
  }
  if (result.code === 44) return { status: 'missing' };
  if (result.code === 45) return { status: 'not_file' };
  if (result.code !== 0) return { status: 'error', reason: (result.stderr || `exit ${result.code}`).trim() };

  const split = result.stdout.indexOf('\n');
  const bytes = Number(split === -1 ? result.stdout : result.stdout.slice(0, split));
  if (!Number.isFinite(bytes)) return { status: 'error', reason: 'could not determine file size inside container' };
  if (bytes > maxBytes) return { status: 'too_large', bytes };

  const content = split === -1 ? '' : result.stdout.slice(split + 1);
  if (content.indexOf('\u0000') !== -1 || content.indexOf('\uFFFD') !== -1) return { status: 'binary', bytes };

  // Integrity check, and the reason it is worth a line: for valid UTF-8 the
  // re-encoded length must equal the size the shell reported, so this catches
  // a stdout clipped at MAX_OUTPUT_CHARS or any other partial read - the exact
  // failure that would otherwise have a ranged write splice into a file it
  // only half has, and then write that half back. Invalid UTF-8 is already
  // excluded above, so a mismatch here can only mean the content is short.
  const readBack = Buffer.byteLength(content, 'utf8');
  if (readBack !== bytes) {
    return { status: 'error', reason: `read back ${readBack} of ${bytes} bytes - the read was truncated` };
  }
  return { status: 'ok', content, bytes };
}

// copyFromContainer(containerId, containerPath, hostDestDir) - pulls the
// finished, committed working tree out of the sealed container for the host
// process to push (see ROADMAP.md Phase 7: the write-capable push token
// never enters the sandbox).
async function copyFromContainer(containerId, containerPath, hostDestDir) {
  const result = await run(['cp', `${containerId}:${containerPath}`, hostDestDir]);
  if (result.code !== 0) {
    throw new Error(`Failed to copy ${containerPath} out of container ${containerId}: ${result.stderr.trim()}`);
  }
}

// removeContainer is best-effort - only called after a successful pipeline
// run. A failed run's container is deliberately left running (see ROADMAP.md
// Phase 7: "Container lifecycle on failure").
async function removeContainer(containerId) {
  await run(['rm', '-f', containerId]);
}

module.exports = { createContainer, disconnectNetwork, exec, writeFile, readFile, copyFromContainer, removeContainer };
