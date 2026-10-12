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
//
// Phase 25 adds the one thing that is NOT the same for every caller: an
// optional diff block. The nightly worker reads trunk and nothing else; an
// on-demand run against a feature branch also gets the code that is about to
// merge, because on a feature branch the three key files below are almost
// always byte-identical to trunk's - a pure ref swap would return roughly what
// the nightly report already said and catch nothing. The block is strictly
// additive: with no compareBase, every byte returned here is what Phase 24
// returned.
const repoContext = require('../repoContext');
const githubApi = require('../github/githubApi');

// A hardcoded allowlist, which is why these docs are thin for a large repo -
// they are written from packaging metadata and a readme. Phase 20's size-aware
// map makes a map-driven selection possible here, but doing it changes
// generated doc content, which is Phase 15's concern and wants its own
// before/after review (see ROADMAP.md Phase 20).
const KEY_FILES = ['README.md', 'package.json', 'apex.pipeline.json'];

// The diff caps (see ROADMAP.md Phase 25). Two of them, because a 300-file
// change and a 3-file change that rewrites a vendored bundle fail in different
// directions. Per-file clipping is NOT one of these - that is already
// readFileForModel's job and already labelled (Phase 19); these sit on top of
// it, at the file-count and whole-block level.
//
// Whatever these drop is NAMED in the block. A review that silently covered 40
// of 300 changed files while presenting itself as complete is strictly worse
// than one that says what it skipped: the engineer trusts it and merges.
const MAX_DIFF_FILES = 40;
const MAX_DIFF_CHARS = 120000;

// Changed files are read in FULL rather than passed as raw patches. Hunks are
// the wrong input for a practices review - three lines of context cannot
// support a judgment about a function - and the whole point of the block is
// that the model is looking at the code, not at a summary of where it moved.
async function buildDiffBlock(org, repo, baseRef, headRef) {
  const { files } = await githubApi.compareCommits(org.name, repo.name, baseRef, headRef);
  const header = `=== CHANGES ON THIS BRANCH (vs ${baseRef}) ===`;

  if (!files.length) {
    // Said out loud rather than omitting the block. "This branch changes
    // nothing" is a real answer to "review this branch", and a missing block
    // would leave the model to guess whether it was given a diff at all.
    return `${header}\nThis branch has no changes compared to ${baseRef}.`;
  }

  // Deletions are listed, not read: there is nothing at the head ref to read,
  // and reading them anyway would report a file the change deliberately removed
  // as mysteriously missing.
  const removed = files.filter((f) => f.status === 'removed');
  const readable = files.filter((f) => f.status !== 'removed');

  const blocks = [];
  const dropped = [];
  let budget = MAX_DIFF_CHARS;
  for (const file of readable) {
    if (blocks.length >= MAX_DIFF_FILES || budget <= 0) {
      dropped.push(file.filename);
      continue;
    }
    const record = await repoContext.readFileForModel(org.name, repo.name, file.filename, headRef);
    const text = repoContext.formatFileForModel(file.filename, record, { ref: headRef });
    // Checked after formatting rather than before: the budget is about how much
    // text actually reaches the model, and a file that would push the block
    // past it is dropped by NAME instead of half-included.
    if (text.length > budget && blocks.length) {
      dropped.push(file.filename);
      continue;
    }
    budget -= text.length;
    blocks.push(text);
  }

  const summary = [
    `${files.length} file${files.length === 1 ? '' : 's'} changed on this branch compared to ${baseRef}.`,
    `The full contents of the changed files are below, as they stand on this branch.`,
  ];
  if (removed.length) {
    summary.push(
      `Deleted by this branch (no contents to show): ${removed.map((f) => f.filename).join(', ')}.`
    );
  }
  if (dropped.length) {
    summary.push(
      `NOT INCLUDED - ${dropped.length} changed file${dropped.length === 1 ? '' : 's'} were left out of this` +
        ` context because the change is larger than the ${MAX_DIFF_FILES}-file /` +
        ` ${MAX_DIFF_CHARS}-character limit for a single run: ${dropped.join(', ')}.` +
        ' You have not seen these files. Say so in your report rather than describing the change as fully reviewed.'
    );
  }

  return [header, summary.join('\n'), ...blocks].join('\n\n');
}

// build(org, repo, ref, { compareBase }) - `ref` was already a parameter, so
// pointing the key-file reads at a branch instead of trunk costs nothing.
// `compareBase` is what makes a branch run worth doing: pass trunk's branch
// name and the model also sees the code that is about to merge.
async function build(org, repo, branchName, { compareBase = null } = {}) {
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

  // Built as one expression and then appended to, deliberately: the no-diff
  // return has to be byte-for-byte the Phase 24 string, down to the trailing
  // separator a repo with none of the key files leaves behind. That is what
  // makes "a trunk regeneration is bit-identical" a check rather than a
  // judgment call (see ROADMAP.md Phase 25).
  const base = `=== FILE TREE ===\n${repoContext.renderTree(tree)}\n\n${fileBlocks.join('\n\n')}`;
  if (!compareBase) return base;

  return `${base}\n\n${await buildDiffBlock(org, repo, compareBase, branchName)}`;
}

module.exports = { KEY_FILES, MAX_DIFF_FILES, MAX_DIFF_CHARS, build };
