# Troubleshooting Apex

Operational issues you might hit running or using Apex, beyond initial setup. For
first-time environment bootstrap problems (MariaDB not coming up, port conflicts,
Docker socket permissions), see
[docs/Phase1_setup.md](docs/Phase1_setup.md#troubleshooting) — this document picks up
after setup succeeds, covering the AI pipeline and day-to-day operation.

For architecture background referenced below, see [SPEC.md](SPEC.md) and
[apex_nim_integration.md](apex_nim_integration.md).

## Where to look first

**Logs.** Each process writes structured logs two ways:

```
docker logs -f apex-app              # or apex-worker - apex-doc-worker exits
                                      # right after each nightly run, so this only
                                      # works while that one-shot invocation is live
tail -f logs/worker.log              # survives container recreation, grep-able on the host
```

Pipeline log lines are tagged with `sessionId`, `repoId`, `coNumber`, `runId`, and
`stage`, so you can follow one session's entire clone → codegen → build → test → push
lifecycle:

```
grep '"sessionId":42' logs/worker.log
```

If a session has retried more than once (see Phase 8/9), filter to one specific
`pipeline_runs` attempt with `runId` instead, to avoid interleaving lines from an
earlier failed attempt:

```
grep '"runId":17' logs/worker.log
```

Rotated files are purged after `LOG_RETENTION_DAYS` (default 3); this is separate from
Docker's own `--log-opt max-size=10m --log-opt max-file=3` container-log rotation,
which bounds `docker logs` output independently.

**The database.** There's no admin UI for every table. To inspect state directly:

```
docker exec -it apex-mariadb mariadb -uroot -p<rootpass> apex

# or, pulling credentials straight from .env:
docker exec -it apex-mariadb mariadb \
  -uroot -p"$(grep '^DB_ROOT_PASSWORD=' .env | cut -d'=' -f2)" \
  "$(grep '^DB_NAME=' .env | cut -d'=' -f2)"
```

Useful starting queries for a stuck session:

```sql
SELECT id, branch_id, status, resume_requested FROM sessions WHERE id = ?;
SELECT * FROM pipeline_runs WHERE session_id = ? ORDER BY id DESC;
SELECT * FROM session_requirements WHERE session_id = ?;
SELECT * FROM pipeline_locks WHERE repo_id = ? AND co_number = ?;
```

**Build/test output** for a specific run isn't in any container log — it's in
`pipeline_runs.build_log` / `test_log`, surfaced on the branch page in the UI.

## Pipeline issues

**A session sits in `queued` forever.**
`apex-worker` isn't running. `make dev` alone starts the web app, which is enough to
browse repos and clarify requirements — nothing picks up `queued` sessions without
`make worker` also running. Confirm with `docker ps` / `docker logs apex-worker`.

**Pipeline fails immediately with "has no apex.pipeline.json" / "is not valid JSON" /
"is missing a non-empty field".**
The runner never invents a default build/test command or image
([pipelineConfig.js](app/lib/pipeline/pipelineConfig.js)) — the target repo must have a
valid `apex.pipeline.json` at its root, on the branch being built, with non-empty
`image`, `buildCommand`, and `testCommand` string fields.

**Build or test fails only inside Apex, never locally.**
The sandbox's network is disconnected before build/test run — there is no registry
egress (npm/PyPI/Maven/etc.) once codegen finishes. If a repo's build/test step needs
to reach a package registry at that point, it will fail here even though it works on a
machine with normal internet access. The repo needs to vendor or cache those
dependencies ahead of time (e.g. commit a lockfile-resolved `node_modules`, or a
pre-built dependency cache baked into the `apex.pipeline.json` image).

**"Codegen finished without writing any files" / "Codegen did not finish within 40
turns" / a pipeline failure whose error message looks like a raw model-loop problem.**
See [apex_nim_integration.md](apex_nim_integration.md#known-failure-modes) — these are
codegen-stage failures, not infrastructure problems. Check `pipeline_runs.error_message`
for the exact one.

**The "Resume from `<stage>`" button is missing or disabled on a failed session.**
Resume is only offered while the failed run's sandbox container is still alive and its
`resume_attempt_count` is under 3. Once a resume attempt itself fails for the third
time, the container is torn down automatically and only "Retry (full re-run)" remains —
this is expected, not a bug. A full retry always works regardless of resume history; it
discards the old container and starts clone → codegen → build → test → push over.

**Push fails with a merge conflict.**
Non-fast-forward pushes are retried automatically via fetch-then-merge (never
force-pushed — another engineer may be pushing directly to the same DEV branch). A
genuine conflict surfaces as a loud pipeline failure rather than being silently
resolved; someone needs to resolve it on the DEV branch manually (or via a fresh
session/branch), the same as any other git merge conflict.

**Push or branch creation fails with a 403, or an entry appears on `/admin/alerts`.**
This is either the GitHub App's own permission scope (it only has `contents: write`,
nothing broader) or the `dev/**` repository ruleset rejecting the ref — both look like
a plain 403 from GitHub's side. `/admin/alerts` records which repo/session hit it and
the raw detail text. If the App's credentials themselves are the suspected issue (not
just this repo's ruleset), see
[docs/github-app-key-rotation.md](docs/github-app-key-rotation.md).

**"Another session holds the lock for this CO" / an entry on `/admin/locks`.**
Only one AI session can be in flight per `(repo, co_number)` at a time, across every
user. `/admin/locks` shows every currently-held lock and the historical log of contested
acquisitions. If the session actually holding the lock is abandoned and its original
owner can't resume/retry it themselves (account disabled, gone, etc.), an admin can
force-unlock it from that page — this only frees the lock slot; it does not touch the
orphaned session's own `failed` status.

## The whole site shows "The site is under maintenance"

Two different conditions produce that page, and the message tells you which:

- **"No model is available."** The `models` table has no enabled row. This is the
  expected state of a fresh install — the catalog ships empty and there is no `MODEL`
  env fallback. Add and enable a model at `/admin/models`. It also appears if an admin
  disabled the last enabled model.
- **An admin-authored message.** Someone turned on the maintenance lock at
  `/admin/maintenance`. Turn it off there.

Admins are never blocked by either — they see a red banner instead and keep full access,
which is what makes the no-model case recoverable at all. `/login` also stays open, so
an admin can get in to fix it. Everyone else gets HTTP 503 with `Retry-After`.

Both conditions also stop `apex-worker` claiming new sessions and stop
`docWorker.js` scanning or draining. A session already running is left to finish
rather than killed mid-pipeline, so nothing is abandoned with a half-written branch and
a held CO lock. Queued sessions stay queued and resume once the lock clears.

State is cached in-process for ~5s, and the app, worker, and spec-doc worker are three
separate containers — so expect up to a few seconds' lag between toggling the lock and
every process agreeing on it.

## Documents are being generated by the wrong model

Document generation does not use any user's model selection — it runs unattended
overnight with nobody behind it. Each document uses the **Model** set on its own
definition on `/admin/documents`, falling back to the catalog default when that is
unset.

If docs are coming out on a model you didn't choose, check that page: when the configured
model has since been disabled or deleted, the definition shows a warning naming the model
actually in use, and `docWorker` logs `configured model for this document is missing or
disabled - falling back to the catalog default`.

Note the model is stamped on each job when the **nightly scan enqueues it**, not when it
runs. Changing the setting does not retarget jobs already queued; those generate with the
model they were queued under.

## Model / NIM issues

**A clarification question, codegen turn, or doc generation comes back garbled (e.g. a
string of `!!!!`), empty, or wildly off-topic.**
Check which model the work actually ran against — `/admin/usage` reports usage per
model, and the session's stamped model is what produced it (not whatever is selected
now). `moonshotai/kimi-k3` has a known intermittent bug along these lines;
`google/gemma-4-31b-it` avoids it. Disable the bad model on `/admin/models` rather than
asking users to avoid it. Also check that the model actually supports the
`reasoning_content` fallback shape if you add a new one — see
[apex_nim_integration.md](apex_nim_integration.md#request-response-handling).

**A model call fails outright with an "NVIDIA NIM returned HTTP ..." or "no usable
content" error.**
Whether there was a delay first tells you which kind of failure it was, and the two want
different checks:

- **After a ~1.5s delay** — a network error, a 5xx, or a 408: the retry budget (3
  attempts, exponential backoff) ran and exhausted itself. Check `NVIDIA_API_KEY` and
  `NVIDIA_BASE_URL` are correct and that the NIM endpoint is reachable from wherever the
  call originated (`apex-app` for clarification/overlap, `apex-worker` for codegen,
  `apex-doc-worker` for generated documents — each needs outbound
  network access at the time of the call; note codegen's network is only open during that
  stage, before build/test seals it).
- **Immediately, with exactly one request in the logs** — a request-shaped failure
  (a 400, 401, 403, 429). These are **not** retried as of ROADMAP.md Phase 19: nothing
  about the request changes between attempts, so retrying only reproduces it. Read the
  status: `401`/`403` is credentials, `429` also locks the provider (see below), and a
  `400` reported as *"the request exceeded the model's context window"* means the prompt
  itself was too big — most likely codegen, whose message list grows across up to 40
  turns. Nothing to fix in the endpoint config; the work was too large.

**Codegen fails with "NVIDIA NIM stopped generating at the max_tokens limit
(model "...", max_tokens=...)".**
The model's reply was cut off mid-output by the output-token ceiling, so it was discarded
rather than written — a half-finished file body would otherwise have replaced a real
file wholesale. Codegen tells the model its reply was cut off and lets it try a smaller
change twice before failing the stage. If the files in play legitimately need longer
replies, raise that model's **Max Tokens** on `/admin/models` (4096, the default for a
new model, is roughly a 400-line ceiling) and re-run the session. If instead the model keeps trying to rewrite one very large file
whole, the fix since Phase 21 is `REPLACE_LINES` — see the next entry for why it isn't
reaching for it.

