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
- ~~**Codegen cannot edit a file over `MAX_FILE_CHARS` (8,000) at all.**~~ **Closed by
  Phase 21.** `REPLACE_LINES` edits a file of any size up to
  `MAX_CONTAINER_FILE_BYTES` (2 MB) without restating the parts the model hasn't seen.
  The Phase 19 guard is unchanged and still refuses whole-file writes on a partial read
  — what changed is that the refusal now points at a route that works.

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
- ~~**Exact line counts.**~~ **Closed by Phase 21** for any commit a codegen run has
  processed: the container pass measures them, `renderMap` prefers them per file, and
  `BYTES_PER_LINE` now applies only where the index doesn't reach. Not closed
  everywhere — a repo with no successful pipeline run still renders estimates, by
  design.
- ~~**The map's pure logic is unexercised.**~~ **Closed by Phase 21.** `renderMap` is
  now covered by the harness described under Phase 21 below, including the no-index
  fallback and the exact/estimate mix. Selection and ranking (`isExcluded`, `rankOf`,
  `selectEntries`) remain unexercised — the harness covers rendering only.
- **Whether `specDocService.KEY_FILES` becomes map-driven.** The map makes it possible,
  and a thin Spec/Communication Protocol doc for a large repo is the symptom it would
  fix, but it changes generated doc content — deferred to Phase 15's own review.

## Structural Index & Ranged Reads/Anchored Writes (Phase 21)

Phase 21 is built — `app/lib/structuralIndex.js` builds exact line counts and a per-file
outline from one `awk` pass over the sandbox's clone, codegen reads from the container
rather than GitHub, and `REPLACE_LINES` applies anchor-verified ranged writes. Outline
extraction shipped as the cheap regex pass the phase's first open question leaned
toward, treated as navigation hints rather than ground truth. Still open:

- **Whether `overlapService` should read the index.** Unchanged in this phase, as
  planned. It still works from `compareCommits` patches under `MAX_DIFF_CHARS` /
  `MAX_PATCH_CHARS_PER_FILE`, and overlap on a 3,000-line file is exactly where line-
  range data would sharpen the judgment. The most obvious second consumer, still
  unbuilt.
- **Whether the outline should ever become a real parse.** Shipped as regex. The pass
  is honest about being wrong at the margins and nothing downstream trusts it, so the
  cost of a miss is a wasted read. Revisit only if transcripts show the model actually
  misled by it — a per-language toolchain in the sandbox image conflicts with Phase 7
  keeping that image minimal and user-owned.
- **No ranged-write path outside codegen.** Clarification got ranged *reads* but has no
  container, so its outlines are whatever an earlier codegen run happened to leave for
  the same commit, and a repo with no successful run has none. Accepted — the deeper
  data is only needed where a container exists — but it does mean clarification quality
  silently varies with pipeline history, which is a slightly odd coupling.
- **Clarification's ranged reads are capped twice.** The GitHub read is clipped at
  `MAX_FILE_CHARS` before the range is sliced, so a range beyond ~8,000 characters into
  a large file reads as past the end of the file. Codegen has no such ceiling. Fixable
  only by giving clarification an uncapped read path, which reopens why the cap exists.
- **The index is never invalidated, only missed.** Keyed by `(repo_id, commit_sha)` like
  the map, so a moved branch misses rather than serving stale data, and `pruneUnused`
  retires the whole row. There is no partial refresh for files a session created mid-run
  — those simply have no outline until the next commit's index is built.
- **Exercised, but not end-to-end against a live pipeline.** 52 checks run green across
  two harnesses (see Phase 21's implementation notes in [ROADMAP.md](ROADMAP.md)),
  covering the pure logic, the awk pass under three awk implementations, the container
  read shell against a real container, and the whole codegen loop with a stubbed model.
  What has *not* run is a real session: real NIM replies, a real clone, a real push.
- **`MAX_ANCHOR_LINES = 300` and `MAX_RANGE_LINES = 400` are judgment calls**, not
  measured. They are comfortably larger than any single edit should need and
  comfortably smaller than "restate the file", which is the property that matters, but
  nothing has yet pushed on them.

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
