# Phase 4 manual testing

Phase 4 adds sandboxed execution: a host-side "clone" (GitHub tarball
download), a two-step non-tool-calling code-generation exchange against the
model adapter, a network-isolated Docker container that runs a repo's
declarative build/test commands, and — only if that succeeds — a push to the
DEV branch via GitHub's Git Data API. A new `worker.js` process picks up
`queued` sessions independent of any browser tab. See roadmap.md's "Phase 4
— Sandboxed execution" bullets for the scope this implements, and
`agent-prompts.md`'s "Phase 4" section for the fenced-block tags, audit-log
semantics, and design rationale behind it.

Because this phase talks to a real LLM and a real Docker daemon, exact
timing and exact generated file content will vary run to run. The tests
below tell you what to set up and what shape of thing to expect back, not an
exact diff to match.

**Testing is primarily done through the browser**, per this phase's UI
requirement — you submit requirements and then just watch the session page
update through `queued` → `running` → `completed`/`failed` with no manual
refresh. curl is used only where there's genuinely no UI path (starting the
worker process itself, and directly poking the DB to simulate a
deleted-branch race).

## Prerequisites

1. Everything from `Phase1_test.md`, `Phase2_test.md`, and `Phase3_test.md`
   — a running app, a seeded org/repo group/repo/permissions, two registered
   users, a working GitHub App (`contents: write`, installed on a real test
   repo you can freely push to), and a working model adapter
   (`MODEL_PROVIDER=nvidia-nim` with a valid `NVIDIA_API_KEY`, or your own
   adapter).
2. **Docker, installed and running locally.** This is a new prerequisite as
   of Phase 4 — nothing before this phase needed it, and the environment
   this phase was built in did not have Docker installed, so none of the
   sandbox-execution code below has been run end to end by the author. Start
   Docker Desktop (or your local Docker daemon) before running any test past
   Test 2.
3. **A pullable sandbox image.** `SANDBOX_IMAGE` in `.env` (see step 5)
   names the image the sandbox container runs. `node:20` is a reasonable
   default for a Node.js test repo; pull it ahead of time so the first
   pipeline run isn't stalled behind a slow image pull:
   ```
   docker pull node:20
   ```
4. **New `.env` variables** (see `env` for the sample values and comments):
   ```
   SANDBOX_IMAGE=node:20
   SANDBOX_TIMEOUT_SECONDS=600
   SANDBOX_MEMORY_LIMIT=
   WORKER_POLL_INTERVAL_MS=5000
   ```
   `SANDBOX_MEMORY_LIMIT` can stay blank (no `--memory` flag is passed to
   Docker when unset).
5. **No new npm dependencies.** Phase 4 shells out to the `docker` and `tar`
   CLIs via `child_process` rather than adding `dockerode`, `simple-git`, or
   a YAML parser — nothing to `npm install`.
6. **Schema change: re-apply `db/schema.sql`.** Phase 4 adds one new table,
   `pipeline_runs` — a plain `CREATE TABLE IF NOT EXISTS`, so this is safe
   to run against your existing dev database (no `ALTER TABLE`, no data
   loss):
   ```
   make db-schema
   ```
7. **Your test repo needs an `apex.pipeline.json` at its root**, committed
   directly to its default branch (or to the DEV branch you'll test against
   — either works, since Phase 4 reads it from whatever branch it clones).
   Phase 4 never invents build/test commands, so a repo without this file
   will fail loudly (see Test 3). A minimal example for a small Node.js repo:
   ```json
   {
     "buildCommand": "npm install --no-audit --no-fund",
     "testCommand": "npm test",
     "image": "node:20",
     "timeoutSeconds": 300
   }
   ```
   If your test repo has no real test script, a harmless placeholder works
   fine for exercising the pipeline mechanics:
   ```json
   {
     "buildCommand": "echo build step ok",
     "testCommand": "echo test step ok",
     "image": "node:20"
   }
   ```
   `image` and `timeoutSeconds` are optional (they fall back to
   `SANDBOX_IMAGE`/`SANDBOX_TIMEOUT_SECONDS`); `buildCommand` and
   `testCommand` are required.
8. A resolved branch with a finalized, `confirmed_proceed` requirement
   ready to go — i.e., a session already sitting at `queued` (see
   `Phase3_test.md` Tests 1–3 for how to get there). If you don't have one,
   set one up now against a fresh CO before starting the tests below. Pick a
   requirement that's easy to eyeball on GitHub afterward, e.g.:
   > Add a new top-level file called `apex-hello.txt` containing the single
   > line `hello from apex`.