**Codegen refuses to write a file: "Refusing to write "<path>" - you were shown only the
first 8000 characters..." (or "...is too large to read", "...you have not read this
file").**
**This is expected behavior, not a bug.** A whole-file write replaces everything, and
`MAX_FILE_CHARS` caps a read at 8,000 characters — so rewriting a file the model only
partly read would delete the rest of it, silently, and pass build/test if the deleted
code isn't exercised by the repo's `testCommand`. Apex refuses instead (ROADMAP.md
Phase 19).

**Since Phase 21 this refusal is not a dead end**, and that changes the diagnosis. The
refusal text now points the model at `REPLACE_LINES`, which edits a file of any size by
naming a line range and restating the text it expects to find there. So a *single*
refusal followed by a ranged edit is the system working as designed. What warrants
investigation is the model never taking that route:

1. Check the codegen transcript for a `FETCH_OUTLINE` or `FETCH_RANGE` turn after the
   refusal. If there is none, the model ignored the suggestion — usually a prompt or
   model-capability issue, not an Apex one.
2. If `FETCH_OUTLINE` came back "no outline is available", the structural index didn't
   build — see "Codegen runs without outlines" below. Ranged reads still work without
   it, but the model has lost its cheapest way to find *where* to look.
3. Only if the file is over `MAX_CONTAINER_FILE_BYTES` (2 MB) is it genuinely out of
   reach, and the refusal says so explicitly.

