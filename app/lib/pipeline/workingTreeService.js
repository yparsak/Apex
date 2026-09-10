// Host-side "clone" for Phase 4. This project stays GitHub-REST-API-only -
// there is no `git` CLI usage anywhere (see app/lib/github/branchService.js
// and diffService.js) and no simple-git/isomorphic-git dependency, and Phase
// 4 keeps that discipline rather than introducing one. GitHub's tarball
// endpoint stands in for `git clone`: download the branch's tree as a
// tarball using a clone-only (contents:read) token that never leaves this
// host process, and extract it into a fresh host-side temp directory that
// the sandbox container later mounts read/write (see sandboxRunner.js). The
// write-capable token is minted separately, later, only for the push step
// (app/lib/github/commitService.js) - it is never involved here.
//
// Uses the system `tar` binary via child_process rather than adding a tar
// npm dependency, same "shell a CLI instead of adding a library" choice this
// phase makes for Docker (see sandboxRunner.js).

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { mintCloneOnlyToken } = require('../github/branchService');
const logger = require('../logger');

const execFileAsync = promisify(execFile);
const GITHUB_API_BASE = 'https://api.github.com';

// Caps how many file paths are handed to the model for the file-selection
// prompt - same truncate-and-log discipline as diffService.js's MAX_FILES,
// for the same reason (a finite prompt budget).
const MAX_LISTED_FILES = 800;

async function downloadAndExtractTree({ owner, repoName, ref }) {
  const token = await mintCloneOnlyToken(repoName);

  const response = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repoName}/tarball/${encodeURIComponent(ref)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub tarball download failed (${response.status}): ${detail}`);
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apex-pipeline-'));
  const tarPath = path.join(workDir, 'source.tar.gz');
  const treeDir = path.join(workDir, 'tree');
  await fs.mkdir(treeDir, { recursive: true });

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(tarPath, buffer);

  // GitHub wraps the tarball's contents in a single top-level
  // "{owner}-{repo}-{sha}/" directory - strip it so treeDir mirrors the
  // repo root exactly, matching what a real `git clone` would look like.
  await execFileAsync('tar', ['-xzf', tarPath, '-C', treeDir, '--strip-components=1']);
  await fs.unlink(tarPath);

  logger.info('downloaded and extracted branch tree', { owner, repoName, ref, treeDir });
  return { workDir, treeDir };
}

async function listFilePaths(treeDir) {
  const results = [];

  async function walk(currentDir, relPrefix) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(currentDir, entry.name), relPath);
      } else if (entry.isFile()) {
        results.push(relPath);
      }
    }
  }

  await walk(treeDir, '');

  const truncated = results.length > MAX_LISTED_FILES;
  if (truncated) {
    logger.info('file listing truncated for prompt context', {
      treeDir,
      totalFiles: results.length,
      cappedAt: MAX_LISTED_FILES,
    });
  }

  return {
    files: truncated ? results.slice(0, MAX_LISTED_FILES) : results,
    truncated,
    totalFiles: results.length,
  };
}

async function cleanupWorkingTree(workDir) {
  try {
    await fs.rm(workDir, { recursive: true, force: true });
  } catch (err) {
    logger.warn('failed to clean up pipeline working directory', { workDir, error: err.message });
  }
}

module.exports = { downloadAndExtractTree, listFilePaths, cleanupWorkingTree };
