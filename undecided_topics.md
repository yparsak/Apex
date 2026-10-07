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

## Existing-branch Discovery (Phase 18)

Phase 18 is built — CO entry now lands on a discovery page (`/repos/:repoId/co/:coNumber`)
listing matching GitHub refs, with adopt / continue / create-at-next-free-increment. Both
of the phase's open questions were resolved while building it (intermediate page; and
soft-deleted-but-still-on-GitHub branches are shown, labelled, non-adoptable). Still open:

- **Initials wider than the discovery matcher** — Phase 2's Initials admin accepts
  `^[A-Z0-9]{1,10}$` while the discovery matcher is `[A-Za-z]{2,3}`, so branches created
  for a user whose initials contain a digit or aren't 2–3 letters won't appear on the CO
  page. Nothing breaks (increments still count from Apex's own rows, and the branch stays
  continuable from the repo page), but the two formats should converge — which means
  deciding what to do about existing non-conforming `users` rows.

## Large-file Write Safety (Phase 19)

Phase 19 is built — truncation is announced to the model, `finish_reason: 'length'` is
treated as a failed turn, a whole-file write against anything less than a full read is
refused, and the shared caps moved into `app/lib/repoContext.js`. Still open:

- **Whether a tree-fetch failure should still proceed.** `repoContext.fetchTree` swallows
  every error and returns an empty path list, so a GitHub blip runs codegen with
  `(tree unavailable)` — no repo structure at all — and codegen still runs. Phase 19
  reduced the consequences rather than deciding the question: an empty tree is marked
  incomplete, so writes to files the model hasn't explicitly fetched are all refused.
  Going further means changing Phase 7's failure semantics for the step, which wasn't in
  this phase's scope.
- **Codegen cannot edit a file over `MAX_FILE_CHARS` (8,000) at all** until Phase 21
  replaces whole-file-replace with ranged writes. This is intended, not a defect — the
  alternative is silent deletion — but it is a real capability gap. Phase 20 made it
  visible to the model up front (the tree marks such files by name and size) rather than
  a surprise mid-run, but it did not narrow the gap itself.

## Size-aware Repo File Map (Phase 20)

Phase 20 is built — `app/lib/repoMap.js` renders a ranked, size-annotated file map,
honors GitHub's `truncated` flag, states what it excluded and omitted, and caches per
`(repo_id, commit_sha)` in `repo_file_maps`. Line counts ship inferred from byte size
(`BYTES_PER_LINE = 40`, rendered with `~`), as the phase's first open question leaned.
Still open:

- **Whether exclusion rules should be global or per-repo.** Shipped global — a fixed set
  of directory, filename, and extension rules in `repoMap.js`. Per-repo (an
  `apex.pipeline.json` key) is clearly more correct for a monorepo and clearly more
  config surface, and `apex.pipeline.json` staying plain JSON is a standing Stack
  decision. A monorepo whose relevant code sits under a path the global rules exclude
  will force this.
- **Exact line counts.** The byte-derived estimate is adequate for the "can I work with
  this file?" judgment the model makes with it, but it is wrong by a wide margin for
  unusual files. Exact counts need every file's content, which is the cost the map exists
  to avoid — Phase 21's container pass is the natural place to produce them.
- **The map's pure logic is unexercised.** Selection, ranking, and rendering have no test
  coverage and were not run (no test runner in the repo; no Node runtime in the
  implementing session). A harness over a synthetic large tree is the obvious first
  check.
- **Whether `specDocService.KEY_FILES` becomes map-driven.** The map makes it possible,
  and a thin Spec/Communication Protocol doc for a large repo is the symptom it would
  fix, but it changes generated doc content — deferred to Phase 15's own review.

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
