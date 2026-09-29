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

## Phase 6 — Sandboxed execution

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
  immediately — it's kept alive (see Phase 8's resume-from-step retry) until the
  session either succeeds, exhausts its resume-attempt limit, or is explicitly
  abandoned. Only then is it destroyed. (Idle/abandoned-but-never-retried containers
  still need an eventual timeout-based cleanup; not decided yet — flagged under
  Open/future.)

## Phase 7 — DEV branch delivery

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

## Phase 8 — Session progress indicator

Not in notes.md's original scope; added because a coarse `sessions.status` enum makes
it hard to tell where a session actually is or which step an error happened in. Placed
here because it's the first point every state/sub-state it needs to display actually
exists (clarifying from Phase 5; approval/queued/running/completed/failed from Phase
7).

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
- **Retry, resuming from the failed step** (not the from-scratch retry Phase 7
  already has — this is new behavior, surfaced directly on the sub-stepper next to the
  failed step):
  - Reuses the kept-alive container (see Phase 6) and whatever the last successfully
    completed step produced — e.g. if push failed, retry re-attempts only the push,
    reusing the already-built/tested commit; codegen/build/test are not redone.
  - `pipeline_runs.resume_attempt_count`, capped at **3**. Each resume-from-step click
    increments it.
  - On exhausting 3 resume attempts at the same step, the kept-alive container is torn
    down and the resume option is disabled — the session falls back to Phase 7's
    existing full-session retry (fresh container, full from-scratch re-run) rather
    than dead-ending the user.
  - Not yet decided: whether a resumed attempt re-validates that the DEV branch head
    hasn't moved since the last successful step (another engineer could have pushed
    directly to the same branch in between) before trusting the cached state, or skips
    that check for simplicity. Flagged under Open/future — revisit before building
    this if it matters in practice.

## Phase 9 — Observability & hardening

- Blocked-allowlist alerts: `blocked_allowlist_alerts` table +
  `GET /api/admin/alerts`, a real queried surface, not write-only. "403 means allowlist
  block" is a heuristic, not a guarantee — GitHub returns 403 for both an App-permission
  violation and a `dev/**` ruleset rejection; a 422/409 non-fast-forward push is a
  separate, already-handled retry case and never lands here.
- Lock-contention dashboard: `lock_contention_events` table +
  `GET /api/admin/locks`, `/api/admin/lock-contention`.
- `docs/github-app-key-rotation.md` and `docs/human-judgment-reliance.md`.

## Open / future (not scheduled)

Carried forward from notes.md as genuinely undecided/unbuilt, not assigned to a phase:

- **SSO** — the `authProvider` interface supports it, but no second provider is built.
- **Non-NIM model provider** — the adapter interface isolates this, but switching
  provider request/response shape is unexercised.
- **Branch-deletion staleness window** — on-demand detection (branch-list render,
  session start) accepted for now; revisit toward a webhook only if usage shows real
  collisions.
- **Richer per-repo pipeline config format** — `apex.pipeline.json` stays plain JSON
  unless a real need for something richer emerges.
- **Idle/abandoned kept-alive containers** — Phase 6 keeps a failed container alive
  for resume-from-step retry, torn down on success, resume-limit exhaustion, or
  explicit abandonment. There's no timeout-based cleanup for a container that's simply
  never retried and never explicitly abandoned; not decided yet.
- **Branch-head staleness check on resume-from-step retry** — whether a Phase 8 resume
  attempt re-validates the DEV branch hasn't moved (via a direct push from another
  engineer) since the last successfully completed step before trusting cached state.
- **Spec/Communication Protocol cron interval** — Phase 7 decouples doc regeneration
  from `worker.js` into a separate cron-scheduled script; the actual interval (and
  whether it's a host cron/systemd timer vs. something container-native) isn't decided
  yet, since it depends on the deployment target (also still undecided — see "Stack
  decisions").

## Accepted risks

Carried forward as-is from notes.md — see that document's "Accepted risks" section for
the full list and rationale (CO validity, branch-reuse judgment, delivery-doc
staleness, audit log scope, branch-deletion staleness, parallel per-user branches,
overlap-detection judgment, the 403 heuristic). Nothing here is resolved by
resequencing the build order; they're accepted trade-offs, not open questions.
