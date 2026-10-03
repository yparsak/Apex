# Apex — Technical Specification

This document describes how Apex is built: its processes, data model, and the
end-to-end lifecycle of a Change Order (CO) as it moves through the system. It
assumes the reader is an engineer working on or integrating with Apex.

For the "what and why," see [README.md](README.md). For the full build history and
every design decision behind what's described here, see [ROADMAP.md](ROADMAP.md) —
this document summarizes the current state; ROADMAP.md explains how it got that way
and what's still undecided (also tracked in [undecided_topics.md](undecided_topics.md)).

For NIM model-call details (prompts, file-selection rules, token/size limits), see
[apex_nim_integration.md](apex_nim_integration.md). For operational troubleshooting,
see [apex_troubleshooting.md](apex_troubleshooting.md).

## Scope boundary

Apex produces exactly one artifact: a commit pushed to a `dev/**` branch. It never
opens a pull request and never merges. Everything after the DEV branch — code review,
promotion to a TEST branch, the PR, the merge to `main` — is a human-driven process
that already existed before Apex and that Apex does not touch. This boundary is
deliberate (see [docs/human-judgment-reliance.md](docs/human-judgment-reliance.md))
and shapes several design decisions below (no merge scope on the GitHub App, approval
gates that are never "locked in," overlap detection that only ever pauses for a human).

## Processes

Apex is three independent Node.js processes plus a database, each its own container:

| Process | Entry point | Responsibility |
|---|---|---|
| `apex-app` | [app.js](app.js) | Express + EJS web app. Auth, repo/branch browsing, the clarification UI, admin screens, document views. |
| `apex-worker` | [worker.js](worker.js) | Polls `sessions` for `queued` rows, one at a time, and drives each one's full sandboxed pipeline (clone → codegen → build → test → push) via [pipelineRunner.js](app/lib/pipeline/pipelineRunner.js). |
| `apex-spec-doc-worker` | [specDocWorker.js](specDocWorker.js) | On its own interval (`SPEC_DOC_SCAN_INTERVAL_MS`), scans every repo for a moved trunk and regenerates its Spec/Communication Protocol doc. Decoupled from `apex-worker` so a backlog of AI sessions never delays doc regen, or vice versa. |
| `apex-mariadb` | — | MariaDB 11. The only shared state between the three processes above — there's no Redis, no message queue. Locks, job queues, and session state all live in ordinary tables (see [db/schema.sql](db/schema.sql)). |

`apex-app` never touches Docker. Only `apex-worker` creates sandbox containers, and it
does so as a **sibling** on the host's own Docker daemon (Docker-outside-of-Docker) —
`apex-worker` itself runs inside a container, with the host's
`/var/run/docker.sock` bind-mounted in, rather than nesting containers. See
[docs/docker-usage.md](docs/docker-usage.md) for the full Docker story, including why
this is why sandbox containers clone into their own internal filesystem instead of a
bind-mounted host directory.

## Stack

