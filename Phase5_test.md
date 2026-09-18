# Phase 5 manual testing

Phase 5 turns a Phase-4 pipeline run into an actually *complete* DEV-branch
delivery: the same combined commit that pushes the model's code changes now
also appends to the branch's user requirements log
(`APEX-REQUIREMENTS-LOG.md`) and, when the model judges it's warranted,
regenerates the Spec/Communication Protocol doc
(`docs/apex-spec/{CO}.md`) — and, for the first time in this project, the
CO's `pipeline_locks` row is released on a successful run. See roadmap.md's
"Phase 5 — DEV branch delivery" bullets for the scope this implements, and
`agent-prompts.md`'s "Phase 5" section for the fenced-block tags
(`spec-decision`, `spec-document`, plus reuse of Phase 4's `files-needed`
tag), the combined-single-commit rationale, and the fail-loud choices behind
it.

Because this phase talks to a real LLM for the spec-doc judgment, exact
wording and exactly *when* the model decides a doc is warranted will vary
run to run. The tests below tell you what to set up and what shape of thing
to expect back, not an exact diff to match.

**Testing is primarily done through the browser**, per this project's
established convention (`Phase4_test.md` is the template here) — you queue a
session and watch the same session page you already used for Phase 4. curl/
SQL is used only where there's genuinely no UI path: confirming the
`pipeline_locks` row is actually gone after success, confirming a *second*
`/resolve` now works, and forcing the spec-doc-judgment-failure case.

## Prerequisites

1. Everything from `Phase1_test.md` through `Phase4_test.md` — a running
   app, a worker process, Docker running, a seeded org/repo group/repo/
   permissions, two registered users, a working GitHub App, a working model
   adapter, and your test repo's `apex.pipeline.json` in place.
2. **No new `.env` variables and no new npm dependencies.** Phase 5 reuses
   the Phase 0–4 config, the same model adapter, the same GitHub App token
   service, and the same `docker`/`tar` CLI usage as-is.
3. **Schema change: re-apply `db/schema.sql`.** Phase 5 adds one new,
   nullable column — `pipeline_runs.spec_doc_path`, via
   `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (MariaDB 10.0.2+) — safe to
   re-run against your existing dev database, no data loss:
   ```
   make db-schema
   ```
4. **The worker is the same `worker.js`** — nothing new to start. If it's
   not already running from Phase 4 testing:
   ```
   make worker
   ```
5. A repo/CO you can freely push to, same as Phase 4. For Test 2 (the happy
   path) you'll want a requirement that's easy to eyeball both in the
   requirements log and, ideally, as a real API surface change so you can
   also watch the spec doc get generated. Two good choices:
   - **To see the requirements log only** (spec doc should NOT appear):
     > Add a new top-level file called `apex-notes.txt` containing the line
     > `just a note, no api here`.
   - **To see both the requirements log AND a spec doc get generated** (pick
     something that actually reads as an API surface to the model — exact
     wording matters less than it clearly describing an endpoint):
     > Add a new Express route `GET /api/ping` that returns
     > `{"success": true, "message": "pong", "data": {}}`.
     (Adjust the framework/language detail to whatever your test repo
     actually is — the point is that it reads as a new externally-callable
     endpoint, not the literal Express syntax.)

## Test 1 — happy path with no API surface: requirements log only

1. Resolve a fresh CO and get a session queued with the `apex-notes.txt`
   requirement above (see `Phase3_test.md` Tests 1–3 to get from a fresh
   session to `queued`, or reuse the flow you already know from Phase 4
   testing).
2. Open the session page and watch it the same way you did in
   `Phase4_test.md` Test 2: `queued` → `running` → `completed`, Pipeline
   panel appears, log box fills in, status badge flips to **completed**.
3. **New this phase:** once `completed`, the Pipeline panel should now show
   a **"View requirements log →"** link in addition to the existing
   **"View pushed commit on `dev/...` →"** link. There should be **no**
   "View Spec/Communication Protocol doc" link for this run.
4. Click the requirements log link. It should land on
   `APEX-REQUIREMENTS-LOG.md` at the repo root, on your DEV branch, on
   GitHub, showing:
   - A `# Apex user requirements log` header (only if this is the first time
     anything has ever been logged on this branch).
   - A `## {your CO number}` heading.
   - A dated entry naming your branch, session id, and your username/
     initials, with the requirement text as a bullet underneath.
5. Click the commit link — it should show `apex-notes.txt` **and**
   `APEX-REQUIREMENTS-LOG.md` changed in the **same commit** (open the
   commit's "Files changed" tab on GitHub to confirm both are there
   together, not two separate commits).

Check the DB:

```sql
SELECT status, commit_sha, spec_doc_path FROM pipeline_runs WHERE session_id = <session_id>;
SELECT status FROM pipeline_locks WHERE repo_id = <repo_id> AND co_number = '<co_number>';
```

