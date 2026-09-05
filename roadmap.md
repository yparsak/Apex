# AI Code-Change Agent — Project Roadmap

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

**Selection flow:** repo list → select a repo → active-branch list for that repo (excludes branches marked `deleted` — see below) → user either selects an existing branch to continue, or requests the next available branch name to start new work.

## Scope (final, as decided)

- Node.js backend, MariaDB.
- Simple username/password auth for v1, built behind an interface so SSO can be swapped in later without touching call sites.
- Multiple authenticated users share one AI agent.
- **The agent's only Git output is a DEV branch — it creates or updates a branch for a given Change Order (CO). It does not create a pull request and does not merge.**
- Everything downstream of DEV is entirely human-owned and outside this tool: engineers review the DEV branch, manually create a TEST branch, run testing procedures, and open the PR from TEST into the default branch themselves.
- Model-agnostic: the agent's model backend must be swappable (NVIDIA NIM-hosted model for prototyping, any other provider for production) without rewriting agent logic.

This is a deliberately smaller scope than the original ask — the agent no longer touches PR creation or merge at all. That's a real reduction in what the tool is responsible for, not just an implementation detail.

## Regulatory context (load-bearing, not a footnote)

Change Order numbers originate in a regulated change-control / quality system. The design decisions below were made with that in mind, but this document does not constitute regulatory or compliance guidance — QA/RA sign-off is still required and has not happened via this conversation.

Because the AI's output stops at a DEV branch, and every regulated-adjacent action (review, test, PR, merge) happens through your existing human-driven process, the AI itself sits outside the formal approval chain. That materially reduces (but does not eliminate) exposure to electronic-record/signature requirements and segregation-of-duties concerns for *this tool specifically* — those requirements still apply to whatever already governs your TEST → PR → main process today.

## Confirmed architecture decisions

