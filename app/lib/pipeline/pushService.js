// Push step of the sandboxed pipeline (see notes.md / ROADMAP.md Phase 7):
// runs entirely on the host, after build/test succeed inside the sealed
// sandbox. Copies the container's already-committed working tree out via
// `docker cp`, then pushes with plain git - the only step in the whole
// pipeline that uses the write-capable installation token, which never
// enters the sandbox.
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const dockerRunner = require('../docker/dockerRunner');
const { getInstallationToken } = require('../github/githubAppAuth');

const MAX_PUSH_ATTEMPTS = 3;
const MAX_BUFFER = 10 * 1024 * 1024;

function execFileP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { ...opts, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

function redact(text, token) {
  return token ? text.split(token).join('***') : text;
}

async function git(args, cwd, token) {
  try {
    return await execFileP('git', args, { cwd });
  } catch (err) {
    throw new Error(redact(`${err.stdout || ''}${err.stderr || ''}`.trim() || err.message, token));
  }
}

function isNonFastForward(message) {
  return /non-fast-forward|fetch first|rejected/i.test(message);
}

// pushBranch({ containerId, workspacePath, org, repo, branch }) -> commitSha.
async function pushBranch({ containerId, workspacePath, org, repo, branch }) {
  const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apex-push-'));
  try {
    await dockerRunner.copyFromContainer(containerId, `${workspacePath}/.`, hostDir);

    const token = await getInstallationToken();
    const remote = `https://x-access-token:${token}@github.com/${org.name}/${repo.name}.git`;

    for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
      try {
        await git(['push', remote, `HEAD:refs/heads/${branch.branch_name}`], hostDir, token);
        return (await git(['rev-parse', 'HEAD'], hostDir, token)).trim();
      } catch (err) {
        if (!isNonFastForward(err.message) || attempt === MAX_PUSH_ATTEMPTS) throw err;

        // Fetch-and-retry against current remote state, never force-push
        // (see ROADMAP.md Phase 7) - engineers may push directly to the same
        // DEV branch. A merge conflict here is a legitimate, loud failure,
        // not something this pipeline resolves on its own.
        await git(['fetch', remote, branch.branch_name], hostDir, token);
        await git(['merge', '--no-edit', 'FETCH_HEAD'], hostDir, token);
      }
    }
    throw new Error('Push did not succeed after retrying against current remote state.');
  } finally {
    await fs.rm(hostDir, { recursive: true, force: true });
  }
}

module.exports = { pushBranch };
