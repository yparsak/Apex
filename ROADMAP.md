   # Apex — Build Roadmap

This is the forward build plan for Apex, derived from the target spec in
[notes.md](notes.md). `notes.md` describes a system whose Phases 0–7 were already
implemented and merged elsewhere; in this repo we're building it from scratch, in a
resequenced order chosen for testability, folding in fixes/reworks that notes.md
records as happening *after* the fact (model adapter hardening, delivery-doc redesign,
User Maintenance UI) so we don't build a known-throwaway version first.

## Stack decisions

- **Backend:** Node.js + Express, EJS views.
- **Sessions:** `express-session`, backed by a MariaDB-backed session store (no Redis).
- **DB:** MariaDB.
- **Auth:** username/password, bcrypt, behind an `authProvider` interface
  (`app/lib/auth/`) so SSO can be added later without touching call sites.
- **Sandbox:** plain Docker containers, fully network-isolated (`--network=none`).
- **Model backend:** pluggable adapter (`app/lib/model/modelAdapter.js`); first
  implementation is NVIDIA NIM (`moonshotai/kimi-k3`).
- **Deployment target:** not decided — out of scope for this roadmap.

## Testing philosophy

From Phase 2 onward, every later phase should be testable by logging into the app and
clicking through the UI — no seed scripts, no raw SQL, no curl against internal APIs.
Phase 2 exists specifically to make that true as early as possible.

## Phase 1 — Foundations

- Full data model migrated up front (not incrementally per phase): `users`, `orgs`,
  `repo_groups`, `repos`, `user_repo_group_permissions`, `change_orders`, `branches`,
  `sessions`, `session_requirements`, `conversations`, `audit_log`, `pipeline_locks`,
  `pipeline_runs`, `admin_audit_log`, `blocked_allowlist_alerts`,
  `lock_contention_events`, `repo_documents`, `spec_doc_jobs`.
- Username/password auth: bcrypt hashing, `express-session` with a MariaDB-backed
  store, behind the `authProvider` interface.
- Top nav shell: app title + Login/Logout. Sidebar exists but stays empty until Phase 4
  populates it.
- `Makefile setup` target + a setup doc, done now while the stack is still simple.

## Phase 2 — Admin UI (pulled forward, expanded beyond notes.md's original scope)

notes.md never describes a UI for creating `orgs`/`repo_groups`/`repos` — only for
granting permissions on them. We're adding that here so nothing in the system requires
DB seeding at any point.

- Org / repo_group / repo CRUD screens.
- User Maintenance: create/manage users (notes.md originally shipped this *after*
  Phase 7; built here from the start instead).
- Permissions admin: grant/revoke `user_repo_group_permissions`.
- Initials admin: edit user `initials` (used in branch naming).
- Every mutation audit-logged to `admin_audit_log`.

**Effect:** from this point on, every later phase is testable end-to-end through the
browser.

## Phase 3 — Platform integrations

- GitHub App token-minting service: short-lived installation tokens, minted on demand,
  never persisted. Real GitHub App credentials — App registered manually in GitHub org
  settings (owner: Yucel), `contents: write` only, scoped to `dev/**` via a repository
  ruleset, no `pull_requests` scope, no merge capability.
- Model adapter interface, with NVIDIA NIM as the first concrete implementation, built
  against real NIM API access.
- **Built hardened from the start** — no separate later "reliability fix" phase:
  - Retry budget covers transport-level failures (network errors, non-2xx status) the
    same way it covers content-level failures (blank/degenerate replies) — a transport
    failure doesn't throw immediately and skip the retry budget the content case gets.
  - Falls back to a `reasoning_content` field when the model returns that instead of
    `content`.
  - `MODEL_MAX_TOKENS` configurable via env.
  - Malformed/truncated responses fail loudly with an accurate error (never surfaced as
    a misleading "no usable content" message when the real cause was a transport
    failure) and never hit MariaDB's `NOT NULL` constraint or crash the fenced-block
    parser unhandled.

## Phase 4 — Repo/branch selection

- Sidebar/tabs layout populated: repo groups as tabs, repo list per group with
  description, collaborators, last-updated.
- Select a repo → active-branch list (on-demand GitHub existence check marks missing
  branches `deleted`, excluded from the list).
- CO format validation (`^C[0-9]{8}$`).
- New-branch-from-`main`, using each repo's `default_branch_name`. Branch naming:
  `dev/{initials}-{CO}-{n}`, increment scoped to `(initials, co_number)` — a user's
  first branch on any CO is always `-1`, independent of other users.
- Pipeline lock acquisition: one AI session at a time per `(repo_id, co_number)`,
  covering the full pipeline (clone → sandbox build/test → push), not just the push.

**Implementation notes (decisions made while building this phase):**
- `orgs.name` is used as the literal GitHub owner/org login for API calls
  (`owner/repo` = `${org.name}/${repo.name}`) — there's no separate "GitHub org" field,
  consistent with the one-org-wide-installation model from Phase 3.
- Collaborators and last-updated aren't stored anywhere — both are fetched live from
  GitHub on every dashboard render (`app/lib/github/repoEnrichment.js`) and degrade to
  `—` on any failure (missing creds, or this App's `contents:write`-only scope lacking
  permission for the collaborators endpoint), rather than breaking the page.
- `pipeline_locks.session_id` is a required FK, so lock acquisition needed a `sessions`
  row to already exist — creating/continuing a branch now calls a shared
  `findOrCreateSession` (`app/lib/sessionService.js`) before `acquireLock`
  (`app/lib/lockService.js`). The lock is **not released** in this phase — there's no
  pipeline run yet to complete or fail; release is a later-phase (worker) concern.

## Phase 5 — Clarification loop

- LLM-driven Q&A against repo context, written to `audit_log`.
- Context retrieval: targeted fetch — GitHub tree listing first, LLM requests specific
  file contents by path as needed. Scales to large repos instead of bulk-fetching a
  fixed set of files upfront.
- Overlap detection: diff the DEV branch against `main`, feed the diff plus past
  requirements text to the LLM to check new requirements against already-implemented
  work.
- Detected overlap sets `session_requirements.pending_confirm`
  (`overlap_flag_requirement_id`), pausing until the submitting user confirms or
  overrides — never auto-skip.

## Phase 6 — Repo clarification instructions

- Admin-maintained, per-repo instructions doc (`repo_clarification_instructions`, one
  row per `repo_id`) — free-text guidance (conventions, boundaries, what's off-limits)
  that applies to every branch and CO on that repo, not scoped to any one session.
- Deliberately a separate table from `repo_documents`: that table holds Apex-generated
  output (requirements log, spec doc) that automated jobs are allowed to overwrite; this
  is admin-authored input that must never be touched by anything but the admin who wrote
  it.
- Admin CRUD (create/update/delete), alongside the existing Orgs/Repo Groups/Repos/
  Permissions screens from Phase 2, gated by `requireAdmin`; every mutation written to
  `admin_audit_log` like the rest of that admin surface.
- Capped at 6,000 characters, enforced at save time with a rejected-and-explained error
  — never silently truncated. It's re-sent in full on every clarification turn (see
  Phase 5), so an unbounded doc would compete for context against the file tree, the
  growing conversation history, and any `FETCH_FILE`-fetched file contents.
- Injected into `clarificationService.js`'s system prompt on every turn, labeled as
  authoritative admin guidance — distinct from the file-tree/`FETCH_FILE` path a repo's
  actual files go through. Not fed into `overlapService.js`'s overlap check, which stays
  scoped to the diff plus prior requirements text.

## Phase 7 — Sandboxed execution

- Ephemeral Docker container per session, driven by each repo's declarative
  `apex.pipeline.json` (`buildCommand`/`testCommand`/`image`) — the runner never
  invents a default command.
