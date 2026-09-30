// Thin wrapper over the docker CLI for Phase 7's ephemeral sandbox containers
// (see notes.md / ROADMAP.md Phase 7). Shells out via child_process rather
// than a Docker SDK client, consistent with this project's "plain Docker
// containers" stack decision.
const { spawn } = require('child_process');

const RUNTIME = process.env.SANDBOX_RUNTIME || 'docker';
const MAX_OUTPUT_CHARS = 5 * 1024 * 1024;

function run(args, { input, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(RUNTIME, args, { stdio: ['pipe', 'pipe', 'pipe'] });
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
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString('utf8');
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

module.exports = { createContainer, disconnectNetwork, exec, writeFile, copyFromContainer, removeContainer };
