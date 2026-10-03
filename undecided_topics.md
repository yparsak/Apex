# Open / Undecided Topics

Compiled from [ROADMAP.md](ROADMAP.md) and [README.md](README.md). README.md is purely
operational (setup/run/logs) and contains no open questions — everything below comes from
ROADMAP.md.

Note: several items listed as "open" within a phase's description were subsequently closed
by that same phase's "Implementation notes" (e.g., Phase 12's log-file-per-process question,
all three Phase 13 opens). Those are resolved and excluded here. ROADMAP.md's "Accepted
risks" section is also excluded by design — it's explicitly called out as settled trade-offs,
not open questions.

## Deployment & Infrastructure

- **Deployment target** — explicitly "not decided — out of scope for this roadmap" (Stack
  decisions section).
- **Spec/Communication Protocol cron interval & mechanism** — decoupled from `worker.js`
  into a separate scheduled script (Phase 8), but the actual interval and whether it's host
  cron/systemd vs. something container-native is unresolved, pending the deployment-target
  decision above.

## Container/Pipeline Lifecycle

- **Idle/abandoned kept-alive containers** — a failed session's container is kept alive for
  resume-from-step retry, but there's no timeout-based cleanup for one that's never retried
  and never explicitly abandoned (Phase 7 / Open-future).
- **Branch-head staleness check on resume-from-step retry** — whether a resume attempt
  should re-verify the DEV branch head hasn't moved (another engineer pushing directly)
  before trusting cached state; current behavior skips this check by default (Phase 9 /
  Open-future).

## Logging & Observability

- **Operational logs vs. pipeline-run logs cross-referencing** (Phase 12) — whether to add a
  `runId` field linking structured app logs to `pipeline_runs.build_log`/`test_log`.
  Currently kept separate "unless that proves awkward in practice" — a provisional, not
  final, decision.

## Usage/Cost Reporting & Model Provider (Phase 14 — not yet built)

- Whether the circuit breaker should lock at **pipeline entry** (before `worker.js` starts a
  run) in addition to the per-call-site check in `modelAdapter.js`.
- **Recovery semantics** for a locked provider — auto-expiry (e.g., on a daily quota reset)
  vs. requiring manual admin "clear lock."
- Whether **"credits"** stays a pure reporting label or becomes an actual allocated budget
  per org/repo-group later.
- The exact **warning threshold** (e.g., 80% of quota) before flipping provider health to
  `warning`, contingent on whether a hard quota is even knowable for the given provider.

## Platform Extensibility (carried forward from notes.md, unscheduled)

- **SSO** — `authProvider` interface supports it, but no second provider is implemented.
- **Non-NIM model provider** — adapter interface isolates this, but a differing
  request/response shape is unexercised.
- **Branch-deletion staleness window** — on-demand GitHub-existence checks are accepted for
  now; a webhook-based approach is deferred unless real collisions show up in practice.
- **Richer per-repo pipeline config format** — `apex.pipeline.json` stays plain JSON unless a
  real need emerges.