## Start the worker

The worker is a separate process from the web server — both need to be
running for this phase to do anything end to end.

```
make dev      # (if not already running, in one terminal)
make worker   # in a second terminal
```

or, for auto-restart on file changes while iterating:

```
make worker-dev
```

**Success looks like:** a single JSON log line on startup —
`"Apex worker starting"` with `pollIntervalMs` in its `meta` — and then
silence (one line every `WORKER_POLL_INTERVAL_MS` only when it actually
claims a session, not on every empty poll).

## Test 1 — worker ignores everything except `queued`

With no `queued` session yet (or after the one from Prerequisites #8 has
already been picked up by a later test), leave the worker running for a
minute and confirm no log lines appear and nothing in the DB changes:

```sql
SELECT id, status FROM sessions ORDER BY id DESC LIMIT 5;
```

**Success looks like:** every session that isn't `queued` (i.e. `running`,
`completed`, `failed`, or a `running` session still mid-clarification-loop
from Phase 3) is left completely alone.

## Test 2 — browser click-through: watching a pipeline run end to end

This is the primary way to exercise this phase.

1. Log in, navigate to the session page for the `queued` session from
   Prerequisites #8 (`/repos/<id>/branches/<id>/session`, or via the
   branches list's "Open session" link).
2. The status banner should read **"queued"**. There is no Pipeline panel
   yet — nothing has picked the session up.
3. Leave the tab open (or navigate away and come back — either is fine,
   this is the point of Phase 4's UI polling). Within `WORKER_POLL_INTERVAL_MS`
   of the worker starting, it should claim the session.
4. Refresh (or just wait — the page polls automatically every few seconds
   while status is `queued`/`running`): the status banner flips to
   **"running"**, and a **Pipeline** panel appears with a `running` badge
   and a log box (initially empty or showing `(no log yet)`).
5. Keep watching. Once the sandbox build/test step finishes and the push
   succeeds, the page should update itself (no manual refresh needed) to:
   - Status banner: **"completed"**.
   - Pipeline panel badge: **"completed"**.
   - Pipeline log box: the captured `buildCommand`/`testCommand` output.
   - A **"View pushed commit on `dev/...` →"** link, pointing at
     `https://github.com/<owner>/<repo>/commit/<sha>`. Click it — it should
     land on a real commit on GitHub, on your DEV branch, containing the
     file change(s) the model generated (e.g. `apex-hello.txt`, if you used
     the example requirement above).
6. Confirm the polling actually stopped once the session reached a terminal
   state — open your browser's network tab (or just note that the page
   stops updating): no further `GET .../sessions/:id` calls should fire
   after `completed`/`failed`.

Check the DB to confirm what the UI showed:

```sql
SELECT status, completed_at FROM sessions WHERE id = <session_id>;
SELECT status, commit_sha, error_message FROM pipeline_runs WHERE session_id = <session_id>;
SELECT status FROM pipeline_locks WHERE repo_id = <repo_id> AND co_number = '<co_number>';
```

**Success looks like:** `sessions.status = 'completed'` with a
`completed_at` timestamp, `pipeline_runs` has one row with
`status = 'completed'` and a non-null `commit_sha`, and — this is
important, not a bug — the `pipeline_locks` row for this `(repo, CO)` is
**still there**. Phase 4 never releases it (see `agent-prompts.md`'s Phase 4
"Scope boundary vs. Phase 5" section); releasing it is Phase 5's job, which
doesn't exist yet.

Also confirm two new audit rows were written for this session's
code-generation calls, distinct from anything Phase 3 wrote:

```sql
SELECT raw_instructions, LEFT(qa_history, 80) FROM audit_log
  WHERE repo_id = <repo_id> AND co_number = '<co_number>' ORDER BY created_at DESC LIMIT 2;
SELECT role, LEFT(content, 80) FROM conversations WHERE session_id = <session_id> AND role = 'system';
```

**Success looks like:** two audit rows with `raw_instructions` **NULL** and
`qa_history` containing a fenced `files-needed`/`file-changes` block, and
two `conversations` rows with `role = 'system'` — these are excluded from
the transcript panel on the session page (by design; see
`agent-prompts.md`), so you won't see them rendered there, only in the DB.

## Test 3 — missing `apex.pipeline.json` fails loudly

Resolve/queue a session against a CO on a repo (or a branch) that does
**not** have an `apex.pipeline.json` at its root. Once the worker claims it:

**Success looks like:** the session flips to `failed`, and the session
page's Pipeline panel shows a red error box with a message like:

> Repo is missing an apex.pipeline.json file at its root - Phase 4 requires
> an explicit, declarative build/test config and never invents default
> commands

Check the DB:

```sql
SELECT status, error_message FROM pipeline_runs WHERE session_id = <session_id>;
```

**Success looks like:** `status = 'failed'`, `error_message` matches the
text above, and `log`/`commit_sha` are both `NULL` — the pipeline never
reached the sandbox or push steps.

## Test 4 — build/test failure inside the sandbox

Point `apex.pipeline.json`'s `testCommand` at something guaranteed to fail,
e.g. `"testCommand": "exit 1"`, on a branch with a `queued` session. Once
picked up:

**Success looks like:** the session page's status banner and Pipeline badge
both show **"failed"**, the log box shows whatever `buildCommand` produced
plus the failing command's output, and the error message reads something
like `Build/test failed (exit code 1)`. No commit link appears (no push was
attempted). Confirm on GitHub that nothing new was pushed to the branch.

```sql
SELECT status, error_message FROM pipeline_runs WHERE session_id = <session_id>;
```

## Test 5 — sandbox timeout

Set a short timeout to make this practical to test,
e.g. `"timeoutSeconds": 5` in `apex.pipeline.json`, with a `testCommand`
that sleeps longer than that (`"testCommand": "sleep 30"`). Once picked up:

**Success looks like:** after roughly 5 seconds, the session fails with an
error message like `Build/test timed out after 5s`. Confirm the container
was actually killed and not left running:

```
docker ps --filter "name=apex-pipeline-"
```

**Success looks like:** no matching container is still running (it was
`docker kill`ed and removed via `--rm`).

## Test 6 — branch-existence re-check at pipeline start