**Success looks like:** `pipeline_runs.status = 'completed'`, a non-null
`commit_sha`, `spec_doc_path` is **NULL** (no API surface was judged to
exist), and — this is the headline result of this whole phase — **the
`pipeline_locks` row is gone.** No row comes back for that query at all.
This is the first phase where that's true; every prior phase's tests told
you to expect the opposite.

## Test 2 — happy path with an API surface: requirements log AND spec doc

Same as Test 1, but use the `GET /api/ping`-style requirement instead.

**Success looks like:** everything from Test 1, plus:
- The Pipeline panel now also shows a **"View Spec/Communication Protocol
  doc →"** link.
- Clicking it lands on `docs/apex-spec/{co_number}.md` on your DEV branch,
  containing Markdown prose that describes the endpoint you asked for (exact
  wording will vary — this is a real LLM call).
- The commit link's "Files changed" tab shows the route file,
  `APEX-REQUIREMENTS-LOG.md`, **and** `docs/apex-spec/{co_number}.md` all in
  the one combined commit.

```sql
SELECT status, commit_sha, spec_doc_path FROM pipeline_runs WHERE session_id = <session_id>;
```

**Success looks like:** `spec_doc_path` is now
`docs/apex-spec/<co_number>.md` (non-null), matching what the UI linked to.

## Test 3 — a second session on the same branch does NOT regenerate an already-current doc

Immediately after Test 2, submit a second, unrelated, non-API requirement on
the **same branch** (e.g. a small internal refactor or a typo fix in a
comment) through a new or resumed session, and let it run to completion.

**Success looks like:** the Pipeline panel for this second run shows the
requirements log link (it always appears once completed) but **no** spec
doc link, and `pipeline_runs.spec_doc_path` for this new run is `NULL` — the
model judged the existing doc from Test 2 still accurately reflects the
surface, since nothing API-shaped changed. This demonstrates the "only
regenerate when needed" half of roadmap.md's Spec-doc row, not just the
"regenerate when needed" half Test 2 already showed.