| Decision | Rationale / Risk accepted |
|---|---|
| Single shared bot GitHub identity (one org-wide GitHub App installation) | Simpler than per-user OAuth; blast radius mitigated by minimal permission scope, not by identity model |
| GitHub App permissions: `contents: write` only, scoped to a DEV-branch naming pattern. No `pull_requests`, no merge. | Since the AI never creates a PR, it needs strictly less access than originally planned |
| **Branch naming: `dev/{initials}-{CO}-{n}`**, e.g. `dev/YP-C12345678-1` | Fixed format, human-readable owner + CO + increment. Replaces the earlier `CO#######` / `CO#######-2` scheme entirely — do not mix the two. Confirmed final — the earlier `JOHN.C12345678-1` example was illustrative shorthand only, not an alternate format. |
| **User initials stored per-user in `users` table**, used to populate `{initials}` at branch-creation time | Avoids re-typing initials per branch; if initials change, historical branch names do not retroactively update |
| **CO number format validated client/server-side against `^C[0-9]{8}$`** | Format-only validation. **Does not** validate against the actual change-control/QMS system — see Accepted Risks #1, which still stands. Confirmed acceptable: merge to `main` is where correctness responsibility actually lives. |
| **Increment scoped to `(initials, co_number)`, not `(repo_id, co_number)`** — a given user's first branch on any new CO is always `-1`, independent of what else that user has created | Confirmed. Two different users can each hold a `-1` branch for the same CO under their own initials — a parallel-branches-per-CO model. Confirmed as intentional: whether to coordinate on one branch or work in parallel and reconcile at TEST/PR is a human decision outside this tool's scope (see Accepted Risks #7). The UI must surface existing active branches for a CO clearly at the point of choice, so the decision is actually informed. |
| Lock granularity: `(repo_id, co_number)`, not repo-wide | Different COs on the same repo don't block each other; matches actual conflict boundary |
| Lock scope: entire pipeline (clone → sandbox build/test → push), one AI session at a time per CO | A push-only lock would allow two sandboxes to build against stale state and race on push |
| **DEV branch always cloned from `main`** | Confirmed: `main` is the production-equivalent, latest-version branch. Earlier reference to `master` in this roadmap was incorrect and is corrected here. |
| **User selects any existing active branch (regardless of whose initials created it) to continue, or requests "next available branch name" under their own initials to create new** | Preserves the collaborative, no-ownership model at the selection level even though creation numbering is per-user (see increment row above). |
| **Branch status tracked in local DB (`active` / `deleted`)**, validated by **on-demand GitHub API check** — not a standing poll or webhook | Checked at two points: (1) when rendering a repo's active-branch list, (2) at session start before work begins. If GitHub reports the branch missing, mark `deleted` in the DB immediately, exclude from the list and from "next available" numbering. Avoids standing background-job infrastructure; trade-off is a bounded staleness window between renders, which self-corrects on next view and never affects an in-flight write since it's re-checked at session start. |
| AI never force-pushes; on non-fast-forward, fetch and retry against current remote state or fail loudly | Engineers push directly to the same DEV branch — a force-push would silently destroy manual work with no error |
| Spec / Communication Protocol doc **auto-generated specifically when the branch's code exposes an API surface and no protocol doc currently reflects it**, regenerated from full current branch state (not diff-only), committed as a file inside the DEV branch | Must reflect the cumulative API surface across multiple sessions/contributors; travels with the code into TEST and the eventual PR. Distinct from the requirements log below — this one is agent-authored from code analysis, not user-authored. |
| **User requirements log**: separate MD file per branch, append-only, organized under a heading per CO number | **Distinct artifact from the Spec/Communication Protocol doc above**, confirmed. Raw chronological record of what was asked, authored from user input. If the file doesn't exist yet on the branch, create it; if it exists, append a new section under the current CO's heading rather than overwriting. |
| **Active-branch list: CO-filtered first, ownership as a secondary toggle, sorted/filterable by CO number** | Once a CO is entered, show every active branch matching it across all users, owner badge on each, with a mine/others toggle (or tab — implementation detail, either is fine) as a secondary filter inside that view. Ownership is not the primary split; CO match is, so an existing same-CO branch surfaces regardless of who created it, before a user chooses to create new. Default list sort is by CO number; a CO filter/search box is available independent of entering a CO to create against. Sort can be plain lexicographic string sort — safe only because CO format is fixed-length (`C` + exactly 8 digits per `^C[0-9]{8}$`); if that format ever becomes variable-length, lexicographic sort will silently misorder and this needs revisiting alongside the regex. |
| **Model backend for prototyping: NVIDIA NIM at `https://integrate.api.nvidia.com/v1`, `MODEL=meta/llama-3.1-70b-instruct`**, both as config values (`NVIDIA_BASE_URL`, `MODEL`) | Confirmed: model swaps *within* the NIM catalog are config-only. Swapping to a different API shape (Anthropic, OpenAI direct, self-hosted) is explicitly allowed to require a code change — the requirement is that the adapter interface isolates provider-specific details (auth, request/response shape, tool-calling schema) so that a future switch is a contained change inside the adapter, not a rewrite touching agent logic elsewhere. |
| **Pipeline execution decoupled from the live browser session** — once requirements are submitted/approved, a background worker processes the job independently; user does not need to keep the tab open | Requires a job queue + worker process (not just extending an HTTP session timeout). Completion is surfaced via a status flag on the session, tied to its branch, checked when the user next views that repo's branch list (Phase 2 UI) — no separate notification channel (email/push) is needed. |
| **Each user gets their own session against a shared branch; sessions are visible to other users on that branch, not merged into one queue** | Revises the earlier "single merged pending list" design. A submits requirements 1,2,3 in her session; B can see that. When B later submits his own session with 3,4, the agent diffs B's ask against what's already implemented and flags overlap — but does **not** auto-resolve it. |
| **On detected duplicate/overlap with already-implemented work, the agent pauses and requires the submitting user to confirm or override before proceeding** — no auto-skip | Confirmed. Duplicate detection here is a semantic judgment call by the LLM, not a deterministic match — it can misjudge in both directions (missing a real duplicate, or wrongly flagging two different asks as the same). Auto-skip on a wrong judgment silently drops a real requirement with no visibility; pausing for confirm/override puts a human in the loop at exactly the point the AI's judgment is least reliable, consistent with how this roadmap already treats CO validity, branch reuse, and spec staleness — all backstopped by human review, not system certainty. Only item 4 proceeds without prompting in the example; item 3 waits on B's confirmation. |
| Trunk-based branching, `main` as production-equivalent | Confirmed, no longer an open question. |

## Accepted risks (explicit — for your own audit trail)

1. **CO validity is not system-enforced against the change-control system.** Format is now validated (`^C[0-9]{8}$`), which catches typos in shape but not invalid or non-existent CO numbers. Mitigation remains multi-stage human review (DEV, TEST, PR) — format validation is not a substitute for that.
2. **Branch reuse decision is human judgment, not system-derived state.** The app shows metadata (last touched, open PR) but does not know for certain whether a CO has shipped. Wrong calls are possible.
3. **Spec doc can go stale silently.** A human editing the DEV branch directly, without triggering an AI session, will not regenerate the spec doc. Nothing currently detects or flags this.
4. **Audit log is an internal engineering record, not a Part 11-controlled electronic record.** This is only appropriate because the AI sits outside the regulated approval chain — if that scope ever expands (e.g., the AI is later given PR or merge authority), this needs to be revisited with QA/RA.
5. **Branch-deletion detection has a bounded staleness window, not none.** Since existence is checked on-demand (branch-list render, session start) rather than via standing poll/webhook, the DB can show a branch as `active` between checks even though it was deleted on GitHub. This self-corrects the next time anyone views that repo's branch list or starts a session against it, and never reaches an in-flight write, since session start re-checks before work begins. Acceptable given usage patterns; would need revisiting if branches are deleted and immediately re-referenced by a second user before anyone reloads the list.
6. **Two living documents per branch (requirements log + Spec doc) can drift from each other.** They're updated by different triggers (every session appends to the log; the Spec doc regenerates from branch state, and only when an API surface is detected). If someone edits the branch outside an AI session, the requirements log won't reflect that change either — same underlying gap as risk #3, now duplicated across two files instead of one.
7. **Parallel per-user branches on the same CO are a deliberate, accepted design choice, not an oversight.**
8. **Duplicate/overlap detection between users' sessions is a semantic judgment, not a guarantee.** The agent can misjudge in either direction — missing a real duplicate, or wrongly flagging two distinct asks as the same. The confirm/override pause (Phase 3) is the mitigation: a human always makes the final call before an item is skipped or proceeds, so a wrong LLM judgment gets caught rather than silently executed. Because branch-creation increments are scoped to `(initials, co_number)` rather than `(repo_id, co_number)`, two users can independently create a `-1` branch for the identical CO. Whether to coordinate and share one branch, or work in parallel and resolve conflicts at TEST/PR time, is confirmed as a human decision outside this tool's scope — consistent with the existing scope boundary that everything downstream of DEV (including conflict resolution) is human-owned. The tool's only obligation is to surface existing active branches for that CO clearly enough, at the point of choice, that the decision is actually informed rather than accidental — burying that information in the UI would undermine this being a real choice.

## Data model (Phase 0)

- `users` — includes stored `initials` field for branch naming
- `orgs`
- `repo_groups`
- `repos` — includes `default_branch_name` (do not hardcode `main`/`master` assumption globally; store per repo)
- `user_repo_group_permissions`
- `change_orders` — unique constraint on `(repo_id, co_number)`, status tracking
- `branches` — unique on `(repo_id, initials, co_number, increment)`, status enum (`active`/`deleted`), last-checked timestamp
- `sessions` — add `status` (`queued`/`running`/`completed`/`failed`) and `completed_at`, decoupled from any live HTTP connection; scoped per user per branch, not merged across users
- `session_requirements` — per session, `content`, `submitted_at`; each item can carry an `overlap_flag` referencing an earlier session/item it was judged to duplicate, plus resolution status (`pending_confirm`/`confirmed_proceed`/`confirmed_skip`)
- `conversations`
- `audit_log` — user, repo, CO, raw instructions, Q&A history, timestamps

## Phases

**Phase 0 — Foundations**
- Schema above, including `branches` table and per-user `initials`.
- Auth: username/password, bcrypt/argon2, server-side sessions.
- `Makefile` with an initial-setup target (create the database, apply the schema, seed anything required to run locally).
- `SETUP.md` documenting the exact steps to go from a clean checkout to a running local environment (prerequisites, env vars, `make` targets to run and in what order).

**Phase 1 — Platform integrations**
- GitHub App: org-wide install, `contents: write` only, scoped to DEV-branch pattern. Private key in a secrets manager. Token-minting service issues short-lived tokens on demand, never persists them.
- Model adapter interface (see `agent-prompts.md`) so the model backend is swappable.

**Phase 2 — Repo/branch selection & resolution**
- User selects a repo. Before rendering the active-branch list, check each candidate branch against GitHub; mark any missing branch `deleted` in the DB and exclude it from the list.
- Branch list also surfaces the status of the current user's own session on each branch (`queued`/`running`/`completed`/`failed`) — this is how a user finds out a background job finished after stepping away, with no separate notification channel.
- User enters CO number — validated against `^C[0-9]{8}$` format only, no external system check.
- User chooses: continue on any existing active branch (any user's), or request the next available branch name under their own initials (`dev/{initials}-{CO}-{n}`, next unused `n` for that user+CO pair).
- New branch is cloned from `main`.
- Lock acquired on `(repo_id, co_number)` for the full pipeline.

**Phase 3 — Clarification loop**
- On an existing branch, agent summarizes current diff + relevant `audit_log` history before taking new instructions.
- LLM-driven Q&A against repo context via GitHub API. Every exchange written to `audit_log`.
- Requirements are scoped to the submitting user's own session, not merged into a shared branch-wide list. Other users' sessions on the same branch are visible for context.
- Before proceeding, the agent checks new requirements against already-implemented work on the branch. Any item judged a likely duplicate is flagged and the session **pauses** for the submitting user to confirm ("still want this addressed") or override (skip it) — no auto-skip. Only non-overlapping items proceed without prompting.

**Phase 4 — Sandboxed execution**
- Ephemeral, network-isolated container. Clone via a scoped, clone-only token — the write-capable token never enters the sandbox.
- Declarative per-repo build/test config.
- Fetch-and-retry (never force-push) on non-fast-forward.
- **Branch-existence check on session start**: verify the target branch still exists on GitHub before beginning work; if not, mark `deleted` in the `branches` table and halt with a clear error rather than pushing into a stale branch name. This is the second of the two on-demand checkpoints (the first being branch-list render in Phase 2) — no standing poll or webhook.
- **Runs as an async background job**, not tied to the initiating browser session. A worker processes the pipeline once requirements are approved (including any overlap confirm/override); `sessions.status` moves `queued` → `running` → `completed`/`failed` independent of whether the user's tab is open. Since sessions are per-user, the branch-level lock still serializes execution one session at a time.

**Phase 5 — DEV branch delivery**
- Push/update DEV branch. No PR, no merge.
- Regenerate and commit the Spec/Communication Protocol doc from full branch state, at a CO-number-keyed path.
- Append user requirements to the branch's requirements log MD file under a heading for the current CO; create the file if it doesn't exist.
- Downstream (TEST, PR-to-main) explicitly out of scope for this tool.

**Phase 6 — Access administration**
- Admin UI for `user_repo_group_permissions`, itself audit-logged.
- Admin UI for setting/editing user `initials`.

**Phase 7 — Observability & hardening**
- Deletion detection is handled inline (Phase 2 list-render + Phase 4 session-start checks) — no standing job to build or monitor here. If usage patterns later show the staleness window in Accepted Risks #5 causing real collisions, revisit toward a webhook.
- Alerts on blocked-allowlist attempts.
- GitHub App key rotation process.
- Lock-contention dashboard on `(repo, CO)`.
- Written internal note on the human-judgment-reliance philosophy (accepted risks above), so it's on record rather than discovered later.

## Still open (not blocking Phase 0)

None currently — all items raised through this round of revisions are reflected as confirmed decisions above. Anything new (e.g. specific per-repo build/test config format, admin-UI details for Phase 6) will get added here as it comes up.