Do not "fix" this by raising `MAX_FILE_CHARS`: the output-token ceiling still makes a
3,000-line whole-file rewrite impossible, so the write would be accepted and then cut
off instead of refused.

The prompt's file tree marks every such file `[too large to read whole - use ranges]`
with its size, so the model should be steering around them rather than discovering the
limit mid-run. If you are seeing this refusal *often*, check that the tree block is
actually rendering sizes — a `(tree unavailable)` block means the map fetch failed and
the model is working blind (see "The model behaves as though files don't exist").

**Codegen loops on "Refusing REPLACE_LINES on <path> - the EXPECTED text does not match
what is actually on lines N-M", eventually failing with "did not finish within 40
turns".**
A single mismatch is the verification working, and it is designed to self-correct: the
refusal quotes the file's real contents for those lines, so the next attempt has the
truth in front of it. A *loop* means something systematic. In order of likelihood:

1. **The model is including the line-number prefixes** Apex adds when displaying a
   range (`1200\tconst x = ...`). Those are display only and are not in the file. Both
   the range display and the refusal say so; some models still do it.
2. **It is editing one file top-down.** Each applied edit shifts every line after it, so
   the second edit's line numbers are stale. Every applied-write reply states the new
   file length and says to work bottom-up.
3. **Leading whitespace differs.** Trailing whitespace in `EXPECTED` is tolerated;
   leading whitespace is not, because indentation is semantic in Python, YAML and Make.
   A de-indented anchor refuses, correctly.
4. **The file is being changed underneath the model** — only possible if something other
   than codegen is writing into the container, which shouldn't happen.

Nothing is written on a refusal, so a loop wastes turns but cannot corrupt the tree. The
session is safe to retry.

**Codegen runs without outlines: worker log shows "structural index unavailable -
codegen continues without outlines".**
**Not a pipeline failure** — it is logged at `warn` and the run continues. The
consequences are bounded: the prompt's file tree falls back to Phase 20's `~` byte-
derived line estimates, and `FETCH_OUTLINE` answers "no outline is available". Ranged
reads and anchored writes are unaffected, because both read and verify against the
container's actual bytes rather than the index.