- Pipeline steps, in order: **clone → codegen → build → test → push.**
- Network policy is a per-step toggle, not a fixed container property: open only
  during the codegen step (so the model adapter can reach NIM), sealed
  (`--network=none`) before build/test runs. Repos still must vendor/cache all
  dependencies — no registry egress (npm/PyPI/Maven/etc.) once network is sealed.
- Clone uses a scoped, clone-only token *inside* the sandbox; the write-capable push
  token stays outside and is used only by the host process after build/test succeed.
- Fetch-and-retry (never force-push) against current remote state on non-fast-forward,
  or fail loudly — engineers may push directly to the same DEV branch.
- Branch-existence re-check at session start.
- `worker.js` polls `sessions` for `queued` rows and runs the pipeline async, decoupled
  from the browser session; completion surfaces next time the user views that repo's
  branch list.
- **Container lifecycle on failure:** a container that fails is *not* torn down
  immediately — it's kept alive (see Phase 9's resume-from-step retry) until the
  session either succeeds, exhausts its resume-attempt limit, or is explicitly
  abandoned. Only then is it destroyed. (Idle/abandoned-but-never-retried containers
  still need an eventual timeout-based cleanup; not decided yet — flagged under
  Open/future.)

**Implementation notes (decisions made while building this phase):**
- **Clone-only token**, concretely: rather than a second GitHub App, `githubAppAuth.js`
  now mints and caches installation tokens per named scope. The default (full
  `contents: write`) token is unchanged; a second, `contents: read`-scoped token is
  minted via the same installation-token endpoint's `permissions` field, which GitHub
  allows to narrow (never widen) the App's own granted permissions.
- **Codegen runs against GitHub reads, not container reads**, because the container's
  cloned tree and the branch tip are identical at clone time: `FETCH_FILE` during
  codegen is served from GitHub, layered under an in-memory map of this session's own
  not-yet-committed writes (so re-fetching a path you already wrote sees your edit, not
  the stale GitHub copy). Only `WRITE_FILE` touches the container, via `docker exec`.
- **Push happens via real git, not the Contents API**: after test passes, the
  container's already-committed working tree (`git commit` runs inside the container
  right after codegen, while network is still open, before sealing) is pulled out with
  `docker cp` into a host temp dir, and the host pushes it with plain `git` — this is
  the only step that touches the write-capable token. This needed `git` on the worker's
  own image too, not just inside sandboxes.
- **Single-process, sequential worker**: `worker.js` polls for one `queued` session at
  a time and runs it to completion before polling again, rather than processing
  multiple sessions concurrently. Nothing in this phase needs more; scaling this is an
  open concern only if a real backlog shows up in practice.
- **`apex.pipeline.json`'s `image` is assumed to include `git`** (true of official
  non-`slim`/non-`alpine` language images, which are built on `buildpack-deps`). If a
  repo declares a minimal image without `git`, the clone step fails loudly with that
  image's own "command not found" error — consistent with "never invent a default,"
  extended here to environment tooling, not just build/test commands.
- **Schema**: `pipeline_runs` gained `container_id` (the kept-alive-on-failure
  container, cleared on success) and `error_message` (a step failure that isn't a
  build/test log — e.g. a missing `apex.pipeline.json` or a deleted branch). Since
  `schema.sql` has no incremental migration files and `pipeline_runs` already existed
  before this phase, these two are added via an idempotent `ALTER TABLE ... ADD COLUMN
  IF NOT EXISTS` rather than just the `CREATE TABLE IF NOT EXISTS` used for wholly new
  tables.
