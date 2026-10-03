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
docker logs -f apex-app              # or apex-worker - apex-spec-doc-worker exits
                                      # right after each nightly run, so this only
                                      # works while that one-shot invocation is live
tail -f logs/worker.log              # survives container recreation, grep-able on the host
```

Pipeline log lines are tagged with `sessionId`, `repoId`, `coNumber`, and `stage`, so
you can follow one session's entire clone → codegen → build → test → push lifecycle:

```
grep '"sessionId":42' logs/worker.log
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

## Model / NIM issues

**A clarification question, codegen turn, or doc generation comes back garbled (e.g. a
string of `!!!!`), empty, or wildly off-topic.**
Check `MODEL` in `.env` — `moonshotai/kimi-k3` has a known intermittent bug along these
lines (see the comment in `.env.example`); `google/gemma-4-31b-it` is the current
default specifically to avoid it. Also check that the model actually supports the
`reasoning_content` fallback shape if you switch models — see
[apex_nim_integration.md](apex_nim_integration.md#request-response-handling).

**A model call fails outright with an "NVIDIA NIM returned HTTP ..." or "no usable
content" error after what looks like a delay.**
That delay is the retry budget — 3 attempts with exponential backoff — already having
run and exhausted itself. Check `NVIDIA_API_KEY` and `NVIDIA_BASE_URL` are correct and
that the NIM endpoint is reachable from wherever the call originated (`apex-app` for
clarification/overlap, `apex-worker` for codegen, `apex-spec-doc-worker` for the
Spec/Communication Protocol doc — each needs outbound network access at the time of the
call; note codegen's network is only open during that stage, before build/test seals
it).

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

## Spec/Communication Protocol doc not updating

This doc regenerates via `apex-spec-doc-worker`, a one-shot script run nightly by
cron (`make spec-doc-worker`; see ROADMAP.md Phase 15), completely decoupled from
`apex-worker`'s AI-pipeline queue. If it looks stale:

1. Confirm the nightly cron invocation of `make spec-doc-worker` is actually
   configured and ran (check the host crontab/systemd timer/CronJob, whichever
   the deployment target uses) — there's no persistent container to check with
   `docker ps` anymore.
2. Check `repos.spec_doc_synced_commit_sha` against the repo's actual default-branch
   HEAD on GitHub — the scan only enqueues a job when these differ.
3. Check `spec_doc_jobs` for a `failed` row for that repo, and
   `logs/spec-doc-worker.log` for the error (each job failure is logged independently;
   one repo's failure doesn't block others draining from the same queue).

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
| `MODEL_MAX_TOKENS` | `max_tokens` sent on every NIM request. |

For Docker/Podman architecture questions (why the worker needs the host socket, why
sandbox containers aren't bind-mounted, what runs where), see
[docs/docker-usage.md](docs/docker-usage.md).