- **Backend:** Node.js + Express, EJS server-rendered views — no client-side framework.
- **Sessions:** `express-session`, backed by a MariaDB-backed store
  (`express-mysql-session`, table `express_sessions` — deliberately not named
  `sessions`, which is Apex's own AI-pipeline-session table).
- **DB:** MariaDB, accessed via `mysql2/promise` ([app/lib/db.js](app/lib/db.js)). No
  ORM. `db/schema.sql` is the entire migration history — there are no incremental
  migration files; schema changes after a table's initial creation are idempotent
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` / `MODIFY COLUMN` statements appended to
  the same file (see the comments throughout `schema.sql` for which phase added what).
- **Auth:** username/password, `bcryptjs`, behind an `authProvider` interface
  ([app/lib/auth/authProvider.js](app/lib/auth/authProvider.js)) whose only concrete
  implementation today is `localAuthProvider.js` — SSO is a documented future seam, not
  built.
- **Sandbox:** plain Docker containers (or Podman via `RUNTIME=podman`), driven by
  shelling out to the CLI ([dockerRunner.js](app/lib/docker/dockerRunner.js)), not an
  SDK client.
- **Model backend:** a pluggable adapter
  ([app/lib/model/modelAdapter.js](app/lib/model/modelAdapter.js)) with one
  implementation, NVIDIA NIM. See
  [apex_nim_integration.md](apex_nim_integration.md) for the full contract.
- **Logging:** `pino`, structured, per-process
  ([app/lib/logger.js](app/lib/logger.js)) — see Observability below.
- **Deployment target:** not decided. Everything above runs today as long-lived
  Docker/Podman containers launched from the `Makefile`, on a single host.

## Data model

Full DDL in [db/schema.sql](db/schema.sql). Grouped by concern:

**Identity & access**
- `users` — username/password hash/initials (used in branch naming)/`is_admin`.
- `orgs` → `repo_groups` → `repos` — a repo's `org.name` doubles as its literal GitHub
  owner login (`owner/repo` = `${org.name}/${repo.name}`); there's no separate "GitHub
  org" field.
- `user_repo_group_permissions` — the entire authorization model: access is granted per
  `(user, repo_group)`, not per-repo and not per-action. Any permitted user can create
  branches, run pipelines, and manage branch lifecycle for every repo in that group.

**Change orders & branches**
- `change_orders` — one row per `(repo, co_number)`, created on first use.
- `branches` — `dev/{initials}-{co_number}-{increment}`. `increment` is scoped to
  `(initials, co_number)` only, **not** `repo_id` — a user's first branch on any CO is
  always `-1`, independent of other users and of which repo they're in.
  `status` is `active` / `stale` / `deleted`; `deleted` is a one-way door from the UI
  (row kept for history), reached either automatically (GitHub confirms the branch is
  gone) or by explicit user delete — both converge on the same `markDeleted()` call.

**Sessions & the clarification loop**
- `sessions` — one AI-pipeline attempt per branch at a time (`branch_id`, `user_id`,
  `status`: `awaiting_approval` → `queued` → `running` → `completed`/`failed`).
  `resume_requested` disambiguates, for `apex-worker`, whether a `queued` row should be
  picked up via `pipelineRunner.run()` (fresh/full retry) or `.resume()`
  (continue-from-failed-step).
- `session_requirements` — one row per clarified-and-finalized requirement.
  `confirm_status`: `pending_confirm` (overlap detected, awaiting human call) /
  `confirmed_proceed` / `confirmed_skip`. Only `confirmed_proceed` rows are ever sent to
  codegen or counted as "already implemented" by future overlap checks.
- `conversations` — the raw clarification chat transcript (`user`/`assistant` turns).
  Mid-turn `FETCH_FILE` round-trips are resolved inline and never stored here.

**Pipeline execution**
- `pipeline_locks` — one row per `(repo_id, co_number)`; its existence *is* the lock.
  Acquired at branch-creation/continue time, held for the session's entire lifetime
  (clone through push), released only on success. A failed session keeps the lock —
  it's still retryable/resumable by its own owner.
- `pipeline_runs` — one row per attempt. `stage` (`cloning`/`codegen`/`building`/
  `testing`/`pushing`) is updated live for the UI's progress stepper and persisted even
  on failure. `container_id` points at a failed attempt's kept-alive sandbox (cleared on
  success); `resume_attempt_count` caps continue-from-failed-step retries at 3.
  `build_log`/`test_log`/`commit_sha`/`error_message` are the full record of what
  happened.
- `repo_clarification_instructions` — one admin-authored free-text row per repo (capped
  6,000 chars), injected as authoritative guidance into every clarification/codegen
  call for that repo. Deliberately separate from `repo_documents` (below): this table
  is admin input nothing automated may overwrite.

**Delivery documents**
- `repo_documents` — `(repo_id, doc_type, co_number)`, where `doc_type` is
  `requirements_log` (cumulative, one `## CO <n>` section per CO, updated synchronously
  whenever a session completes) or `spec_communication_protocol` (whole-repo summary,
  fully regenerated on a trunk-staleness cadence). Both doc types always use the
  `co_number=''` sentinel in practice — the column stays for schema generality.
