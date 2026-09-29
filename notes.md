# Apex — Project Roadmap

Status as of 2026-09-28. Apex is an internal tool that lets multiple authenticated
engineers drive an AI agent against a shared set of GitHub repos to implement a Change
Order (CO). **The agent's only Git output is a DEV branch** — it never opens a PR and
never merges. Everything downstream (TEST branch, PR, merge to `main`) is human-owned
and outside this tool.

All phases originally scoped (0–7, below) are implemented and merged. This document is
now a status record, not a forward plan: what shipped, what shipped afterward that
wasn't in the original phase list, what's in progress, and what's still genuinely open.

## Regulatory context (load-bearing, not a footnote)

CO numbers originate in a regulated change-control / quality system. This document does
not constitute regulatory or compliance guidance — QA/RA sign-off is a separate process
and hasn't happened via this document.

Because the AI's output stops at a DEV branch, and every regulated-adjacent action
(review, test, PR, merge) happens through the existing human-driven process, the AI
itself sits outside the formal approval chain. That materially reduces (but does not
eliminate) exposure to electronic-record/signature requirements and
segregation-of-duties concerns for *this tool specifically* — those requirements still
apply to whatever already governs the TEST → PR → main process today. See
[docs/human-judgment-reliance.md](docs/human-judgment-reliance.md) for the fuller
internal note on why this project leans on human review at every judgment point rather
than trying to make the AI's judgment authoritative.

