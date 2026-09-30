# Why this project leans on human judgment, not AI judgment

This is the internal note referenced from ROADMAP.md's "Regulatory context" section.
It is not regulatory or compliance guidance — QA/RA sign-off on Apex's use is a
separate process this document doesn't substitute for.

## The scope boundary that makes this workable

Apex's AI agent produces exactly one artifact: a DEV branch. It never opens a pull
request and never merges (see `pushService.js` — the pipeline's last step is a plain
`git push` to the DEV branch, nothing more). Everything after that — code review, the
TEST branch, the PR, the merge to `main` — is a human-driven process that already
existed before Apex and that Apex does not touch.

Because of that boundary, the AI sits *outside* the change-control system's formal
approval chain. Every judgment call that actually matters to release quality or
regulatory posture is still made by a person, through the same process as before.
Apex's job is narrower: help a human get to a DEV branch faster, with the human
checking its work at defined points along the way rather than trusting it end to end.

## Where a human, not the AI, makes the call

- **CO validity.** `branchService.isValidCoNumber` enforces the *shape*
  (`^C[0-9]{8}$`) — it has no connection to the actual change-control system, so it
  catches typos, not invalid or fabricated CO numbers. Whether a CO is real and
  applies to this work is a human judgment, unchanged from before Apex existed.
- **Branch reuse.** The branch list shows metadata (last touched, CO number) but Apex
  has no notion of "has this CO already shipped" — a human decides whether to
  continue an existing branch or start fresh.
- **Overlap / duplicate detection.** `overlapService.js` is explicitly a heuristic: it
  asks the model whether a new requirement duplicates already-implemented work, but
  the result only ever *pauses* the clarification loop (`session_requirements.
  pending_confirm`) for the submitting user to confirm or override
  (`app/routes/repos.js`'s confirm/skip routes). Nothing is ever auto-skipped on the
  model's say-so — see ROADMAP.md's accepted risk #7. The model can misjudge in
  either direction; the human's confirm/override is the actual control, not the
  model's answer.
- **Approve & Implement.** Even after every requirement is clarified and any overlap
  resolved, nothing runs until a human explicitly clicks Approve & Implement (Phase 8)
  — and that approval is never "locked in": adding a requirement after approval but
  before the worker picks the session up automatically drops it back to
  `awaiting_approval` (`clarificationService.js`'s `finalizeRequirement`), forcing a
  fresh explicit approval rather than silently expanding scope under an old click.
- **Parallel branches per CO.** Two engineers can each hold their own `-1` branch for
  the same CO (branch naming is scoped to `(initials, co_number)`, not shared) — a
  deliberate design choice (accepted risk #6), not an oversight, that keeps Apex from
  ever having to arbitrate whose work is authoritative.
- **Everything past the DEV branch.** TEST, PR, and merge to `main` are entirely
  outside Apex, using whatever review process already governs that repo.

## What this does and doesn't reduce

Because the AI never gets review, PR, or merge authority, Apex materially reduces (but
does not eliminate) exposure to electronic-record/signature requirements and
segregation-of-duties concerns *for Apex itself* — those requirements still fully
apply to whatever already governs the TEST → PR → main process today, unchanged. If
Apex's scope ever expands to include PR creation or merge authority, this reasoning
needs to be revisited with QA/RA before that ships, not after — see ROADMAP.md's
accepted risk #4 on the audit log's own limited evidentiary status for the same
reason.
