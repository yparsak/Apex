// Phase 5: model-judgment-gated Spec/Communication Protocol doc regeneration.
// See roadmap.md's "Spec / Communication Protocol doc" row and
// agent-prompts.md's "Phase 5" section for the full contract this
// implements. Orchestrates up to three model calls against the SAME treeDir
// pipelineService.js already has on disk (post-code-change, pre-commit) -
// no extra GitHub call is needed to read an existing doc or list files,
// since the working tree already has everything:
//
//   1. Decision - does this branch's code expose an API surface at all, and
//      if so, does the existing doc (if any) still reflect it. Only a file
//      listing + the existing doc's content (if any) is given - not full
//      file contents, which would be wasteful for a call whose only job is
//      "should we bother."
//   2. File selection (only if step 1 says a regeneration is needed) - the
//      same "which existing files do you need to read in full" shape Phase
//      4's code-gen already uses, reusing its FILES_NEEDED_TAG/
//      parseFilesNeeded pair directly (see specDocPrompts.js).
//   3. Document generation (only reached from step 2) - emit the entire
//      regenerated document as plain Markdown.
//
// Every model call goes through the same runChatTurn helper Phase 3/4
// already established, so this gets the same conversations/audit_log
// discipline for free - see agent-prompts.md's "Phase 5" section.

const fs = require('fs/promises');
const path = require('path');
const logger = require('../logger');
const { runChatTurn } = require('../branches/sessionService');
const { listFilePaths } = require('./workingTreeService');
const { getSpecDocPath } = require('./deliveryPaths');
const {
  buildSpecDecisionMessages,
  buildSpecFileSelectionMessages,
  buildSpecDocumentMessages,
  SPEC_DECISION_TAG,
  SPEC_DOCUMENT_TAG,
} = require('./specDocPrompts');
const { parseSpecDecision, parseSpecDocument } = require('./specDocResponseParsing');
const { parseFilesNeeded } = require('./pipelineResponseParsing');
const { FILES_NEEDED_TAG } = require('./pipelinePrompts');

function makeSpecDocError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function readExistingSpecDoc(treeDir, specDocPath) {
  try {
    return await fs.readFile(path.join(treeDir, specDocPath), 'utf-8');
  } catch (err) {
    return null;
  }
}

async function decideSpecDocAction({ session, repo, branch, fileListing, existingDoc, diff }) {
  const messages = buildSpecDecisionMessages({ repo, branch, fileListing, existingDoc, diff });
  const reply = await runChatTurn({
    session,
    repo,
    coNumber: branch.coNumber,
    actingUserId: session.userId,
    messages,
    persistUserMessage: null,
    replyRole: 'system',
  });

  const decision = parseSpecDecision(reply);
  if (decision === null) {
    // Fail closed, not fail-permissive in either direction - see
    // specDocResponseParsing.js's parseSpecDecision comment and
    // agent-prompts.md's "Phase 5" section: an ambiguous decision reply must
    // not silently skip a needed regeneration, and must not silently
    // regenerate one that wasn't needed either.
    throw makeSpecDocError(
      `Model reply for spec-doc decision (expected a fenced "${SPEC_DECISION_TAG}" block) could not be parsed`,
      'SPEC_DECISION_PARSE_FAILED'
    );
  }
  return decision;
}

async function selectFilesForSpecDoc({ session, repo, branch, treeDir, fileListing, diff }) {
  const messages = buildSpecFileSelectionMessages({ repo, branch, fileListing, diff });
  const reply = await runChatTurn({
    session,
    repo,
    coNumber: branch.coNumber,
    actingUserId: session.userId,
    messages,
    persistUserMessage: null,
    replyRole: 'system',
  });

  const selected = parseFilesNeeded(reply);
  if (selected === null) {
    throw makeSpecDocError(
      `Model reply for spec-doc file selection (expected a fenced "${FILES_NEEDED_TAG}" block) could not be parsed`,
      'SPEC_DECISION_PARSE_FAILED'
    );
  }

  for (const relPath of selected) {
    try {
      await fs.access(path.join(treeDir, relPath));
    } catch (err) {
      // Same fail-closed treatment as Phase 4's code-gen file selection - a
      // hallucinated path fails the run rather than being dropped or guessed.
      throw makeSpecDocError(
        `Model requested a file for the spec doc that does not exist in the working tree: ${relPath}`,
        'SPEC_DECISION_PARSE_FAILED'
      );
    }
  }
  return selected;
}

async function generateSpecDocument({ session, repo, branch, fileListing, fileContents, diff }) {
  const messages = buildSpecDocumentMessages({ repo, branch, fileListing, fileContents, diff });
  const reply = await runChatTurn({
    session,
    repo,
    coNumber: branch.coNumber,
    actingUserId: session.userId,
    messages,
    persistUserMessage: null,
    replyRole: 'system',
  });

  const document = parseSpecDocument(reply);
  if (document === null) {
    throw makeSpecDocError(
      `Model reply for spec document (expected a fenced "${SPEC_DOCUMENT_TAG}" block) could not be parsed`,
      'SPEC_DOCUMENT_PARSE_FAILED'
    );
  }
  return document;
}

// Returns { path: null, change: null } when no regeneration is needed (the
// common case - most sessions don't touch the API surface), or
// { path, change } ready to fold into the same commitAndPushChanges call as
// the code changes and the requirements-log update, when one is.
async function maybeBuildSpecDocChange({ session, repo, branch, treeDir, diff }) {
  const specDocPath = getSpecDocPath(branch.coNumber);
  const fileListing = await listFilePaths(treeDir);
  const existingDoc = await readExistingSpecDoc(treeDir, specDocPath);

  const decision = await decideSpecDocAction({ session, repo, branch, fileListing, existingDoc, diff });
  if (!decision.hasApiSurface || decision.docIsCurrent) {
    logger.info('spec doc regeneration skipped', {
      sessionId: session.id,
      branchId: branch.id,
      hasApiSurface: decision.hasApiSurface,
      docIsCurrent: decision.docIsCurrent,
    });
    return { path: null, change: null };
  }

  const selectedFiles = await selectFilesForSpecDoc({ session, repo, branch, treeDir, fileListing, diff });
  const fileContents = {};
  for (const relPath of selectedFiles) {
    fileContents[relPath] = await fs.readFile(path.join(treeDir, relPath), 'utf-8');
  }

  const content = await generateSpecDocument({ session, repo, branch, fileListing, fileContents, diff });

  logger.info('spec doc regenerated', { sessionId: session.id, branchId: branch.id, specDocPath });

  return {
    path: specDocPath,
    change: { path: specDocPath, action: existingDoc === null ? 'create' : 'modify', content },
  };
}

module.exports = { maybeBuildSpecDocChange };
