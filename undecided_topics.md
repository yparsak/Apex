# Open / Undecided Topics

Compiled from [ROADMAP.md](ROADMAP.md) and [README.md](README.md). README.md is purely
operational (setup/run/logs) and contains no open questions — everything below comes from
ROADMAP.md.

Note: several items listed as "open" within a phase's description were subsequently closed
by that same phase's "Implementation notes" (e.g., Phase 12's log-file-per-process question,
all three Phase 13 opens). Those are resolved and excluded here. ROADMAP.md's "Accepted
risks" section is also excluded by design — it's explicitly called out as settled trade-offs,
not open questions.

## Container/Pipeline Lifecycle

- **Idle/abandoned kept-alive containers** — a failed session's container is kept alive for
  resume-from-step retry, but there's no timeout-based cleanup for one that's never retried
  and never explicitly abandoned (Phase 7 / Open-future).
- **Branch-head staleness check on resume-from-step retry** — whether a resume attempt
  should re-verify the DEV branch head hasn't moved (another engineer pushing directly)
  before trusting cached state; current behavior skips this check by default (Phase 9 /
  Open-future).

## Usage/Cost Reporting & Model Provider (Phase 14)

Phase 14 is built — reporting dashboard at `/admin/usage`, `usage_events` logging, and a
DB-backed circuit breaker in `modelAdapter.js`. Recovery semantics were resolved to
manual-only (admin "clear lock" action, no auto-expiry — see ROADMAP.md Phase 14
implementation notes). Still open:

- Whether **"credits"** stays a pure reporting label or becomes an actual allocated budget
  per org/repo-group later.
- The exact **warning threshold** (e.g., 80% of quota) before flipping provider health to
  `warning`, contingent on whether a hard quota is even knowable for the given provider —
  `warning` is schema-supported but nothing sets it automatically yet.

## Platform Extensibility (carried forward from notes.md, unscheduled)

- **SSO** — `authProvider` interface supports it, and Phase 17 decided provider
  selection (`AUTH_PROVIDER` env var) and the authorization model (local `users` row by
  id match, no group-claim gating) ahead of time, but no second provider is implemented
  yet.
- **Non-NIM model provider** — adapter interface isolates this, but a differing
  request/response shape is unexercised.
- **Branch-deletion staleness window** — on-demand GitHub-existence checks are accepted for
  now; a webhook-based approach is deferred unless real collisions show up in practice.
- **Richer per-repo pipeline config format** — `apex.pipeline.json` stays plain JSON unless a
  real need emerges.
