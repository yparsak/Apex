// The user message every generated document is written from (see ROADMAP.md
// Phase 24). One builder for all of them, not one per type: this was
// docTypes.js's per-entry `buildContext` until definitions became rows, and a
// function is the one thing a row cannot hold.
//
// The scope boundary this module IS: an admin controls what the model is told
// (doc_definitions.model_prompt), not what it reads. Two definitions differing
// only in prompt see exactly the same three files, so a "Security Analysis"
// document will be as thin as Phase 20 already notes the spec doc is - and this
// is the limit a verbatim prompt field runs into first. Per-definition file
// selection is deferred, not forgotten: it needs path validation, glob
// semantics, and an answer for a definition naming files no repo has, none of
// which is needed to prove admins can author documents.
//
// The content here is byte-for-byte what the Phase 23 spec doc got, deliberately
// - that is what makes "reproduce the spec doc from the README and compare" a
// sharp test rather than a judgment call about whether the output looks similar.
const repoContext = require('../repoContext');

// A hardcoded allowlist, which is why these docs are thin for a large repo -
// they are written from packaging metadata and a readme. Phase 20's size-aware
// map makes a map-driven selection possible here, but doing it changes
// generated doc content, which is Phase 15's concern and wants its own
// before/after review (see ROADMAP.md Phase 20).
const KEY_FILES = ['README.md', 'package.json', 'apex.pipeline.json'];

async function build(org, repo, branchName) {
  const tree = await repoContext.fetchTree(org, repo, branchName);

  // A key file clipped at the read cap is labelled as clipped, same as every
  // other reader (see ROADMAP.md Phase 19) - a doc written from the first 8000
  // characters of a long README, presented as the whole thing, describes a repo
  // that doesn't exist. A read that fails or comes back oversized is skipped
  // rather than blocking doc generation, which is this call site's existing
  // degrade-don't-block posture.
  const fileBlocks = [];
  for (const path of KEY_FILES) {
    if (!tree.paths.includes(path)) continue;
    const record = await repoContext.readFileForModel(org.name, repo.name, path, branchName);
    if (record.status !== 'ok') continue;
    fileBlocks.push(repoContext.formatFileForModel(path, record));
  }

  return `=== FILE TREE ===\n${repoContext.renderTree(tree)}\n\n${fileBlocks.join('\n\n')}`;
}

module.exports = { KEY_FILES, build };
