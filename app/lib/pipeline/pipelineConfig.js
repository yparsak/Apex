// Declarative per-repo build/test config for Phase 4's sandbox step. Read
// from a fixed repo-root file (apex.pipeline.json) in the extracted working
// tree, kept as plain JSON rather than YAML since there is no YAML-parsing
// dependency anywhere in this project and adding one for a single config
// file isn't justified (see agent-prompts.md's Phase 4 section).
//
// Fails loudly on anything missing or malformed - same "no silent guessing"
// convention repos.default_branch_name and the branch-existence checks
// already follow. This module never invents a default buildCommand or
// testCommand; only "image" and "timeoutSeconds" (infra concerns, not
// business logic) may fall back to environment defaults.

const fs = require('fs/promises');
const path = require('path');

const CONFIG_FILENAME = 'apex.pipeline.json';

function makeConfigError(message) {
  const err = new Error(message);
  err.code = 'PIPELINE_CONFIG_INVALID';
  return err;
}

async function readPipelineConfig(treeDir) {
  const configPath = path.join(treeDir, CONFIG_FILENAME);

  let raw;
  try {
    raw = await fs.readFile(configPath, 'utf-8');
  } catch (err) {
    throw makeConfigError(
      `Repo is missing a ${CONFIG_FILENAME} file at its root - Phase 4 requires an explicit, declarative ` +
        'build/test config and never invents default commands'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw makeConfigError(`${CONFIG_FILENAME} is not valid JSON: ${err.message}`);
  }

  const { buildCommand, testCommand, image, timeoutSeconds } = parsed || {};

  if (typeof buildCommand !== 'string' || buildCommand.trim().length === 0) {
    throw makeConfigError(`${CONFIG_FILENAME} must include a non-empty "buildCommand" string`);
  }
  if (typeof testCommand !== 'string' || testCommand.trim().length === 0) {
    throw makeConfigError(`${CONFIG_FILENAME} must include a non-empty "testCommand" string`);
  }
  if (image !== undefined && (typeof image !== 'string' || image.trim().length === 0)) {
    throw makeConfigError(`${CONFIG_FILENAME}'s "image" field must be a non-empty string when present`);
  }
  if (timeoutSeconds !== undefined && (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0)) {
    throw makeConfigError(`${CONFIG_FILENAME}'s "timeoutSeconds" field must be a positive integer when present`);
  }

  const resolvedImage = (image && image.trim()) || process.env.SANDBOX_IMAGE;
  if (!resolvedImage) {
    throw makeConfigError(
      `No sandbox image available - set "image" in ${CONFIG_FILENAME} or SANDBOX_IMAGE in the environment`
    );
  }

  const resolvedTimeoutSeconds = timeoutSeconds || Number(process.env.SANDBOX_TIMEOUT_SECONDS) || 600;

  return {
    buildCommand: buildCommand.trim(),
    testCommand: testCommand.trim(),
    image: resolvedImage,
    timeoutSeconds: resolvedTimeoutSeconds,
  };
}

module.exports = { readPipelineConfig, CONFIG_FILENAME };