- `spec_doc_jobs` — the queue `specDocWorker.js` drains; one `queued` row per repo whose
  trunk has moved since `repos.spec_doc_synced_commit_sha`.

**Observability & admin**
- `audit_log` — user-facing actions (clarification messages, approvals, branch
  lifecycle changes, pipeline outcomes).
- `admin_audit_log` — admin-only mutations (user/org/repo CRUD, permission grants,
  force-unlock), kept separate from `audit_log` by convention.
- `blocked_allowlist_alerts` — a recorded 403 from either `createBranchRef` (clean HTTP
  status) or a push (text-heuristic match on git's stderr) — surfaced on `/admin/alerts`.
- `lock_contention_events` — every time a second user's lock-acquire attempt lost to an
  existing holder — surfaced alongside live locks on `/admin/locks`.

## Lifecycle of a Change Order

1. **Repo/branch selection.** An engineer with `user_repo_group_permissions` on a
   repo's group picks a repo, enters a CO number (validated against `^C[0-9]{8}$` —
   shape only; Apex has no connection to the actual change-control system), and either
   starts a new branch (`dev/{initials}-{CO}-{n}` off the repo's `default_branch_name`)
   or continues an existing active one. Either path acquires the `pipeline_locks` row
   for `(repo_id, co_number)` via `findOrCreateSession` + `acquireLock` — only one AI
   session can be in flight per repo+CO at a time, across all users.

2. **Clarification.** The engineer converses with the model
   ([clarificationService.js](app/lib/clarificationService.js)), grounded in the repo's
   file tree and any admin-authored clarification instructions. The model asks
   questions, requests specific files on demand, and eventually emits
   `FINALIZE_REQUIREMENT:` once it judges a requirement fully specified. Finalizing
   triggers overlap detection
   ([overlapService.js](app/lib/overlapService.js)): the model is shown this branch's
   diff against the default branch plus every already-confirmed requirement, and asked
   whether the new one duplicates existing work. A detected overlap sets
   `pending_confirm` on the new requirement and **never auto-skips** — the submitting
   user must explicitly confirm or override it before it proceeds.

3. **Approval.** Once every requirement has resolved out of `pending_confirm` and at
   least one is `confirmed_proceed`, the session becomes eligible for an explicit
   "Approve & Implement" action, flipping it to `queued` for `apex-worker` to pick up.
   This approval is never permanent: finalizing a *new* requirement while the session is
   still `queued` (not yet picked up) automatically reverts it to `awaiting_approval` —
   scope can't silently expand under an old click.

4. **Sandboxed execution**
   ([pipelineRunner.js](app/lib/pipeline/pipelineRunner.js)), once `apex-worker` polls
   the `queued` row:
   - **Clone** — a fresh container from the repo's own declared `apex.pipeline.json`
     image (never a default — a missing/malformed config fails loudly before any
     container exists), cloned using a `contents: read`-only GitHub App token that
     never leaves the sandbox.
   - **Codegen** — the model turns the session's confirmed requirements into file
     writes inside the container (see
     [apex_nim_integration.md](apex_nim_integration.md) for exactly how). The container
     is committed to (`git commit`) while network is still open.
   - **Seal** — the sandbox's network is disconnected before build/test. No
     registry egress from this point on; repos must vendor/cache all build/test
     dependencies.
   - **Build / Test** — the repo's own declared commands, run via `docker exec` inside
     the sealed container.
   - **Push** — the only step that uses the full-permission (write-capable) GitHub App
     token, and the only step that runs on the host, not in the sandbox: the
     container's already-committed tree is pulled out with `docker cp`, and the host
     pushes it with plain `git`. Non-fast-forward pushes are resolved with
     fetch-then-merge and retried (never force-pushed — another engineer may be
     pushing to the same DEV branch directly); a real conflict surfaces as a loud
     failure.
   - On success: the requirements log is updated inline, the lock is released, and the
     container is removed. On failure: the container is **kept alive** (not torn down)
     and the lock stays held, so the session can be retried or resumed later.

5. **Retry / Resume.** A failed session offers two recovery paths: a full retry
   (abandons the kept-alive container, re-runs clone → codegen → build → test → push
   from scratch) and — while the failed run's container is still alive and under 3
   resume attempts — a resume that reuses the kept-alive container and whatever the
   last successful step already produced (e.g. a push failure resumes straight into
   push, reusing the already-built/tested commit). Exhausting 3 resume attempts tears
   down the container and falls back to full retry only.

6. **Delivery.** The requirements log (cumulative, per-CO) is the durable record of
   what Apex implemented and when; it's updated synchronously on every successful
   session. The Spec/Communication Protocol doc is a separate, whole-repo summary,
   regenerated from scratch by `apex-spec-doc-worker` whenever trunk moves — unrelated
   to any specific CO, and never blocked by (or blocking) the AI-pipeline queue.

7. **Branch lifecycle.** Branches can be explicitly deactivated (Active → Stale) or
   deleted (soft delete — row kept, just hidden from the UI) by any user with access to
   the repo group, not just the branch's creator. Both are blocked while a non-terminal
   session holds that branch's pipeline lock. Reactivating a Stale branch re-checks
   GitHub existence first; a confirmed-gone branch is marked `deleted` instead of
   reactivated.

## Security model

- **GitHub access** is entirely via a GitHub App installation, never a personal token.
  The App has `contents: write` only (no `pull_requests`, no admin/merge scopes),
  restricted to `dev/**` by a repository ruleset — Apex is structurally incapable of
  opening or merging a PR, independent of any application-level check. Installation
  tokens are minted on demand ([githubAppAuth.js](app/lib/github/githubAppAuth.js)),
  cached in memory only, and never persisted. A second, narrower `contents: read`
  token is minted from the same App for the one place a GitHub credential enters the
  untrusted sandbox (the clone step) — the write-capable token stays on the host.
- **Auth** is local username/password (bcrypt) behind the `authProvider` seam.
  Sessions are server-side (MariaDB-backed), 8-hour cookie lifetime.
- **Authorization** is coarse and explicit: `user_repo_group_permissions` is the only
  gate, checked on every repo-scoped route via
  [repoAccess.js](app/lib/repoAccess.js). There is no per-action or per-branch
  ownership restriction except where called out above (retry/resume are scoped to a
  session's own `(branch_id, user_id)`; branch lifecycle actions are not).
- **Sandbox isolation**: no network during build/test, no bind-mounted host paths for
  sandboxed code, and the sandbox never sees the write-capable push token. A failing
  build/test command cannot exfiltrate anything beyond the container itself.

## Observability

- **Structured logs** (pino): one logger per process name (`app`/`worker`/
  `spec-doc-worker`), each writing to stdout (so `docker logs`/`podman logs` keep
  working) *and* a rotated file under `logs/<name>.log` (`pino-roll`, size + daily
  rotation), purged past `LOG_RETENTION_DAYS` (default 3) by an hourly sweep running
  inside each process. Independent of Docker's own `--log-opt max-size/max-file`
  container-log rotation. Pipeline log lines carry `sessionId`/`repoId`/`coNumber`/
  `stage` so a session's full lifecycle is greppable by id.
- **Admin dashboards** (`/admin/alerts`, `/admin/locks`), backed by real queried
  endpoints under `/api/admin/*` using the same `requireAdmin` middleware as the rest
  of the admin surface — not write-only tables.
- **Build/test output** for a specific pipeline run lives in `pipeline_runs.build_log`/
  `test_log` in the database, surfaced on the branch/session view — not in any
  container or process log.

## What's deliberately not built yet

See [ROADMAP.md](ROADMAP.md)'s "Open / future" section and
[undecided_topics.md](undecided_topics.md) for the full, current list (deployment
target, non-NIM model provider, SSO, usage/cost reporting, etc.). Those are tracked
there rather than duplicated here so there's a single source of truth.