## Layout

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Apex                                                          [ Login ]    │  ← top nav bar
├───────────────┬─────────────────────────────────────────────────────────────┤
│               │  [ Group A ][ Group B ][ Group C ] ...  ← tabs              │
│  Sidebar      │ ──────────────────────────────────────────────────────────  │
│  (contextual, │  ┌───────────────────────────────────────────────────────┐  │
│  empty until  │  │ repo-one         short description    collaborators   │  │
│  a repo/job   │  │                   updated 2d ago                      │  │
│  is active)   │  ├───────────────────────────────────────────────────────┤  │
│               │  │ repo-two         short description    collaborators   │  │
│               │  │                   updated 5h ago                      │  │
│               │  └───────────────────────────────────────────────────────┘  │
└───────────────┴─────────────────────────────────────────────────────────────┘
```

**Selection flow:** repo list → select a repo → active-branch list for that repo
(excludes branches marked `deleted`) → user either selects an existing branch to
continue, or requests the next available branch name to start new work.

## How it works today

- **Auth:** username/password (bcrypt), server-side sessions, built behind an
  `authProvider` interface (`app/lib/auth/`) so SSO can be swapped in later without
  touching call sites. SSO itself hasn't been built — see "Open / future" below.
- **Branch naming:** `dev/{initials}-{CO}-{n}`, e.g. `dev/YP-C12345678-1`. Increment is
  scoped to `(initials, co_number)`, not `(repo_id, co_number)` — a user's first branch
  on any CO is always `-1`, independent of other users. Two different users can each
  hold a `-1` branch for the same CO; this is a deliberate parallel-branches model, not
  an oversight (see Accepted Risks #7).
- **GitHub access:** one org-wide GitHub App installation, `contents: write` only,
  scoped to the `dev/**` ref pattern via a repository ruleset. No `pull_requests` scope,
  no merge capability — the app has strictly less access than a PR-capable tool would
  need. Never force-pushes; on non-fast-forward it fetches and retries against current
  remote state or fails loudly, since engineers may push directly to the same DEV branch.
- **Locking:** one AI session at a time per `(repo_id, co_number)`, covering the full
  pipeline (clone → sandbox build/test → push), not just the push. A push-only lock would
  let two sandboxes build against stale state and race.
- **Model backend:** pluggable via `app/lib/model/modelAdapter.js`. Currently NVIDIA
  NIM (`moonshotai/kimi-k3`), config-only via `MODEL`/`NVIDIA_BASE_URL`/
  `MODEL_MAX_TOKENS`. The adapter retries on blank/degenerate model replies and falls
  back to a `reasoning_content` field when the model returns one instead of `content`
  — see "In progress" below for the current reliability work on this adapter.
- **Sandbox execution:** ephemeral container, declarative per-repo `apex.pipeline.json`
  (`buildCommand`/`testCommand`/`image`) at the repo root — the runner never invents a
  default command. Clone uses a scoped, clone-only token; the write-capable token never
  enters the sandbox.
- **Explicit human approval gate:** a session only becomes eligible for the background
  worker to pick up after the user clicks **Approve & Implement**. It's *offered* once
  every submitted requirement has resolved out of `pending_confirm` (i.e. any
  duplicate/overlap flags have been confirmed or overridden), but nothing runs until
  that explicit click flips the session to `queued`. If new instructions or a fresh
  overlap check reopen a requirement afterward, the session drops back out of
  `queued`/approved state automatically and needs to be re-approved — approval is never
  "locked in" once given.
- **Async pipeline:** decoupled from the browser session. `worker.js` polls for queued
  sessions; completion is surfaced next time the user views that repo's branch list, no
  separate notification channel.
- **Retry on failure:** the retry action re-queues the *same* session row (conditional
  `UPDATE ... WHERE status = 'failed'`) — it is a full from-scratch re-run (codegen,
  sandbox build/test, push), not a resume-from-checkpoint. Nothing from the failed
  `pipeline_runs` row is reused.
- **Delivery docs are Apex-owned, not committed to the branch** (see "Since Phase 7"
  below) — this is the one place the original phase plan changed after the fact.

## Data model (current)

- `users` — includes `initials` (branch naming) and `is_admin` (Phase 6 gate)
- `orgs`, `repo_groups`, `repos` (per-repo `default_branch_name`,
  `spec_doc_synced_commit_sha`), `user_repo_group_permissions`
- `change_orders` — unique on `(repo_id, co_number)`
- `branches` — unique on `(repo_id, initials, co_number, increment)`, `active`/`deleted`
- `sessions` — `awaiting_approval` / `queued` / `running` / `completed` / `failed`,
  scoped per user per branch
- `session_requirements` — per-item `overlap_flag_requirement_id` +
  `pending_confirm`/`confirmed_proceed`/`confirmed_skip`
- `conversations`, `audit_log` — Q&A and raw-instruction history for the AI pipeline
- `pipeline_locks` — row existence *is* the `(repo_id, co_number)` lock
- `pipeline_runs` — one row per worker pickup attempt, captured build/test log,
  `commit_sha`, `spec_doc_path`
- `admin_audit_log` — every Phase 6 admin mutation (permission grant/revoke, initials
  edit), separate from `audit_log` since the shape doesn't fit
- `blocked_allowlist_alerts` — a GitHub write call came back HTTP 403 (App-permission
  or ruleset violation)
- `lock_contention_events` — one row per genuine cross-user lock contention on the same
  `(repo, CO)`
- `repo_documents` — Apex-owned delivery docs (requirements log,
  Spec/Communication Protocol), one row per `(repo, doc_type, co_number)`,
  `co_number=''` as the sentinel for the repo-level (not per-CO) case
- `spec_doc_jobs` — queue the trunk-staleness scanner feeds and `worker.js` drains

## Shipped: Phases 0–7 (all complete)

Detailed manual test procedures for each phase live in [test-docs/](test-docs/)
(`Phase1_test.md` through `Phase7_test.md`); Phase 0 setup steps are in
[docs/Phase0_setup.md](docs/Phase0_setup.md).

- **Phase 0 — Foundations.** Schema, username/password auth, `Makefile` `setup` target,
  setup doc.
- **Phase 1 — Platform integrations.** GitHub App token-minting service (short-lived
  tokens, never persisted); model adapter interface.
- **Phase 2 — Repo/branch selection.** On-demand GitHub existence check before rendering
  a branch list (marks missing branches `deleted`); CO format validation
  (`^C[0-9]{8}$`); new-branch-from-`main`; pipeline lock acquisition.
- **Phase 3 — Clarification loop.** LLM-driven Q&A against repo context via the GitHub
  API, written to `audit_log`; new requirements checked against already-implemented work
  on the branch, with a pause for the submitting user to confirm/override on any
  detected overlap — no auto-skip.
- **Phase 4 — Sandboxed execution.** Ephemeral, network-isolated container; declarative
  `apex.pipeline.json`; fetch-and-retry on push; branch-existence re-check at session
  start; async worker execution.
- **Phase 5 — DEV branch delivery.** Combined commit (code + requirements log + spec doc
  when applicable); the **Approve & Implement** human gate; retry-on-failure. The
  Spec/Communication Protocol doc was reworked mid-phase into a repo-scoped,
  trunk-staleness-driven background job rather than a per-session artifact (see
  `specDocScanService.js`, `specDocJobService.js`, `specDocService.js`) — already
  reflected in how it's described above.
- **Phase 6 — Access administration.** Admin UI for `user_repo_group_permissions` and
  user `initials`, itself audit-logged (`admin_audit_log`).
- **Phase 7 — Observability & hardening.** Blocked-allowlist alerts and a lock-contention
  dashboard are both real, queried admin-UI surfaces (`GET /api/admin/alerts`,
  `/api/admin/locks`, `/api/admin/lock-contention`), not write-only tables. Also:
  [docs/github-app-key-rotation.md](docs/github-app-key-rotation.md) and
  [docs/human-judgment-reliance.md](docs/human-judgment-reliance.md).

## Since Phase 7 (shipped, not in the original phase plan)

- **Delivery docs moved out of the branch entirely.** The original plan had the
  requirements log and Spec/Communication Protocol doc committed as files inside the DEV
  branch. That's no longer true: both now live in Apex's own `repo_documents` table and
  are browsable/downloadable from a **Documents UI** — a per-repo view
  (`app/routes/repos.js`) plus a global, CO-scoped cross-repo search
  (`app/routes/documents.js`, `documentsService.js`) answering "every delivery doc for
  this CO, across every repo I can access." A user who wants either doc physically in
  their repo now adds it by hand. The requirements log itself is also no longer
  per-branch — it's one cumulative record per repo, organized internally by a heading
  per CO, the same way it always was, just DB-stored instead of file-per-branch.
- **User Maintenance admin screen** — a dedicated UI (`user-maintenance.ejs`,
  `create-user` script/route) alongside the Phase 6 permissions/initials admin UI.
- **Retry button for failed sessions** — see "Retry on failure" above.
- **Model reliability hardening** — retry on empty/degenerate NVIDIA NIM replies,
  `reasoning_content` fallback, `MODEL_MAX_TOKENS` made configurable, and a fix for
  responses that hit MariaDB's `NOT NULL` constraint or the fenced-block parser instead
  of failing loudly upstream.

## In progress

- **`nvidiaNimAdapter.js` transport-vs-content failure fix** (uncommitted,
  `git diff app/lib/model/nvidiaNimAdapter.js`). Currently, a network-level error or
  non-2xx HTTP status throws immediately without exhausting the retry budget the
  empty/degenerate-content case already gets, and — more importantly — if every retry
  attempt fails at the transport level, the final error message misleadingly reports "no
  usable content" instead of the real transport failure. The in-flight change makes
  transport failures retry like content failures do, while preserving the specific
  transport error for the final throw when retries are exhausted.

## Open / future considerations

Nothing here is blocking; these are the genuinely undecided or unbuilt items, as
distinct from the "Accepted risks" below (which are known trade-offs already made, not
open questions):

- **SSO.** The `authProvider` interface exists specifically to make this swappable, but
  no second provider has been built — v1 is username/password only.
- **Non-NIM model provider.** The adapter interface isolates provider-specific request/
  response shape and auth, but switching to a different API shape (Anthropic, OpenAI
  direct, self-hosted) is an explicit code change inside the adapter, not yet exercised
  in practice. Model swaps *within* the NIM catalog are config-only today.
- **Branch-deletion staleness window.** Detection is on-demand (branch-list render,
  session start), not a standing poll/webhook — see Accepted Risk #5. Revisit toward a
  webhook only if usage shows real collisions.
- **Per-repo build/test config format.** `apex.pipeline.json` is intentionally plain
  JSON (no YAML dependency for one config file); revisit only if a real need for
  richer config emerges.

## Accepted risks (explicit — for your own audit trail)

1. **CO validity is not system-enforced against the change-control system.** Format is
   validated (`^C[0-9]{8}$`), which catches typos in shape but not invalid or
   non-existent CO numbers. Mitigation remains multi-stage human review (DEV, TEST, PR).
2. **Branch reuse decision is human judgment, not system-derived state.** The app shows
   metadata (last touched) but does not know for certain whether a CO has shipped.
3. **Delivery docs can go stale silently, and no longer travel with the branch.** A
   human editing the DEV branch directly, without triggering an AI session, won't update
   the requirements log. The Spec/Communication Protocol doc self-heals on its own
   schedule (regenerated whenever trunk moves — see `specDocScanService.js`), but since
   both docs now live in Apex's own DB rather than in the repo (see "Since Phase 7"),
   anyone who needs either doc downstream (TEST, PR, or outside Apex entirely) has to
   pull it from the Documents UI themselves — it doesn't arrive for free with the branch
   the way it briefly did in the original design.
4. **Audit log is an internal engineering record, not a Part 11-controlled electronic
   record.** Only appropriate because the AI sits outside the regulated approval chain —
   if that scope ever expands (e.g. PR or merge authority), revisit with QA/RA.
5. **Branch-deletion detection has a bounded staleness window, not none.** Checked
   on-demand (branch-list render, session start) rather than via standing poll/webhook.
   Self-corrects on next view/session start; never reaches an in-flight write.
6. **Parallel per-user branches on the same CO are a deliberate, accepted design choice,
   not an oversight.**
7. **Duplicate/overlap detection between users' sessions is a semantic judgment, not a
   guarantee.** The agent can misjudge in either direction. The confirm/override pause
   is the mitigation — a human always makes the final call before an item is skipped or
   proceeds.
8. **"403 means allowlist block" is a heuristic, not a GitHub guarantee.** GitHub
   surfaces 403 both for an App-permission scope violation and for the `dev/**` ruleset
   rejecting an out-of-pattern ref; `blocked_allowlist_alerts` records the fact of a 403,
   not a certified root cause. A 422/409 non-fast-forward push is a separate,
   already-handled retry case and never reaches this table.
