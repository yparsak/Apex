// Declarative per-repo pipeline config (see notes.md / ROADMAP.md Phase 7).
// The runner never invents a default build/test command or image - a missing
// or malformed apex.pipeline.json fails the pipeline loudly up front, before
// any container is created.
const githubApi = require('../github/githubApi');

const REQUIRED_STRING_FIELDS = ['image', 'buildCommand', 'testCommand'];

function validate(parsed, org, repo, branch) {
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof parsed[field] !== 'string' || !parsed[field].trim()) {
      throw new Error(
        `apex.pipeline.json in ${org.name}/${repo.name}@${branch.branch_name} is missing a non-empty "${field}" field.`
      );
    }
  }
  return { image: parsed.image.trim(), buildCommand: parsed.buildCommand, testCommand: parsed.testCommand };
}

// fetchPipelineConfig(org, repo, branch) -> { image, buildCommand, testCommand }.
async function fetchPipelineConfig(org, repo, branch) {
  let raw;
  try {
    raw = await githubApi.getFileContent(org.name, repo.name, 'apex.pipeline.json', branch.branch_name);
  } catch (err) {
    throw new Error(
      `Failed to read apex.pipeline.json from ${org.name}/${repo.name}@${branch.branch_name}: ${err.message}`
    );
  }
  if (raw === null) {
    throw new Error(
      `${org.name}/${repo.name} has no apex.pipeline.json at its repo root on ${branch.branch_name} - the pipeline runner never invents a default build/test command.`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`apex.pipeline.json in ${org.name}/${repo.name} is not valid JSON: ${err.message}`);
  }

  return validate(parsed, org, repo, branch);
}

module.exports = { fetchPipelineConfig };