The log line carries a reason. The likely ones:

- **No `awk` in the sandbox image.** The extractor assumes only POSIX `sh`, `awk` and
  `git`, but a sufficiently stripped image may lack `awk`. Add it to the repo's image.
- **Timeout.** `APEX_INDEX_TIMEOUT_MS` (default 120,000) expired — a very large repo, or
  one pathological file that slipped past the exclusion rules.
- **`git ls-files` failed**, which means the clone step left the workspace in a bad
  state; the codegen stage will usually be failing for that reason anyway.

An index is also simply absent for any commit no codegen run has ever processed — that
is by design, not a fault (see SPEC.md's `repo_file_maps` entry). It is why
clarification often reports no outline on a repo that has never completed a pipeline run.

**The model says a file "was not found" and offers to create it, but the file clearly
exists on the branch.**
If the file is over 1 MB, this was the pre-Phase-19 behavior: GitHub's contents API
returns a different response shape above 1 MB, which Apex mapped to "not found." It now
reports *"<path> exists but could not be read: ... over the 1 MB limit"* and refuses any
write to it. If you still see the old message for a large file, you're running code from
before Phase 19.

**Every model call fails immediately with `"Model provider "<provider>" is locked
(...)"`, with no delay and no NIM request in the logs at all.**
The circuit breaker ([providerHealth.js](app/lib/model/providerHealth.js)) tripped on a
prior quota/billing-shaped failure (HTTP 429/402, or a quota/billing/credit keyword) and
is now failing every call fast, before even attempting one. Check `/admin/usage` for the
provider's status and reason, and use the "Clear lock" button there once the underlying
quota/billing issue is actually resolved — there's no auto-expiry, so it stays locked
until an admin clears it.

**Usage/cost numbers on `/admin/usage` look wrong or missing for a call that clearly
happened.**
Usage logging is best-effort and non-blocking by design (a `usage_events` write failure
must never fail the clarification loop, codegen, or doc regen) - a gap there doesn't
mean the model call itself failed. Only successful `generate()` calls write a row;
failed/retried attempts (see above) don't, since NIM's error responses carry no token
counts to log.

## A generated document is not updating

Generated documents regenerate via `apex-doc-worker`, a one-shot script run nightly
by cron (`make doc-worker`; see ROADMAP.md Phase 15), completely decoupled from
`apex-worker`'s AI-pipeline queue. If one looks stale:

1. **Check that a document is defined at all, and that it is active, on
   `/admin/documents`** (ROADMAP.md Phase 24). Apex ships with no document definitions —
   on a fresh install nothing is generated and nothing is wrong; `logs/doc-worker.log`
   will say `No Active Document to generate` and the run will exit 0. That log line is
   the symptom to look for, and it is not an error.
2. **Check that the document is turned on.** Turning one off stops regeneration but
   deliberately does *not* delete what was already written, so a repo's Documents page
   keeps showing the last generated version (annotated "no longer regenerating"). Admin
   actions are audited, so `admin_audit_log`
   (`doc_definition.deactivate` / `doc_definition.delete`) will say who did it and when.
   A document that has been *deleted* is archived, not purged: it disappears from every
   page while its generated content stays in `repo_documents`, unreachable.
3. Confirm the nightly cron invocation of `make doc-worker` is actually
   configured and ran (check the host crontab/systemd timer/CronJob, whichever
   the deployment target uses) — there's no persistent container to check with
   `docker ps` anymore.
4. Check `repo_doc_sync` for that `(repo_id, doc_type)` against the repo's actual
   default-branch HEAD on GitHub, *and* its `synced_prompt_revision` against the
   definition's `prompt_revision` — the scan enqueues a job when either differs.
   Staleness is tracked per document, so one being current says nothing about another.
   (`repos.spec_doc_synced_commit_sha` is the superseded, no-longer-written column this
   replaced — ignore it.)
5. Check `doc_jobs` for a row for that `(repo_id, doc_type)`, and `logs/doc-worker.log`
   for the error (each job failure is logged independently; one repo's failure doesn't
   block others draining from the same queue). A `failed` row is a generation error; a
   `skipped` row means the document was turned off or deleted between the scan that
   queued it and the drain, which points back at step 2.
6. If the log says the configured model was missing or disabled and the catalog default
   was used instead, the document *was* generated — just not by the model the admin
   picked. Re-pick it on `/admin/documents`.

## I edited a document's prompt and nothing changed

Expected, for up to a day. A prompt edit bumps `doc_definitions.prompt_revision`, which
makes every repo's copy stale — but regeneration rides the next nightly `make
doc-worker` run like everything else. There is no "regenerate now" button. If the next
morning's run still hasn't changed it, work through "A generated document is not
updating" above, paying attention to step 4: `synced_prompt_revision` should be behind
the definition's `prompt_revision` until the job completes.

Two edits that deliberately change nothing: the **title** and the **description**.
Neither is ever sent to the model, so neither can change the output and neither bumps
the revision. Only the **Model prompt** field does.

Note this worker also retires stale `repo_file_maps` rows (ROADMAP.md Phase 20), so
step 3 of that list has a second symptom: if the nightly invocation isn't running at
all, that table grows without bound. The prune runs from `docWorker.js`'s `main()`, not
from the document scan (Phase 23), so it keeps running even with no documents defined
at all — steps 1 and 2 are not causes of this one. It won't produce wrong behavior —
maps are keyed by commit sha, so an old row is never served for a new commit — but it is
the same root cause.

## The model behaves as though files don't exist

Symptom: clarification asks about files that are obviously there, codegen creates a file
that already exists, or codegen refuses a write saying it can't confirm whether the file
exists. All of these trace to the repo file map (ROADMAP.md Phase 20,
[repoMap.js](app/lib/repoMap.js)) rather than to the model.

1. **Read the tree block in the prompt first.** It is self-describing: it states how
   many of the repo's files it is showing, how many were excluded as generated/vendored/
   non-text, how many were omitted for space, and whether GitHub's own tree response was
   truncated. Most "the model can't see my file" reports are answered by that line.
2. **An excluded or omitted file is still known to Apex.** The map stores the commit's
   full path list separately from what the prompt shows, and that full list is what the
   codegen write guard checks — so a file missing from the prompt does *not* become a
   file codegen will blindly create over. If the model is nonetheless ignoring a file
   that matters, the fix is selection (the exclusion and ranking rules in `repoMap.js`),
   not the guard.
3. **`(tree unavailable)` means the tree fetch failed**, not that the repo is empty.
   Check GitHub App credentials and reachability (see "GitHub App / token issues").
   Codegen still runs in this state, but can only write files it explicitly fetched
   first.
4. **A refusal naming a file as too large is expected behavior**, not a map problem —
   see the codegen refusal entry above. The map is what makes that refusal visible up
   front rather than a surprise mid-run, and since Phase 21 it is a detour rather than
   a dead end.
5. **In codegen specifically, the map is not what reads are served from.** Since Phase
   21 every codegen read comes from the sandbox container's working tree, so "the model
   says the file isn't there" during codegen is a question about the *clone*, not about
   `repo_file_maps`. Check the clone step succeeded and that the path is tracked by git
   — an untracked or gitignored file is on disk and readable but absent from the index.
   Clarification and the Spec doc still read from GitHub.
6. **A map row is never stale for a given commit** — `repo_file_maps` is keyed by
   `(repo_id, commit_sha)`, so a moved branch misses the cache rather than serving an old
   answer. If you suspect the cache anyway, deleting that repo's rows is safe: the next
   call rebuilds from GitHub.

## Permissions and access

**A user can see a repo group in the admin UI but gets "forbidden" / can't act on its
repos.**
Access is granted per `(user, repo_group)` via `user_repo_group_permissions` — there is
no separate per-repo or per-action grant. Confirm the grant exists on
`/admin/permissions` for that user and group.

## Environment reference

Full variable list and what each controls: see
[.env.example](.env.example). The ones most relevant to the issues above:

| Variable | Affects |
|---|---|
| `PIPELINE_POLL_INTERVAL_MS` | How often `apex-worker` checks for a new `queued` session. |
| `PIPELINE_STEP_TIMEOUT_MS` | Per-step (build/test) timeout inside the sandbox. |
| `LOG_RETENTION_DAYS` | How long rotated `logs/*.log` files are kept. |

`MODEL_MAX_TOKENS` is no longer an env var — it is per-model **Max Tokens** on
`/admin/models`. Set too low, it doesn't shorten replies: a reply that hits the limit is
**discarded entirely** and the turn fails, so codegen loses turns (and eventually the
stage) on any file it can't emit within the budget.

For Docker/Podman architecture questions (why the worker needs the host socket, why
sandbox containers aren't bind-mounted, what runs where), see
[docs/docker-usage.md](docs/docker-usage.md).