(This is judgment-based, not scripted — a real model could occasionally
decide otherwise, especially if your "unrelated" change brushes up against
the same files. If it regenerates anyway, that's not a bug in this phase;
try a change that's more obviously unrelated to the route file.)

## Test 4 — second `/resolve` for the same CO now succeeds (the whole point of this phase)

This is the test every prior phase's test doc has been telling you *not* to
try. After Test 1 or 2 completes and you've confirmed the lock is gone:

```
curl -s -b jdoe.cookies.txt -X POST http://localhost:3000/api/repos/<repo_id>/resolve \
  -H 'Content-Type: application/json' \
  -d '{"coNumber":"<co_number>","action":"continue","branchId":<branch_id>}' | json_pp
```

**Success looks like:** HTTP 200 with `success: true` and the same branch
back in `data.branch` — **not** the `LOCK_HELD` 409 every earlier phase's
test docs warned you to expect. This is the concrete, end-to-end proof that
Phase 5's `releaseLock` call actually works: a CO's pipeline can now be
resolved against, run, and resolved against again, repeatedly, with no
manual lock-clearing required. Confirm the lock is held again now (this new
`/resolve` call re-acquired it):

```sql
SELECT * FROM pipeline_locks WHERE repo_id = <repo_id> AND co_number = '<co_number>';
```

Feel free to let this new session run to completion too, to confirm the
lock is released again afterward — or just release it yourself if you don't
want to spend another model call:

```sql
DELETE FROM pipeline_locks WHERE repo_id = <repo_id> AND co_number = '<co_number>';
```

## Test 5 — a failure partway through Phase 5's new steps still leaves the lock held and the session `failed`

Hard to force deterministically against a real model (same caveat
`Phase4_test.md`'s Test 8 gives for `CODEGEN_PARSE_FAILED`), but the
mechanism is identical and worth confirming once:

1. Get a session to `queued` with a requirement that will pass the sandbox
   build/test (so the pipeline actually reaches Phase 5's new steps).
2. Temporarily point `MODEL_PROVIDER` at a broken/unreachable adapter config
   (e.g. an invalid `NVIDIA_API_KEY`) **after** code-gen would normally
   succeed — in practice this is easiest to simulate by breaking the model
   config *before* queuing, the same way `Phase4_test.md` Test 8 does; the
   pipeline will fail at Phase 4's own code-gen step in that case, which is
   a fine substitute for proving the same downstream guarantee (the lock
   stays held on ANY failure in this pipeline, regardless of which step it
   happens in — Phase 4's and Phase 5's failure paths are handled by the
   exact same `catch` block in `pipelineService.js`).
3. Restart the worker and let it pick the session up.

**Success looks like:** the session ends `failed`, and the lock is still
present:

```sql
SELECT status, error_message, commit_sha, spec_doc_path FROM pipeline_runs WHERE session_id = <session_id>;
SELECT status FROM pipeline_locks WHERE repo_id = <repo_id> AND co_number = '<co_number>';
```

`pipeline_runs.status = 'failed'`, `commit_sha` and `spec_doc_path` both
`NULL` (nothing was ever pushed), and the `pipeline_locks` row for this
`(repo, CO)` is **still there** — restore your real model credentials
afterward, and either let a subsequent run complete successfully to release
the lock, or clear it manually as in Test 4 if you're done testing this CO.

## Common errors

| Symptom | Likely cause |
|---|---|
| `pipeline_locks` row still present after a `completed` session | Check `pipeline_runs.status` for that session first — if it's `failed`, this is expected (see Test 5); if it's `completed`, this would be a real bug worth investigating, unlike in Phase 4 where it was expected either way |
| No requirements log link ever appears, even on a `completed` run | Check the browser network tab / `GET .../sessions/:id` response for a `requirementsLogPath` field — if it's missing, the server-side change to `sessionService.getSessionDetail` isn't deployed; this should never depend on the model, unlike the spec doc link |
| Spec doc link never appears, even for an obvious API-surface requirement | Real LLM judgment call - not every model agrees an example "reads as an API surface." Check `pipeline_runs.spec_doc_path` directly; if it's genuinely NULL, try a more unambiguous requirement (an explicit route/endpoint, not just "add a helper function") |
| Spec doc link appears on every single run, even for changes you didn't expect to affect it | Also a real judgment call, just the opposite direction — the model preferring `docIsCurrent: false` when unsure is intentional per agent-prompts.md's "answer conservatively" prompt instruction, not a bug, though a model consistently over-regenerating is worth noting |
| `Model reply for spec-doc decision (expected a fenced "spec-decision" block) could not be parsed` | The model didn't follow the fenced-block convention this time - not reliably scriptable against a real model; retry with a fresh session/queue, same as Phase 4's equivalent `files-needed`/`file-changes` parse failures |
| `Model requested a file for the spec doc that does not exist in the working tree: ...` | The model named a file-selection path that isn't actually in the repo for the spec-doc step specifically - same fail-closed treatment as Phase 4's code-gen file selection |
| Second `/resolve` for a CO still 409s with `LOCK_HELD` after a session you thought completed | Double check `sessions.status` AND `pipeline_runs.status` for that session - if either is `failed`, the lock is correctly still held (see Test 5); this is not a regression |
| `apex-notes.txt`/route file appears on GitHub but `APEX-REQUIREMENTS-LOG.md` doesn't, in the same run | This would mean the combined-commit design failed to actually be atomic - worth treating as a real bug and re-reading `pipelineService.js`'s `allChanges` construction, since Phase 5's whole point is that this cannot happen given a `completed` status |
| Everything else (`Docker`/model-adapter/GitHub-token errors, sandbox failures, timeouts, branch-deletion races) | See `Phase4_test.md`'s "Common errors" table - Phase 5 doesn't change any of that machinery |

## What this does and doesn't prove

This proves DEV-branch delivery is genuinely complete, not just "code
landed": a single combined commit carries the model's code changes, an
append to the branch's raw user-requirements log, and — when the model
judges the branch's API surface actually needs it — a regenerated Spec/
Communication Protocol document, all sharing one commit SHA; the CO's
pipeline lock is released only after that combined commit actually lands,
and a second `/resolve` against the same CO afterward works normally for
the first time in this project's testing history; a spec-doc regeneration
correctly happens when warranted and correctly does NOT happen when the
existing doc is still current; and any failure anywhere in this extended
pipeline - Phase 4's code-gen/sandbox steps or Phase 5's new delivery
steps - leaves the lock held and the session `failed`, with no
partially-applied state ever reaching GitHub.

It does **not** prove the model's API-surface judgment is *correct* in any
formal sense (Test 3's "should not regenerate" outcome, like every
LLM-judgment test in this project, is a probabilistic expectation, not a
guarantee - see roadmap.md's Accepted Risk #3, which this phase mitigates
but does not eliminate: a human editing the branch directly, outside any
Apex session, still won't trigger a regeneration until the next session's
Phase 5 run happens to notice). It does not prove behavior for two branches
racing on the *same* CO number's spec doc path simultaneously (the
pipeline lock serializes sessions per CO, so this shouldn't be reachable in
normal operation, but two different users' `-1` branches for the same CO,
per roadmap.md's parallel-branches design, could in principle both try to
regenerate the same `docs/apex-spec/{CO}.md` path from two different lock
windows - not specifically exercised here). It does not prove anything
about Phase 6/7 (access administration, observability/hardening) - both
remain entirely unbuilt.
