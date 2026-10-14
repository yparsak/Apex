// On-demand document runs against a branch (see ROADMAP.md Phase 25).
//
// Documents are otherwise a post-merge artifact: the nightly worker reads trunk,
// so the first time an admin's "Coding Practices" prompt ever sees new code is
// the night after it landed on main. This module runs the same admin-authored
// definition against a branch instead, before the merge, and hands the text
// straight back to the request that asked for it.
//
// What is deliberately absent: a queue, a worker, a results table, a TTL purge,
// and an orphan-row story for the browser that never comes back. A single
// user-initiated run over one branch is a request with an answer, not a batch on
// a timer, and modelling it as a job would mean inventing a table purely to
// carry a value across a process boundary that does not need to exist. Nothing
// here writes repo_documents, repo_doc_sync or doc_jobs - the nightly scan's
// view of staleness is untouched, which is the phase's acceptance test.
//
// What this module IS, then, is the gates. Every refusal below is a sentence a
// user can act on rather than a 500 or a silently-dropped click.
const db = require('../db');
const appLock = require('../appLock');
const modelCatalog = require('../model/modelCatalog');
const docDefinitions = require('./docDefinitions');
const docService = require('./docService');

// One in-flight run per user, process-local. This is a guard against a
// double-click and an impatient reload - a 30-60 second request with no progress
// indicator invites both - and explicitly NOT a quota. A per-user daily cap is
// deliberately not built here: /admin/usage now separates this spend by call
// site, so that decision can be made against real numbers instead of a guess.
//
// In memory rather than in a row, for the same reason the report is: the set is
// only meaningful for the lifetime of a request, and a crashed process would
// otherwise leave a user locked out by a lock row nothing will ever clear. The
// honest cost is that it does not hold across replicas, which is the right
// trade for a double-click guard.
const inFlightUserIds = new Set();

// A refusal the caller should render on the branch page, as opposed to a bug.
// Same posture as every gate in this phase: refused with a reason.
function refusal(message) {
  const err = new Error(message);
  err.refused = true;
  return err;
}

// isEnabledForRepo(repoId) - read fresh from the row, never from the repo object
// the page was rendered with. The view hiding the panel is the UX; this is the
// control. A gate that lives only in a template is bypassed by a stale tab, a
// bookmarked URL, or a double-submit after the admin flips it - and this gate's
// whole purpose is to bound spend on a specific repo.
async function isEnabledForRepo(repoId) {
  const [[row]] = await db.query('SELECT on_demand_docs_enabled FROM repos WHERE id = ?', [repoId]);
  return !!row && !!row.on_demand_docs_enabled;
}

// listRunnableDocuments(repo) - what the branch page's picker offers, or an
// empty list when the repo has the feature off. Empty means the panel is absent
// entirely rather than disabled-and-greyed: a control a user can see but never
// use invites a support ticket the admin has already answered by turning it off.
async function listRunnableDocuments(repo) {
  if (!repo.on_demand_docs_enabled) return [];
  // Phase 27: a disabled repo generates nothing, on demand or overnight, so the
  // panel is absent for the same reason as above. read_only is deliberately NOT
  // here - keeping documents current is exactly what separates the two rungs,
  // and the branch page of a read_only repo still offers the run. The refusal
  // itself is the route's need: 'docs' gate, not this.
  if (repo.access_state === 'disabled') return [];
  return docDefinitions.listActive();
}

// runForBranch({...}) -> { content, definition, model, usedFallback }.
//
// Throws a refusal for every gate. They are checked cheapest-first and, more to
// the point, in an order where a refused run has cost nothing: the repo flag and
// the definition are two indexed reads, and neither a model nor GitHub is
// touched until both have passed.
async function runForBranch({ org, repo, branch, docKey, user }) {
  if (!(await isEnabledForRepo(repo.id))) {
    throw refusal('On-demand document runs are turned off for this repo by an administrator.');
  }

  // Re-read by key rather than trusting the picker. Populating a <select> from
  // listActive() is not a check - it is a snapshot that goes stale the moment an
  // admin clicks "Turn off" while someone has this page open, which for a
  // document pulled BECAUSE its prompt was producing bad output is exactly the
  // moment the check has to hold. The nightly side already honours is_active
  // twice over (resolvePlans never enqueues an inactive definition, and the
  // drain re-reads listActive and marks an already-queued job 'skipped'); this
  // is the same flag enforced on the second path, not a new one.
  const definition = docKey ? await docDefinitions.getByKey(docKey) : null;
  if (!definition || definition.archived_at) throw refusal('That document no longer exists.');
  if (!definition.is_active) {
    throw refusal(`"${definition.title}" has been turned off by an administrator and cannot be run.`);
  }

  // The same whole-system gate every other model call sits behind (see
  // ROADMAP.md Phase 22). The web tier's appLockGate already blocks non-admins
  // from this route, but admins pass straight through it by design, and a
  // maintenance window freezes the whole system rather than just its UI.
  const lock = await appLock.getLockState();
  if (lock.locked) throw refusal(lock.message);

  // Claimed with no await between the check and the add, deliberately. Two
  // requests from one double-click are genuinely concurrent, which is the entire
  // case this guard exists for - a `has` here and an `add` after the model
  // lookup below would leave exactly the window that lets both through. Node's
  // single-threaded turn is what makes the pair atomic; nothing may be
  // introduced between these two lines.
  if (inFlightUserIds.has(user.id)) {
    throw refusal('You already have a document run in progress. Wait for it to finish before starting another.');
  }
  inFlightUserIds.add(user.id);

  try {
    // Resolved at run time, not stamped. docScanService stamps doc_jobs.model at
    // enqueue because its scan and drain are separate runs that can straddle a
    // catalog change; there is no such gap here, so the current answer is the
    // right one - fallback warning included, since the user should be told their
    // report was not written by the model the admin chose.
    //
    // Inside the claim, so the refusal below still releases it via the finally.
    const { model, usedFallback } = await modelCatalog.resolveForDocDefinition(definition);
    if (!model) throw refusal('No model is enabled, so no document can be generated right now.');

    const content = await docService.generate({
      org,
      repo,
      definition,
      model: model.model_id,
      // Separate from the nightly 'doc:' prefix on purpose: proactive,
      // user-triggered spend is a different line item from the nightly batch,
      // and keeping them apart on /admin/usage is what lets the question of
      // whether to cap on-demand runs be answered with numbers.
      callSite: `doc_run:${definition.doc_key}`,
      ref: branch.branch_name,
      // The reason a branch run is more than a ref swap. On a feature branch the
      // three key files docContext reads are almost always byte-identical to
      // trunk's, so without this the report would repeat what the nightly one
      // already said and catch nothing.
      compareBase: repo.default_branch_name,
    });
    return { content, definition, model, usedFallback };
  } finally {
    // finally, not after the await: a failed generation that left the user's id
    // in the set would lock them out of retrying for the lifetime of the
    // process, turning one transient provider error into a dead feature.
    inFlightUserIds.delete(user.id);
  }
}

module.exports = { listRunnableDocuments, runForBranch };