This is the second of the two on-demand deletion checkpoints (the first is
Phase 2's branch-list render) — there's no UI action that simulates GitHub
deleting a branch out from under a queued session, so this needs a bit of
manual setup with curl/SQL.

1. Get a session to `queued` on a branch as usual.
2. **Stop the worker** (so it can't pick the session up yet).
3. Delete the branch directly on GitHub (web UI: repo → Branches → delete
   icon, or `git push origin --delete <branch>`), simulating an engineer
   deleting it out from under the queued work.
4. Restart the worker (`make worker`).

**Success looks like:** the session flips to `failed` with an error message
containing "no longer exists on GitHub", and the branch's row in the DB
flips to `deleted`:

```sql
SELECT status FROM branches WHERE id = <branch_id>;               -- 'deleted'
SELECT status, error_message FROM pipeline_runs WHERE session_id = <session_id>;
```

Refresh the branch list page for this repo/CO in the browser — the deleted
branch should no longer appear, same as Phase 2's Test 9.

## Test 7 — fetch-and-retry on a non-fast-forward push

Harder to trigger deterministically since it depends on winning a race
against the worker, but worth attempting once to see the retry log line:

1. Get a session to `queued` on a branch that already has some history.
2. As soon as you see the Pipeline panel appear with status `running` (i.e.
   the worker has started this session's pipeline but likely hasn't pushed
   yet), quickly push a small, unrelated commit directly to the same branch
   on GitHub (web UI's "Edit file" + commit is the fastest way).
3. Watch the outcome.

**Success looks like either:**
- The pipeline's push lands *after* your manual commit and GitHub reports a
  non-fast-forward on the first attempt — check the worker's stdout/log for
  a `"non-fast-forward push, re-fetching head and retrying"` line — and the
  session still reaches `completed`, with the final commit's parent being
  your manually-pushed commit (visible in GitHub's commit graph for the
  branch); **or**
- You didn't win the race and the pipeline simply pushed first, which is
  also a valid outcome — you can just try again with a tighter window, or
  accept that this test is inherently timing-dependent and move on. What
  matters for this phase is only that `force: false` is what's ever sent
  (visible directly in `app/lib/github/commitService.js` if you want to
  confirm by reading rather than reproducing the race).

## Test 8 — unparseable model reply fails the run closed

Hard to force deterministically against a real model, but you can simulate
it by temporarily pointing `MODEL_PROVIDER` at a broken/unreachable
adapter config (e.g. an invalid `NVIDIA_API_KEY`) before queuing a session,
restarting the worker, and letting it pick the session up.

**Success looks like:** the session fails with the underlying model-call
error surfaced in `pipeline_runs.error_message` (not a
`CODEGEN_PARSE_FAILED` in this specific case, since the call itself failed
rather than returning something unparseable — but the outcome is the same
shape: `failed`, a clear message, nothing applied or pushed). Restore your
real model credentials afterward.

## Common errors

| Symptom | Likely cause |
|---|---|
| Worker logs nothing, ever, even with a `queued` session sitting in the DB | Worker process isn't actually running (`make worker` in a separate terminal from `make dev`), or `WORKER_POLL_INTERVAL_MS` is very large |
| `Failed to start Docker (...). Is Docker installed and running?` | Docker Desktop/daemon isn't running, or the `docker` binary isn't on the worker process's `PATH` |
| Sandbox step hangs for a long time on first run | Normal if `SANDBOX_IMAGE` hasn't been pulled yet - `docker pull node:20` ahead of time (Prerequisites #3) |
| `Repo is missing an apex.pipeline.json file at its root...` | Add the file to the repo (Prerequisites #7) - Phase 4 never invents default build/test commands |
| `apex.pipeline.json is not valid JSON: ...` | Syntax error in the config file - check it parses with any JSON linter |
| `No sandbox image available - set "image" in apex.pipeline.json or SANDBOX_IMAGE in the environment` | Neither the config file nor `.env` names an image |
| `Model requested a file that does not exist in the working tree: ...` | The model named a `files-needed` path that isn't actually in the repo - a real (if rare) LLM mistake; this phase fails the run closed rather than guessing, per agent-prompts.md's Phase 4 section |
| `Model reply for file selection (expected a fenced "files-needed" block) could not be parsed` / same for `file-changes` | The model didn't follow the fenced-block convention this time - not scriptable to force reliably against a real model; retry the run (a fresh session/queue) |
| `Build/test failed (exit code N)` | Your `apex.pipeline.json`'s commands genuinely failed inside the sandbox - check the Pipeline panel's log box for the actual build/test output |
| `Build/test timed out after Ns` | Commands ran longer than `timeoutSeconds` (config file) or `SANDBOX_TIMEOUT_SECONDS` (env default) |
| `Target branch no longer exists on GitHub - halted before starting work` | The branch was deleted between queueing and worker pickup (Test 6) - this is the intended behavior, not a bug |
| `Failed to update ref "..." after 3 attempt(s) (...)` | Exhausted fetch-and-retry - either something other than a non-fast-forward is wrong (check the detail text), or the branch is being pushed to unusually fast/concurrently |
| Pipeline panel never appears on the session page | The worker hasn't claimed the session yet (still `queued` - check the worker is running), or the page's auto-poll hasn't ticked yet (wait a few seconds) |
| `pipeline_locks` row still present after a `completed` session | Expected, not a bug - Phase 4 never releases it (see Test 2's DB check and agent-prompts.md's Phase 4 "Scope boundary vs. Phase 5") |
| `NVIDIA NIM chat request failed (...)` / `fetch failed` | Model adapter misconfigured - see `Phase1_test.md`'s error table |
| `GitHub tarball download failed (...)` / `GitHub installation token request failed (...)` | GitHub App creds wrong, or the App's grant doesn't actually include `contents: write` (needed for `mintCloneOnlyToken`'s `contents: read` request and `mintPushToken`'s `contents: write` request to both succeed as subsets of it) |

## What this does and doesn't prove

This proves the full sandboxed-execution pipeline end to end: a queued
session is picked up by a worker process independent of any browser tab; the
branch's existence is re-verified immediately before work starts; the
repo's tree is downloaded host-side using a token that is provably scoped to
read-only; a declarative, never-invented build/test config is required;
code changes are generated through a two-step, non-tool-calling exchange
with the model and applied to a real working tree; those changes are
validated inside a network-isolated, time-boxed container before anything
is pushed; a successful build/test run results in a real commit on the DEV
branch via GitHub's Git Data API, using a separately-minted write-scoped
token that never touched the sandbox; a non-fast-forward push is retried
rather than force-pushed; and the whole thing is watchable from a single
browser tab via auto-polling, with no curl required for the happy path.

It does **not** prove crash-recovery for a worker that dies mid-run (see
agent-prompts.md's "Known limitation" note - a `running` session with no
worker left to finish it just sits there), does not prove behavior under
multiple concurrent workers (only one was run for these tests, and the
atomic-claim `UPDATE` is what's relied upon rather than exercised
adversarially here), and does not prove anything about Phase 5 (DEV-branch
delivery): there is no Spec/Communication Protocol doc, no requirements-log
file, and the `pipeline_locks` row for a completed CO is never released by
this phase - by design, not oversight, per roadmap.md's Phase 4/5 split.