- **Docker-outside-of-Docker for the worker**: `worker.js` itself runs inside a
  container (per this project's Makefile-driven dev setup), so its sandbox containers
  are created as *siblings* on the host's Docker daemon via a bind-mounted
  `/var/run/docker.sock`, not nested inside the worker's own container. This is also
  why the sandbox clones into the container's own internal filesystem rather than a
  bind-mounted host directory — a host-path bind mount specified from inside the worker
  container wouldn't resolve correctly against the host daemon.
- **The full "Approve & Implement" human gate is Phase 8 scope**, but Phase 7 still
  needs *some* way to get a session into `queued` for `worker.js` to pick up (testing
  philosophy: every phase from Phase 2 onward is clickable end-to-end). A minimal
  "Run pipeline" button stands in for it now — eligible once every requirement has
  resolved out of `pending_confirm` and at least one is confirmed to proceed — and
  Phase 8 replaces/extends it with the real gate (re-opening on new instructions, etc.).

## Phase 8 — DEV branch delivery

- Combined commit to the DEV branch is code-only — no doc files committed (see below).
- `repo_documents`: DB-stored requirements log (cumulative per repo, one heading per
  CO) and Spec/Communication Protocol doc, one row per `(repo, doc_type, co_number)`,
  `co_number=''` as the sentinel for the repo-level case. Built this way from the
  start — notes.md's original file-in-branch design was reworked into this after the
  fact, so we skip straight to the corrected version.
- Documents UI: per-repo view plus a global, CO-scoped cross-repo search ("every
  delivery doc for this CO, across every repo I can access").
- Spec/Communication Protocol doc regeneration is decoupled from `worker.js`'s
  AI-pipeline poll loop: `specDocScanService.js` (trunk-staleness check) and
  `specDocService.js` (generation) are triggered by a separate, cron-scheduled script
  — not drained inline by `worker.js` — that scans for staleness and drains whatever
  lands in `spec_doc_jobs` each run. This bounds doc freshness to the cron interval
  rather than to `worker.js`'s session-processing cadence, so a backlog of queued AI
  sessions can't delay doc regeneration, or vice versa. Exact interval TBD at
  implementation time (see Open/future).
  Requirements log generation is unaffected by this: it stays synchronous, per-CO,
  updated inline when a session completes — no queue, no cron.
- **Approve & Implement** human gate: a session becomes eligible for worker pickup only
  after this explicit click. Offered once every submitted requirement has resolved out
  of `pending_confirm`. New instructions or a fresh overlap check reopening a
  requirement drops the session back out of `queued`/approved automatically — approval
  is never "locked in."
- Retry-on-failure: re-queues the *same* session row (conditional
  `UPDATE ... WHERE status = 'failed'`) as a full from-scratch re-run (codegen, sandbox
  build/test, push) — nothing from the failed `pipeline_runs` row is reused.

**Implementation notes (decisions made while building this phase):**
- **Requirements log format**: stored as one `repo_documents` row per repo
  (`co_number=''`), with `## CO <number>` headings parsed/rendered by a small shared
  module (`requirementsLogFormat.js`) rather than a heavier Markdown/AST dependency.
  `requirementsLogService.js` finds-or-creates the section for a completing session's
  CO and appends a dated, session-attributed entry — genuinely cumulative, never
  overwritten. The Spec/Communication Protocol doc also uses `co_number=''` but is
  never CO-scoped by nature (it summarizes the whole trunk), so in practice both doc
  types always write that sentinel; the column stays for the schema's original
  generality rather than because either doc type varies it today.
- **CO-scoped cross-repo search is a content search, not a `WHERE co_number = ?`
  query** — since storage is repo-level, `documentsService.js` loads each accessible
  repo's requirements log and extracts the matching `## CO` section in application
  code, reusing `requirementsLogFormat.js`'s parser. It only searches the requirements
  log; the Spec/Communication Protocol doc is browsable on each repo's own Documents
  page instead, since it has no CO to search by.
- **`specDocWorker.js` is a plain Node interval loop**, not host cron/systemd — the
  exact mechanism was explicitly left open pending a deployment target (still
  undecided), and an interval loop is the simplest thing that's actually runnable in
  this Makefile-driven dev setup today. `SPEC_DOC_SCAN_INTERVAL_MS` controls the
  cadence. The Spec/Communication Protocol doc is fully regenerated on every run
  (not incrementally patched like the requirements log) — "regenerated" is taken
  literally, which also means it doesn't need to parse or preserve its own prior
  structure.
- **Approval reset lives in `clarificationService.js`, not the route layer**: the
  moment `finalizeRequirement` inserts a new `session_requirements` row — confirmed
  outright or `pending_confirm` via overlap — it checks whether the session is
  currently `queued` and, if so, reverts it to `awaiting_approval` with
  `approved_at = NULL` (audit-logged as `approval_reset`). This only fires for
  `queued` (not yet picked up by `worker.js`); a `running` session is too late to
  un-approve, consistent with the roadmap only calling out `queued`/approved as
  reversible.
- **The clarification form now stays open through `queued`**, not just
  `awaiting_approval` (Phase 7 hid it once a session left `awaiting_approval`) — since
  adding a requirement while queued is exactly the scenario that should pull a session
  back into review. It's still hidden once `running`/`completed`/`failed`. The
  `/messages` route enforces this server-side too, not just in the view — Phase 7's
  version had no session-status guard at all, which would have let a message land
  during or after a pipeline run.
- **Retry abandons the failed attempt's kept-alive container** rather than leaving it
  orphaned: `pipelineRunner.js` now removes any of a session's prior
  `pipeline_runs.container_id` values (and nulls the column) at the very start of
  `run()`, before doing anything else. This only ever runs inside `worker.js` (the
  process with Docker socket access), not the web route that flips status to
  `queued` — the route itself never touches Docker directly, consistent with Phase 7's
  Docker-outside-of-Docker setup.
- No schema changes were needed this phase — `repo_documents`, `spec_doc_jobs`,
  `sessions.approved_at`, and `repos.spec_doc_synced_commit_sha` were all already part
  of Phase 1's upfront migration.

## Phase 9 — Session progress indicator

Not in notes.md's original scope; added because a coarse `sessions.status` enum makes
it hard to tell where a session actually is or which step an error happened in. Placed
here because it's the first point every state/sub-state it needs to display actually
exists (clarifying from Phase 5; approval/queued/running/completed/failed from Phase
8).

- Schema addition: `pipeline_runs.stage` (`cloning`/`codegen`/`building`/`testing`/
  `pushing`), updated by `worker.js` as it progresses through each step and persisted
  with the row — so even a failed run permanently records exactly where it died, not
  just the live session's current state.
- Top-level stepper (branch/session view): Branch created → Clarifying → Awaiting
  approval → Queued → Running → Completed/Failed, driven by `sessions.status` (plus
  `session_requirements.pending_confirm` to distinguish "clarifying" sub-state).
- Sub-stepper: when status is `running` or `failed`, expands to show clone → codegen →
  build → test → push using the latest `pipeline_runs.stage`, so a failure is
  traceable to the exact step without opening the build/test log first.
- **Retry, resuming from the failed step** (not the from-scratch retry Phase 8
  already has — this is new behavior, surfaced directly on the sub-stepper next to the
  failed step):
  - Reuses the kept-alive container (see Phase 7) and whatever the last successfully
    completed step produced — e.g. if push failed, retry re-attempts only the push,
    reusing the already-built/tested commit; codegen/build/test are not redone.
  - `pipeline_runs.resume_attempt_count`, capped at **3**. Each resume-from-step click
    increments it.
  - On exhausting 3 resume attempts at the same step, the kept-alive container is torn
    down and the resume option is disabled — the session falls back to Phase 8's
    existing full-session retry (fresh container, full from-scratch re-run) rather
    than dead-ending the user.
  - Not yet decided: whether a resumed attempt re-validates that the DEV branch head
    hasn't moved since the last successful step (another engineer could have pushed
    directly to the same branch in between) before trusting the cached state, or skips
    that check for simplicity. Flagged under Open/future — revisit before building
    this if it matters in practice.

**Implementation notes (decisions made while building this phase):**
- **`pipeline_runs.stage`/`resume_attempt_count` needed no schema work** - both were
  already part of Phase 1's upfront migration, and `stage` was already being written by
  `pipelineRunner.js` since Phase 7. The only new column this phase needed was
  `sessions.resume_requested` (idempotent `ALTER ... ADD COLUMN IF NOT EXISTS`, same
  pattern as Phase 7/8's additions to `pipeline_runs`) - see below for why.
- **`resume_requested` disambiguates two routes that both just leave a session
  `queued`**: Phase 8's full-retry (`/retry`) and this phase's resume-from-step
  (`/resume`) both set `sessions.status = 'queued'`, since that's what `worker.js`
  polls for. `resume_requested` is the only signal it has for which of
  `pipelineRunner.run()` / `.resume()` to call; both entry points clear the flag the
  moment they pick the session up, so it can never leak into a later, unrelated queue.
- **`pipelineRunner.js` was refactored into per-step functions** (`cloneStep`,
  `codegenStep`, `buildStep`, `testStep`, `finishSuccessfully`) shared by `run()` and
  the new `resume()`, rather than duplicating the clone/build/test/push exec calls in a
  second function. `resume()` dispatches on the failed run's stored `stage` and calls
  only the steps from there onward.
- **`resume_attempt_count` is one flat counter per `pipeline_runs` row, not
  per-step** - the schema has a single column, not one per stage, so "capped at 3" is
  implemented as 3 resume attempts total for that failed run, regardless of whether a
  later attempt fails at a different (later) step than the one before it. A stricter
  per-step reset would need a second column to track "which step is this count for,"
  which the roadmap doesn't call for explicitly.
- **Resuming into codegen resets the working tree first**: `git checkout -- .` +
  `git clean -fd` run inside the container before `codegenStep` is called again. This
  discards any partial `WRITE_FILE`s the earlier failed attempt left behind. Without
  it, a resumed codegen run's `FETCH_FILE` (which starts with an empty in-memory write
  map every call - see `codegenService.js`) would read stale GitHub content for a path
  the failed attempt had already modified in the container, instead of the container's
  actual current file.
- **Branch-head staleness re-validation on resume was left unbuilt**, per the "Not yet
  decided" note above - `resume()` doesn't re-check whether another engineer pushed to
  the branch between the original failure and the resume click. This is the default
  the roadmap describes ("skips that check for simplicity"), not an oversight.
- **Stepper view-model lives in its own module** (`app/lib/pipelineStepper.js`), pure
  computation with no DB/HTTP access, so the step-derivation rules (which
  `sessions.status`/`pending_confirm`/`pipeline_runs.stage` combination maps to which
  visual state) are easy to read and change in one place independent of the route
  handler that fetches the data.

## Phase 10 — Observability & hardening

- Blocked-allowlist alerts: `blocked_allowlist_alerts` table +
  `GET /api/admin/alerts`, a real queried surface, not write-only. "403 means allowlist
  block" is a heuristic, not a guarantee — GitHub returns 403 for both an App-permission
  violation and a `dev/**` ruleset rejection; a 422/409 non-fast-forward push is a
  separate, already-handled retry case and never lands here.
- Lock-contention dashboard: `lock_contention_events` table +
  `GET /api/admin/locks`, `/api/admin/lock-contention`.
- `docs/github-app-key-rotation.md` and `docs/human-judgment-reliance.md`.

**Implementation notes (decisions made while building this phase):**
- **No schema changes** - `blocked_allowlist_alerts` and `lock_contention_events` were
  both already part of Phase 1's upfront migration; `lock_contention_events` was
  already being written to by `lockService.acquireLock` since Phase 4.
  `blocked_allowlist_alerts` was genuinely write-only until now - nothing had ever
  inserted a row - so this phase's actual work was adding the write path, not the
  schema or the read path.
- **Two write paths feed `blocked_allowlist_alerts`**, at different confidence
  levels: `githubApi.createBranchRef` (the only REST write call in that module) now
  attaches the real numeric `httpStatus` to its thrown error, and `branchService.
  createBranch` records an alert when that's exactly 403. `pushService.js`'s `git push`
  can't hand back a clean status code the same way, so it uses a text heuristic
  (`looksLikeAllowlistBlock`) over git's own stderr - `/403/` or a permission/
  protected-branch phrase - to decide whether a push failure belongs here. Both paths
  explicitly exclude the non-fast-forward case, which is a separate, expected,
  already-handled retry condition (see ROADMAP.md Phase 7) that never reaches this
  table regardless of which path it's checked from.
- **`GET /api/admin/alerts` / `/locks` / `/lock-contention` are real, at exactly those
  paths** (`app/routes/apiAdmin.js`, mounted at `/api/admin`), reusing the same
  `requireAdmin` middleware as the rest of the admin surface. The HTML admin pages
  (`/admin/alerts`, `/admin/locks`) don't call these endpoints internally over HTTP -
  they call the same underlying service functions (`blockedAllowlistAlerts.
  listAlerts`, `lockService.listActiveLocks`/`listContentionEvents`) directly, since
  making a self-request for data already available in-process would be pure overhead.
- **`/admin/locks` combines both halves of the "lock-contention dashboard"** language
  into one page - currently-held locks (real-time) and historical contention events
  (append-only) - rather than two separate admin nav items, since they're two views of
  the same underlying concern and the roadmap's two API paths map cleanly onto two
  sections of one page.

## Phase 11 — Self-service passwords, default-password user creation, & admin lock override

Not in notes.md's original scope.

- Self-service password change: a page (reachable by any logged-in user, not just
  admins) where a user updates their own password. Scope this to the user's own account
  only — not a replacement for the existing admin-driven user management screens.
  Added because password management today is entirely admin-driven (admin sets a
  password at user-creation time; there's no path for a user to change their own
  password after the fact).
- `DEFAULT_USER_PASSWORD` env variable (`.env` / `.env.example`). When an admin creates a
  new user:
  - If set, the new user is created with this value as their password (admin no longer
    enters a password on the create-user form for this case).
  - If blank/unset, today's behavior is unchanged — the admin enters a password for the
    new user on the create-user form.
- Admin "force-unlock" action for a stuck `pipeline_locks` row. Today a lock is only
  ever released by `lockService.releaseLock`, called exclusively from a successful
  pipeline completion (see Phase 4/7) — a failed session deliberately keeps the lock
  held so it can still be retried/resumed (see `lockService.js`). But `/retry` and
  `/resume` are scoped to the session's own `(branch_id, user_id)`
  (`loadBranchSession`), so if the original user who started that session is
  unavailable (gone, account disabled, can't be impersonated), nobody — not even an
  admin — has any way to unblock that `(repo_id, co_number)` for a different session.
  Surface this on the existing `/admin/locks` dashboard (Phase 10), which today is
  read-only: an explicit action that deletes the stale `pipeline_locks` row so a new
  session can proceed. Still undecided: whether this also force-marks the orphaned
  session as some terminal/abandoned state (so it stops showing as an actionable
  `failed` session nobody but its original owner can touch), or just removes the lock
  row and leaves the orphaned session as-is.

**Implementation notes (decisions made while building this phase):**
- **Force-unlock takes the simpler of the two undecided options**: it only deletes the
  `pipeline_locks` row (`lockService.forceReleaseLock`, keyed by the lock's own `id`,
  not `(repo_id, co_number, session_id)` like `releaseLock`) and leaves the orphaned
  session's `status` untouched. The session still shows as `failed` and is still only
  actionable by its original owner via `/retry`/`/resume` — this phase only frees the
  lock slot so a *different* session can proceed on that `(repo_id, co_number)`.
- **No schema changes** — `pipeline_locks` already had everything needed; the action is
  a plain `DELETE ... WHERE id = ?` from `POST /admin/locks/:id/force-unlock`,
  audit-logged via the existing `admin_audit_log` path (`action: 'lock.force_unlock'`),
  same as the rest of the admin surface.
- **Self-service password change reuses `authProvider.authenticate`** to verify the
  current password rather than calling `bcrypt.compare` directly — the route already
  has the session's own `username`, so this is the same contract Phase 1's login flow
  uses, just invoked a second time inline before `userService.updatePassword` hashes and
  writes the new one.
- **`DEFAULT_USER_PASSWORD` is read directly from `process.env` in the route handler**,
  not threaded through `userService.createUser` — that function's signature
  (`{ username, password, initials, isAdmin }`) stays exactly as `scripts/createUser.js`
  already calls it; only `app/routes/admin/users.js`'s `POST /` substitutes the env value
  for the form field before calling it, and `admin/users.ejs` hides the password input
  (showing a note instead) whenever it's set. The CLI bootstrap script is unaffected —
  it's always invoked with an explicit `--password`, before any admin user or env
  convention exists to default from.

## Phase 12 — Operational logging: rotation + structured app logs

Not in notes.md's original scope.

- **Docker-level log rotation**, so `docker logs`/`podman logs` for `apex-app`,
  `apex-worker`, and `apex-spec-doc-worker` stop growing unbounded: `--log-opt
  max-size=10m --log-opt max-file=3` added to each container's `run` invocation in the
  Makefile. Zero application code changes; a safety net independent of the structured
  logging work below, not a replacement for it.
- **Structured app-level logging**, replacing the current scattered `console.log`/
  `console.error` calls across `app.js`, `worker.js`, `specDocWorker.js`, and
  `pipelineRunner.js` with a leveled, structured logger ([pino](https://github.com/pinojs/pino)):
  - Levels (`debug`/`info`/`warn`/`error`) instead of one undifferentiated stream, so
    e.g. the routine `[worker] running pipeline for session N` lifecycle noise can be
    filtered out from actual failures.
  - Structured fields (`sessionId`, `repoId`, `coNumber`, `stage` where applicable)
    attached to each log line, not just baked into a formatted string — makes a
    session's full lifecycle greppable by id across clone/codegen/build/test/push,
    not just whatever happens to be in the message text today.
  - Still writes to stdout too (so `docker logs`/`podman logs` keep working unchanged),
    in addition to the rotated file below — not instead of it.
- **Rotated file output into a repo-visible `logs/` directory**, bind-mounted the same
  way the app/worker containers already bind-mount the repo (via `pino-roll` or
  equivalent — size- and/or date-based rotation) — so logs survive container
  recreation and are directly `grep`-able from the host without going through `docker
  exec`/`docker logs`. `logs/` added to `.gitignore`: generated output, not something
  to commit.
- **`LOG_RETENTION_DAYS` env variable** (`.env` / `.env.example`), governing a purge
  sweep over rotated files in `logs/` — anything older than this many days is deleted.
  Defaults to **3** when unset, so a dev environment doesn't need to set anything to
  get bounded disk usage. This is a separate mechanism from Docker's own
  `--log-opt max-file` count-based rotation above (which stays as-is, unaffected by
  this variable) — `LOG_RETENTION_DAYS` only prunes the app-level files this phase
  adds under `logs/`.

Open / undecided for this phase:
- Per-process log files (`logs/app.log`, `logs/worker.log`,
  `logs/spec-doc-worker.log`) vs. one combined file — leaning per-process, since the
  three processes' concerns rarely overlap, but not decided yet.
- Where the purge sweep itself runs from — a `setInterval` inside each long-running
  process (`app.js`/`worker.js`/`specDocWorker.js`), or one small standalone script
  invoked periodically (cron-like, the same open question Phase 8 already has for
  `specDocWorker.js`'s own interval) — not decided yet.
- Whether to cross-reference this operational logging with the pipeline-run logs
  already persisted in MariaDB and surfaced on the branch page
  (`pipeline_runs.build_log`/`test_log`, since Phase 9) — e.g. a `runId` field on
  structured log lines emitted during that run — or keep the two entirely separate.
  This phase assumes they stay separate unless that proves awkward in practice.

**Implementation notes (decisions made while building this phase):**
- **Per-process log files, resolved**: `app/lib/logger.js`'s `createLogger(name)`
  takes `'app'`/`'worker'`/`'spec-doc-worker'` and each writes its own
  `logs/<name>.log` via `pino-roll` (size `10m` + daily rotation combined), alongside
  an unchanged stdout stream (`pino/file` targeting fd 1) so `docker logs`/`podman
  logs` keep working exactly as before.
- **Purge sweep, resolved**: `app/lib/logRetention.js`'s `schedulePurge()` runs an
  hourly `setInterval` inside each of the three long-running processes themselves
  (called once from `app.js`, `worker.js`, and `specDocWorker.js`) rather than a
  standalone script — all three already run forever, and a redundant sweep from more
  than one process is harmless (deleting an already-purged file is a no-op). Reads
  `LOG_RETENTION_DAYS` (default **3**) and deletes any file under `logs/` whose mtime
  is older than that many days.
- **Operational logs vs. `pipeline_runs.build_log`/`test_log` stay separate for now**,
  per the default this phase already called out — no `runId` field was added yet;
  structured pipeline log lines carry `sessionId`/`repoId`/`coNumber`/`stage` instead
  (see below), which is enough to make a session's lifecycle greppable without joining
  back to a specific `pipeline_runs` row when there's only one attempt. See Phase 16
  for the decision to close this gap with a `runId` field once a multi-attempt session
  actually needs it.
- **`createLogger(name)` caches one pino instance per name**, not a fresh one per
  call: `specDocService.js`'s one remaining stray `console.error` (a job-failure log
  inside `drainQueuedJobs`) also moved to the structured logger, under the same
  `'spec-doc-worker'` name `specDocWorker.js` uses. Two independent `pino-roll`
  transports targeting the same `logs/spec-doc-worker.log` would each track their own
  rolling-file-index state and race each other, so same-name callers must share one
  underlying instance rather than each constructing their own.
- **`pipelineRunner.js` builds one child logger per session** (`sessionId`, `repoId`,
  `coNumber`) immediately after `loadContext` succeeds in both `run()` and `resume()`,
  threaded through to `setStage()` (which now logs the transition itself, in addition
  to its existing `pipeline_runs.stage` write) and `finishSuccessfully()`. This piggybacks
  on the exact same call sites Phase 9's stepper already uses to track stage, rather
  than adding a parallel set of logging calls.
- **No extra bind mount needed for `logs/`**: the app/worker/spec-doc-worker
  containers already bind-mount the full repo (`-v "$(CURDIR)":/app"`, see Makefile),
  so a file written to `logs/<name>.log` from inside any of them lands directly in the
  repo's own `logs/` directory on the host, survives container recreation, and is
  `grep`-able without `docker exec`/`docker logs` — matching the Phase 10 admin-API
  precedent of reusing what's already there instead of adding new plumbing.
- **Docker-level rotation flags land on exactly the three app-level Makefile
  targets** (`dev`, `worker`, `spec-doc-worker`) — `db-up`'s `apex-mariadb` container
  is unaffected, consistent with the roadmap's explicit `apex-app`/`apex-worker`/
  `apex-spec-doc-worker` scope and MariaDB's own logging being a separate concern.

## Phase 13 — Branch page requirements-log panel & branch lifecycle management

Not in notes.md's original scope.

- **Branch detail page becomes a three-panel layout**
  (`/repos/:repoId/branches/:branchId`): existing left sidebar (branch nav, unchanged)
  + center panel (existing clarification/pipeline content, unchanged) + a new **right
  panel**, a little wider than the left sidebar, showing the Requirements Log entries
  already recorded for this branch's CO — so a user drafting a new requirement can see
  at a glance what's already been implemented on this CO, without leaving the page or
  going to the separate Documents view.
  - Reuses the existing `repo_documents`/`requirementsLogFormat.js` machinery (Phase
    8) rather than a new store: the right panel fetches this repo's
    `requirements_log` doc and extracts just the `## CO <this CO>` section via
    `parseSections` — the same mechanism `documentsService.searchByCoNumber` already
    uses for the cross-repo search, scoped here to one repo instead of every
    accessible repo.
  - Read-only panel; it never writes back into `session_requirements` (the branch's
    own in-progress requirement list, unaffected, stays in the center panel as today).
- **Repositories → selected repo page gets a branch-management table** at the bottom
  (`/repos/:repoId`), below the existing "Start new branch" form, with **Active** and
  **Stale** tabs:
  - **Active tab**: the repo's active/in-progress branches (today's sidebar/branch
    list content, surfaced here too in table form).
  - **Stale tab**: branches the user has explicitly deactivated. Each row gets a
    **Reactivate** button, moving it back to Active.
  - **Delete** action (user-initiated) and Phase 4's *automatic* on-demand
    GitHub-existence check (`branchService.listActiveBranches`, today flips a missing
    branch to `status='deleted'`) are unified to the same outcome, but as a **soft
    delete**, not a row removal: both paths converge on `status='deleted'`, meaning
    "hidden from the UI, permanently" — whether Apex detects the branch is gone on
    GitHub itself, or the user explicitly deletes it here. The row stays, so
    `sessions` / `session_requirements` / `pipeline_runs` / `audit_log` history tied
    to that branch is untouched and intact (no FK fallout, no lost build/test logs),
    it's just unreachable from the UI going forward. If a user wants to add more to
    the same CO after its branch is deleted, they create a new branch on that CO,
    same as today.
  - Consistent with (and reinforced by) Phase 3's GitHub App scope, which was never
    granted delete/admin permissions in the first place — this never touches the
    branch on GitHub regardless of which of the two paths triggered it.
  - `branches.status` becomes `active` / `stale` / `deleted` — `deleted` now has one
    consistent meaning regardless of trigger (today it's Phase 4's automatic case
    only), resolving the earlier naming-collision concern rather than needing a new
    value for it.
  - No "undelete" path is offered — unlike `stale`, `deleted` is a one-way door from
    the UI's perspective (matches "if a branch is deleted, it should no longer
    display that branch" with no mention of bringing it back). The row surviving in
    the DB is for history/audit purposes only, same spirit as Phase 11's force-unlock
    leaving an orphaned session's row untouched rather than deleting it.

Open / undecided for this phase:
- Whether "Reactivate" on a `stale` branch needs the same GitHub-existence re-check
  Phase 4/7 already do at branch-list-render and session-start time (a branch could
  have been deleted on GitHub by someone else while it sat in Stale) — not decided
  yet.
- Exact right-panel width split (e.g. 220px left sidebar / flexible center / ~300–
  320px right panel) — a concrete ratio needs picking at implementation time; this
  phase only commits to "a little larger than the left panel."
- Whether a branch with a non-terminal session (`running`, or `queued` holding the
  pipeline lock) can be deactivated/deleted at all, or whether that's blocked until
  the session reaches a terminal state — not decided yet.

**Implementation notes (decisions made while building this phase):**
- **Non-terminal-session guard, resolved**: deactivate/delete are blocked while
  `lockService.isLockedForBranch(repoId, coNumber, branchId)` returns true — a join from
  `pipeline_locks` to `sessions` on `session_id`, filtered to `s.branch_id = ?`. Checking
  by `co_number` alone would over-block: a user's first branch on any CO is always its
  own increment independent of other users (Phase 4), so two different branches can
  share a `co_number` and only one of them actually holds the lock. The guard applies to
  both `/deactivate` and `/delete`; `/delete` keeps it even though a `stale` branch can
  never actually be locked (deactivation itself is blocked while locked, and `/continue`
  already requires `status='active'` to start a new session) — cheap extra safety against
  a future edge case rather than a currently-reachable one.
- **Reactivate GitHub-existence re-check, resolved**: `branchService.reactivateBranch`
  re-runs the exact same `githubApi.getBranch` check `listActiveBranches` already does.
  A confirmed 404 calls the same `markDeleted` a stale branch's Delete action would have
  called, surfacing a message instead of silently reactivating a dead branch. An
  ambiguous/failed lookup (no creds, transient error) is treated as "unknown" and
  reactivated anyway — same "only act on a confirmed 404" rule as `listActiveBranches`,
  which re-runs that same check on the very next repo-page load and will catch it then if
  it's genuinely gone.
- **`markDeleted(branchId)` unifies both delete paths**, per the roadmap's "converge on
  the same outcome" language: `listActiveBranches`' automatic GitHub-gone detection and
  the new user-initiated `/delete` route both call it, rather than each having its own
  `UPDATE ... SET status = 'deleted'`.
- **Branch-management actions aren't owner-restricted**: unlike `/retry`/`/resume`
  (scoped to the session's own `(branch_id, user_id)`), `/deactivate`, `/reactivate`, and
  `/delete` are available to any user with access to the repo group — the same access
  level `createBranch` and `/continue` already require, consistent with branch creation
  itself not being ownership-gated either.
- **Audit logging uses `auditLog.logAction` (the plain `audit_log` table), not
  `adminAudit.logAdminAction`**: these are user actions available to any repo-group
  member, not gated by `is_admin`, so they follow the same non-admin pattern as
  `session_approved`/`session_cleared` elsewhere in `app/routes/repos.js`. `session_id` is
  passed as `null` since these actions are branch-level, not tied to one session.
- **Active/Stale tabs are a `?tab=active|stale` query param** on `GET /repos/:repoId`
  (defaulting to `active`), reusing the same pattern as the dashboard's `?group=`
  selector (`views/dashboard.ejs`) rather than two separate routes — the two tables share
  one `renderRepoPage` call and one error-message path.
- **Right panel width settled at 300px** (`.requirements-panel` in
  `public/css/style.css`), mirroring `.sidebar`'s fixed-width + border + background
  convention on the opposite side of the flex `.layout` row. `.content` stays `flex: 1`
  unchanged — it simply shrinks to fill what's left between the two fixed-width asides.
- **Right panel reuses `documentsService`/`requirementsLogFormat.js` via a new
  `getCoSection(repoId, coNumber)`**, a repo-scoped sibling to the existing
  `searchByCoNumber` (which iterates every accessible repo plus a
  `user_repo_group_permissions` join irrelevant here, since the branch route already has
  `access.repo` from `repoAccess.js`). Rendered with the same `.document-body` class the
  Documents page already uses, with `max-width`/`margin-bottom` overridden inside
  `.requirements-panel` to fit the narrower fixed-width column instead of the Documents
  page's 800px.
- **Schema**: `branches.status` widened from `ENUM('active','deleted')` to
  `ENUM('active','stale','deleted')` via `ALTER TABLE ... MODIFY COLUMN` (re-stating the
  full definition), since this is the first phase needing to widen an existing enum
  rather than just add a column — `MODIFY COLUMN` restating the same target definition is
  itself idempotent on a rerun, keeping schema.sql's "no incremental migration files"
  convention intact without needing a new mechanism.

## Phase 14 — Usage/cost reporting & model-provider circuit breaker

Not in notes.md's original scope.

- **Model adapter contract change**: `generate()` returns `{text, usage}` instead of a
  bare string, so token usage (currently parsed off NIM's response and discarded, even
  though the API already returns it) is captured for every call site
  (`overlapService.js`, `clarificationService.js`, `codegenService.js`,
  `specDocService.js`) instead of just this one.
- **New `usage_events` table**, append-only, one row per model call: timestamp,
  call_site, session/org/repo attribution, provider, model, input_tokens,
  output_tokens, cache tokens (for providers that report them), and `cost_usd` computed
  at write time from a pricing lookup — not derived later, so historical rows stay
  accurate if pricing changes.
- **Small pricing config**, `model -> $/MTok input, $/MTok output[, cache rates]`. The
  current NIM model resolves to $0 (self-hosted/free), which keeps the schema and
  dashboard provider-agnostic ahead of ever adding a second adapter — see "Non-NIM model
  provider" under Open/future.
- **New admin page** ("Usage"), alongside the existing Orgs/Repos/Permissions/Alerts/
  Locks screens:
  - Summary cards (total tokens, total cost, total requests, avg cost/request) over a
    date range.
  - Breakdown by org/repo-group and by call-site, to see which service is costing the
    most.
  - Trend over time.
  - Reporting only for now — no spend caps or enforcement.
- **Model-provider circuit breaker**: a shared health status per provider (`healthy` /
  `warning` / `locked`, with a reason + timestamp), checked by `modelAdapter.js` before
  attempting a call, so a known-exhausted provider fails fast with a clear message
  instead of every in-flight call failing individually deep inside whichever service
  called it. This matters because clarification/overlap calls from Phase 5 are not
  serialized — several can be in flight across different users at once.
  - **State must be DB-backed, not in-memory**: the model adapter is called from three
    separate processes (`app.js`, `worker.js`, `specDocWorker.js` — see Phase 12), none
    of which share memory, so a per-process flag wouldn't be visible across all of them.
    Reuses MariaDB the same way `pipeline_locks`/`sessions` already coordinate
    cross-process state, consistent with this project's "no Redis" stance (see Stack
    decisions).
  - Triggered by a provider error classified as quota/billing-related, as distinct from
    a transient network error, which shouldn't lock anything.
  - Surfaced on the same Usage admin page as a status indicator, not a separate screen.

Open / undecided for this phase:
- Whether "credits" stays purely a reporting label for cost/tokens, or becomes an actual
  allocated budget per org/repo-group later — this phase assumes reporting only.
- Exact warning threshold (e.g. 80% of a known quota) before flipping to `warning`
  state, if a hard quota is even knowable in advance for the provider in use.

**Implementation notes (decisions made while building this phase):**
- **`modelAdapter.generate(messages)` now returns `{text, usage, provider, model}`**
  instead of a bare string. Usage capture and cost attribution deliberately live at each
  of the four call sites (`overlapService.js`, `clarificationService.js`,
  `codegenService.js`, `specDocService.js`), not inside `modelAdapter.js` itself —
  `modelAdapter.js` only gates calls behind the circuit breaker, which is genuinely
  provider-level state, not something tied to any one call site's session/repo context.
  Each call site writes its own `usage_events` row right after a successful `generate()`
  call, via the new `app/lib/model/usageService.js`.
- **Usage is logged only for successful model calls**, not failed attempts. NIM's error
  responses carry no usage data, and `nvidiaNimAdapter.js`'s own internal retry loop
  (`MAX_ATTEMPTS`) already absorbs transient failures before `modelAdapter.js` ever sees
  them — so "one row per model call" in practice means one row per call that actually
  returned content. Usage-event writes are themselves best-effort (`.catch(() => {})` at
  every call site): a logging failure must never block the clarification loop, codegen,
  or doc regen, same spirit as this codebase's existing "model failure shouldn't block"
  pattern (see `overlapService.js`'s diff/model try/catch blocks).
- **`checkOverlap` and `runModelLoop` gained a `session` parameter**, and
  `codegenService.runCodegen` gained a `sessionId` param threaded through
  `pipelineRunner.js`'s `codegenStep` — needed purely for usage-event attribution;
  neither function used `session` for any other purpose before this phase.
  `specDocService.js` passes `sessionId: null` — repo-level doc regen has no session to
  attribute to, same as it has no CO.
- **Circuit breaker lives in `app/lib/model/providerHealth.js`**, backed by a new
  `model_provider_health` table (one row per provider, upserted — existence isn't the
  signal, unlike `pipeline_locks`; `status` is). `modelAdapter.generate()` calls
  `assertHealthy()` before every attempt and `recordFailure()` after every failure;
  only an error classified as quota/billing-shaped (HTTP 429/402, or
  `/quota|billing|credit|insufficient/i` in the message) actually locks it — a transient
  network error is a no-op, since `nvidiaNimAdapter.js` already retries those
  internally and they say nothing about remaining quota.
- **Resolved: lock point is call-site only, deliberately not also at pipeline entry.**
  `pipelineRunner.js`'s step order is clone → codegen → build → test → push, and
  `codegenService.js` (the pipeline's own first model call) is reached immediately after
  clone — so an entry-point check in `run()`/`resume()` would only save one clone step's
  wall-clock on an already-known-locked provider, not a build/test cycle; build/test never
  run anyway, since `codegenService`'s own call-site check already fails the run before
  either starts. Weighed against that modest saving: nothing is currently broken (every
  run already fails cleanly, just one clone-step later than strictly necessary), and
  keeping the check in one place (`modelAdapter.js`) means all four call sites get it for
  free with no per-call-site wiring — a second check at pipeline entry would be a second
  place that has to track provider-health semantics. Revisit only if clone cost in
  practice (large repos, slow network) makes paying it on a known-dead provider a real
  nuisance, not just a theoretical one.
- **Resolved: recovery is manual-only**, via a "Clear lock" button on `/admin/usage`
  (`POST /admin/usage/providers/:provider/clear-lock`, logged to `admin_audit_log` same
  as `/admin/locks`' force-unlock). No auto-expiry — this project has no reliable signal
  for *when* a given provider's quota actually resets, so guessing one would be worse
  than requiring a deliberate admin action.
- **`warning` status is schema-only for now** — `model_provider_health.status` supports
  it and the admin page would render it correctly, but nothing automatically transitions
  a provider into it, since no hard NIM quota is knowable in advance to compare usage
  against (same open question the roadmap already named). Only `healthy` ⇄ `locked` are
  actually reachable today.
- **Pricing**: `app/lib/model/pricing.js` is a plain `model -> $/MTok` object with a
  `{0, 0, 0, 0}` default for any unlisted model — the table starts empty since every
  model in use today (self-hosted NIM) is genuinely free, not just unpriced.
  `usageService.recordUsage` calls it at write time, per the roadmap's "not derived
  later" requirement.
- **New admin page `/admin/usage`** (`app/routes/admin/usage.js` /
  `views/admin/usage.ejs`), added to `views/admin/partials/nav.ejs` alongside the
  existing admin screens. A `?from=&to=` date-range query param (default: trailing 30
  days) drives every section — summary cards, provider health + clear-lock, breakdown by
  org/repo-group, breakdown by call site, and a daily trend table. No charting library
  in this stack (EJS, no client-side framework — see Stack decisions), so "trend over
  time" is a plain table of day → requests/tokens/cost, consistent with every other
  admin screen here being server-rendered tables.

## Phase 15 — Spec/Communication Protocol doc regen: cron cadence

Resolves the open question from Phase 8 / Open-future: the Spec/Communication Protocol
doc regen job (`specDocWorker.js`) will run on a **nightly cron job, once every 24
hours** — not the 5-minute interval-loop default it ships with today.

- **Interval:** nightly. Doc freshness bounded to once a day is acceptable — these are
  low-urgency Documents-page artifacts, not anything the AI pipeline depends on.
- **Mechanism:** a nightly cadence changes the shape of `specDocWorker.js` itself, not
  just its config. The current `for (;;) { tick(); sleep(INTERVAL_MS); }` loop (see
  Phase 8) should become a one-shot script — run `scanForStaleRepos()` +
  `drainQueuedJobs()` once, then exit — invoked by whatever cron-like facility the
  eventual deployment target provides (host crontab, systemd timer, container-native
  CronJob, etc.). This decouples the mechanism choice from the deployment-target
  decision (still open, see Stack decisions): a one-shot script works identically under
  any of them, so deployment target no longer needs to be decided first to close this
  out.
- **Known side effects, not yet resolved:** `SPEC_DOC_SCAN_INTERVAL_MS` becomes
  obsolete; the Makefile's `nodemon`-based persistent run target (see Phase 8) needs
  rework for a one-shot invocation; `logRetention.js`'s `schedulePurge` hourly
  `setInterval` (Phase 12) becomes moot once `specDocWorker.js` exits right after its
  single tick — harmless, since the immediate `purgeOnce` call it also makes still runs
  once per nightly invocation, which is as often as the purge needs to run anyway.

**Implementation notes (decisions made while building this phase):**
- **`specDocWorker.js` is now a one-shot script**: `main()` runs
  `scanForStaleRepos()` + `drainQueuedJobs()` once, calls `logRetention.purgeOnce()`
  directly (not `schedulePurge()` — see below), then exits — `process.exit(0)` on
  success, `process.exit(1)` on an uncaught error from either step, so the invoking
  cron-like facility gets a real exit code to alert on instead of a silently-stuck
  process. The old `for (;;) { tick(); sleep(INTERVAL_MS); }` loop, `sleep()` helper,
  and `INTERVAL_MS` are gone entirely, not just unused.
- **`SPEC_DOC_SCAN_INTERVAL_MS` removed from `.env.example`**, per the "known side
  effect" flagged when this phase was decided — nothing reads it anymore.
- **`logRetention.js`'s `schedulePurge()` is no longer called from
  `specDocWorker.js`** — it calls `purgeOnce()` directly instead. `schedulePurge()`
  (immediate `purgeOnce` + hourly `setInterval`) still exists and is still used by
  `app.js`/`worker.js`, the two long-running processes where a repeat hourly sweep
  makes sense; a `setInterval` in a process that exits right after its single tick
  would just hold the event loop open for no reason. The immediate `purgeOnce` call
  `main()` makes is still exactly one purge per nightly invocation — as often as the
  purge needs to run, per the original decision.
- **Makefile's `spec-doc-worker` target** dropped `-d`/`--name`/`npx nodemon` in favor
  of a plain `docker run --rm ... node specDocWorker.js` — runs to completion and
  removes itself, rather than staying up as a persistent container for nodemon to
  restart. `SPEC_DOC_WORKER_CONTAINER` and its `stop` target line were removed since
  there's no longer a persistent named container to `rm -f`. The `--log-opt
  max-size/max-file` flags (Phase 12) were also dropped from this target —
  irrelevant to a container that's gone within seconds of starting.
  **Mechanism still deliberately not wired up**: nothing in this repo actually
  invokes `make spec-doc-worker` on a nightly cadence yet (no crontab entry,
  systemd timer, or CronJob manifest is checked in) — the deployment target that
  would host one of those is still undecided (see Stack decisions), and per this
  phase's original mechanism/deployment-target decoupling, that's fine: whoever
  sets up the eventual deployment target just needs to point its cron-equivalent at
  `make spec-doc-worker` (or the equivalent `docker run` directly), nightly.
- **Docs updated to match** (`README.md`, `SPEC.md`, `apex_troubleshooting.md`,
  `apex_nim_integration.md`, `docs/docker-usage.md`, plus comments in
  `specDocScanService.js`/`logger.js`/`logRetention.js`) — anywhere that described
  `apex-spec-doc-worker` as a persistent, interval-polling container now describes it
  as a one-shot nightly invocation instead.

## Phase 16 — Logging & Observability: runId correlation

Resolves the open question from Phase 12: operational (structured app) logs and
`pipeline_runs.build_log`/`test_log` are linked by a **`runId` field**, rather than
staying entirely separate.

- **Field name: `runId`**, not a generic `rowId`. This matches the domain vocabulary
  this codebase already uses — `pipeline_runs`, `attempt_number`, Phase 8's
  "from-scratch retry" and Phase 9's "resume-from-step retry" all talk about a "run"/
  "attempt." A generic `rowId` would also be ambiguous once attached: `sessionId` and
  `repoId` are already bound to every structured log line and are *themselves* primary
  keys of other tables, so naming only the new field after the fact that it's a row id
  (rather than what it identifies) would make it look like a different kind of thing
  than it is.
- **No additional timestamp column needed.** `pipeline_runs` already has `created_at`
  (set on insert, i.e. attempt start) and `updated_at` (bumped on every subsequent
  `UPDATE` — `setStage`/`setContainerId`/`completeRun`/`failRun` all touch it), giving
  each attempt a usable time window already. Structured log lines are already
  timestamped by pino's own `time` field. `runId` closes the actual gap (which lines
  belong to which attempt); a redundant timestamp column wouldn't add anything on top
  of what both sides already carry.
- **Where it lands:** `pipelineRunner.js` binds `sessionId`/`repoId`/`coNumber` onto a
  per-session child logger in both `run()` and `resume()`, right after the attempt's
  `pipeline_runs.id` becomes known (`createRun`'s return value, or the loaded failed
  run's `id` on resume). `runId` joins that same binding — no schema change, since
  pino's child logger just merges an extra field into the JSON output.
- **Trigger for building it:** next time debugging a session with 2+ `pipeline_runs`
  attempts actually requires disambiguating which structured log lines belong to which
  attempt's `build_log`/`test_log`, rather than inferring it from timestamps or
  stage-transition markers.

**Implementation notes (decisions made while building this phase):**
- **`run()`** passes `runId` into `logger.child(...)` immediately after `createRun(sessionId)`
  resolves — the same point `runId` first becomes available, and already the earliest
  point before any step-level logging (`setStage('cloning', ...)` etc.) happens.
- **`resume()`** passes `runId: failedRun ? failedRun.id : undefined`. The child logger is
  built right after the `SELECT ... ORDER BY id DESC LIMIT 1` lookup, which happens before
  the `!failedRun` eligibility guard a few lines later — so the lookup returning no row at
  all (which that guard treats as a bug-for-safety case, not a normal path; see Phase 9) is
  handled by simply omitting `runId` from that one log line rather than throwing out of the
  startup try/catch, which would mis-route a benign "nothing to resume" case through the
  same `catch` block as a real startup failure.
- **No change to `app/lib/logger.js`** — `createLogger`/`cache` are untouched; this phase is
  entirely a call-site change to what gets merged into an existing child logger.

## Phase 17 — SSO: provider selection & authorization model

`app/lib/auth/authProvider.js` is today a hardcoded stand-in for "whichever provider is
active" (`module.exports = localAuthProvider`) — a seam with nothing plugged into it.
This phase decides how that seam will actually switch providers, and how
authorization works once authentication is no longer always local, *without* building
a second provider yet.

- **`AUTH_PROVIDER` env var, default `local`.** `authProvider.js` selects a module by
  this value instead of its current hardcoded `require`. Matches the existing
  `authProvider`/`authenticate()` naming rather than introducing a new term.
- **Password-specific functionality gates on a capability flag exposed by the active
  provider module**, not scattered `AUTH_PROVIDER === 'local'` string checks. E.g.
  `localAuthProvider.managesPasswordsLocally = true`; a future external provider sets
  it `false`. Phase 11's self-service password-change page and the admin create-user
  password field/`DEFAULT_USER_PASSWORD` substitution both gate on this flag — this
  mirrors `authenticate()` itself already being a capability call sites use without
  caring which provider implements it, so a third provider later doesn't require
  re-auditing every call site that currently checks the raw env var.
- **The `users` table and admin user-management screen survive external auth** — only
  the password-specific parts of that flow disappear. External authentication only
  proves identity; Apex still needs a local row to carry `is_admin`, `initials`, and
  (via `user_repo_group_permissions`) which repo groups that person can touch. None of
  that is authentication-related, so none of it goes away just because password
  verification moves to an external IdP.
- **Resolved: no `APP_USER_GROUP` env var — authorization stays local-user-row-based,
  not group-claim-based.** Once an external provider only proves identity, access is
  still decided by "does a matching local `users` row exist" (by username/email), exactly
  like an unrecognized username fails to log in today — then that row's existing
  `is_admin`/`user_repo_group_permissions` govern what they can do, same as now. A
  coarse "is this person in group X" gate would be a second, less precise authorization
  source sitting next to a model that's already more granular than any single group
  check could be. It's also not generalizable across providers the way `authenticate()`
  is: Azure AD's `groups` claim (object GUIDs, sometimes requiring a separate Graph call
  past 200 group memberships) and LDAP's `memberOf` (DN strings, nested-group
  resolution) work nothing alike — that logic would have to live inside each specific
  provider implementation anyway, never as one provider-agnostic setting.
  - **Revisit trigger:** only if auto-provisioning (creating a local `users` row
    automatically on a person's first successful external login, instead of an admin
    creating it by hand first) becomes a real feature ask. That's a materially bigger
    feature than this phase scopes (it also raises what role/permissions an
    auto-provisioned user gets), and would need per-provider group-handling logic, not
    a generic env var.

**Implementation notes (decisions made while building this phase):**
- **`authProvider.js`** is now a small registry (`{ local: localAuthProvider }`) keyed by
  `AUTH_PROVIDER` (default `'local'`), throwing on an unrecognized value rather than
  silently falling back — a typo'd env var should fail startup, not quietly authenticate
  against the wrong provider.
- **`localAuthProvider.managesPasswordsLocally = true`** is exported alongside
  `authenticate`, per the decision above.
- **`managesPasswordsLocally` reaches every view via `res.locals`** (`app.js`, set once
  in middleware right after the session store is wired up) rather than every route
  threading it through `res.render(...)` options — `partials/head.ejs`'s "Change
  Password" nav link needed it and is included from 15+ views with otherwise-unrelated
  render options. `admin/users.js` still passes it explicitly alongside
  `defaultPasswordSet` since that route already builds an explicit options object and
  the two flags are read together there.
- **`admin/users.js`'s POST handler** only consults `DEFAULT_USER_PASSWORD`/
  `req.body.password` when `managesPasswordsLocally` is true; otherwise it creates the
  user with password `''`. That row's `password_hash` ends up a bcrypt hash of an empty
  string, which is fine: a provider with `managesPasswordsLocally = false` never reads
  `password_hash` from `authenticate()` in the first place (identity is proven
  externally), so the column goes unused rather than needing a schema change to allow
  `NULL`.
- **`/account/password`'s GET and POST handlers** redirect to `/` when
  `managesPasswordsLocally` is false, same as the nav link disappearing — belt-and-
  suspenders against someone hitting the URL directly without the link ever being
  shown.

No second provider is built yet (`AUTH_PROVIDER` has exactly one valid value today) —
see "SSO" under Open/future for that remaining work.

## Open / future (not scheduled)

Carried forward from notes.md as genuinely undecided/unbuilt, not assigned to a phase:

- **SSO** — `AUTH_PROVIDER` selection, the `managesPasswordsLocally` capability flag, and
  the local-user-row authorization model are all built (Phase 17), but no second
  provider (LDAP, Azure AD, etc.) is actually built yet.
- **Non-NIM model provider** — the adapter interface isolates this, but switching
  provider request/response shape is unexercised.
- **Branch-deletion staleness window** — on-demand detection (branch-list render,
  session start) accepted for now; revisit toward a webhook only if usage shows real
  collisions.
- **Richer per-repo pipeline config format** — `apex.pipeline.json` stays plain JSON
  unless a real need for something richer emerges.
- **Idle/abandoned kept-alive containers** — Phase 7 keeps a failed container alive
  for resume-from-step retry, torn down on success, resume-limit exhaustion, or
  explicit abandonment. There's no timeout-based cleanup for a container that's simply
  never retried and never explicitly abandoned; not decided yet.
- **Branch-head staleness check on resume-from-step retry** — whether a Phase 9 resume
  attempt re-validates the DEV branch hasn't moved (via a direct push from another
  engineer) since the last successfully completed step before trusting cached state.

## Accepted risks

Carried forward as-is from notes.md — see that document's "Accepted risks" section for
the full list and rationale (CO validity, branch-reuse judgment, delivery-doc
staleness, audit log scope, branch-deletion staleness, parallel per-user branches,
overlap-detection judgment, the 403 heuristic). Nothing here is resolved by
resequencing the build order; they're accepted trade-offs, not open questions.
