// Runs a repo's declarative build/test commands inside an ephemeral,
// network-isolated Docker container. This is the container's ONLY job - no
// git, no GitHub token, no model adapter call ever happens inside it (see
// agent-prompts.md's Phase 4 section). The host has already downloaded the
// tree and applied the model's generated file changes to it
// (workingTreeService.js / pipelineService.js) before this module is ever
// called.
//
// Shells out to the `docker` CLI via child_process rather than adding a
// `dockerode` dependency - this project has added zero incidental
// dependencies through Phase 3, and a CLI spawn is enough for "run a
// container, capture output, enforce a timeout."

const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const logger = require('../logger');

const execFileAsync = promisify(execFile);

// Caps how much combined stdout/stderr is persisted to pipeline_runs.log -
// a runaway build/test command could otherwise produce an unbounded amount
// of output. Truncation is logged, not silently dropped (see diffService.js
// for the same truncate-and-log discipline elsewhere in this project).
const MAX_LOG_CHARS = 200000;

function capLog(log) {
  if (log.length <= MAX_LOG_CHARS) return log;
  return `${log.slice(0, MAX_LOG_CHARS)}\n... (log truncated at ${MAX_LOG_CHARS} characters)`;
}

// containerName is given explicitly (rather than left to Docker's random
// default) so a timeout can target `docker kill <name>` precisely - killing
// the local `docker run` client process alone would not reliably stop the
// container itself.
async function runSandbox({ image, treeDir, buildCommand, testCommand, timeoutSeconds, containerName }) {
  const shellCommand = `${buildCommand} && ${testCommand}`;

  const args = ['run', '--rm', '--network', 'none', '--name', containerName];
  if (process.env.SANDBOX_MEMORY_LIMIT) {
    args.push('--memory', process.env.SANDBOX_MEMORY_LIMIT);
  }
  args.push('-v', `${treeDir}:/workspace:rw`, '-w', '/workspace', image, 'sh', '-c', shellCommand);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn('docker', args);

    const timer = setTimeout(() => {
      timedOut = true;
      execFileAsync('docker', ['kill', containerName]).catch(() => {
        // Container may have already exited on its own between the timeout
        // firing and the kill attempt landing - not a new failure.
      });
    }, timeoutSeconds * 1000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      logger.error('failed to start sandbox container', { image, containerName, error: err.message });
      resolve({
        success: false,
        exitCode: null,
        timedOut: false,
        log: `Failed to start Docker (${err.message}). Is Docker installed and running?`,
      });
    });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      const log = capLog(stdout + (stderr ? `\n--- stderr ---\n${stderr}` : ''));
      logger.info('sandbox run finished', { image, containerName, exitCode, timedOut });
      resolve({
        success: !timedOut && exitCode === 0,
        exitCode,
        timedOut,
        log,
      });
    });
  });
}

module.exports = { runSandbox };
