# Phase 3 manual testing

Phase 3 adds the clarification loop: a per-user, per-branch `sessions` row
that summarizes branch state before taking instructions, runs a free-text
Q&A exchange against the model adapter, finalizes a discrete requirements
list, checks new requirements for likely overlap with already-agreed work on
the same branch, and pauses for human confirm/override on anything flagged.
See `roadmap.md`'s "Phase 3 — Clarification loop" section for the scope this
implements, and `agent-prompts.md`'s "Phase 3" section for the system-prompt
strategy, response-parsing convention, and audit-log semantics behind it.

Because this phase talks to a real LLM, replies are not scripted or
deterministic — the exact wording of a clarifying question, or exactly how
many turns it takes before the model finalizes, will vary run to run. The
tests below tell you what to send and what shape of thing to expect back,
not an exact string to diff against.

## Prerequisites

1. Everything from `Phase1_test.md` and `Phase2_test.md` — a running app, a
   seeded org/repo group/repo/permissions, two registered users
   (`jdoe`/initials `JD` and `asmith`/initials `AS`), a working GitHub App,
   and a working model adapter
   (`MODEL_PROVIDER=nvidia-nim` with a valid `NVIDIA_API_KEY`, or your own
   adapter). Phase 3 makes real `chat()` calls — Test 1 in `Phase1_test.md`
   is worth re-running first if it's been a while since you confirmed the
   model adapter works.
2. **No new `.env` variables and no new npm dependencies are introduced in
   Phase 3** — it reuses the Phase 0–2 config and the existing model adapter
   and GitHub App token service as-is.
3. **No schema changes.** Phase 3 uses the `sessions`, `session_requirements`,
   `conversations`, and `audit_log` tables exactly as `db/schema.sql` defined
   them in Phase 0 — nothing to re-apply.
4. A resolved branch to test against. If you don't already have one from
   Phase 2 testing, resolve one now (see `Phase2_test.md` Test 3):

   ```
   curl -s -b jdoe.cookies.txt -X POST http://localhost:3000/api/repos/<repo_id>/resolve \
     -H 'Content-Type: application/json' \
     -d '{"coNumber":"C20000001","action":"create"}' | json_pp
   ```

   Note `data.branch.id` (`<branch_id>` below) — you'll need it for every
   session URL. **Do not call `/resolve` again for this `(repo, CO)`** once
   it succeeds — the pipeline lock it acquires is only released on failure
   (Phase 2) or full-pipeline success (Phase 5, which doesn't exist yet), so
   a second `/resolve` call will 409 until you manually clear the lock (see
   `Phase2_test.md` Test 5). This is exactly why Phase 3's session routes
   below never touch `pipeline_locks` — once a branch is resolved, reopening
   its clarification loop is a plain `POST .../sessions` call, not another
   `/resolve`.

The branch itself should have some actual content worth summarizing/diffing
— push a small commit or two to it directly on GitHub before Test 1 if you
created it fresh and want the start summary to have something to describe
beyond "no differences yet."

## Test 1 — start a session: diff + history summary

```
curl -s -b jdoe.cookies.txt -X POST \
  http://localhost:3000/api/repos/<repo_id>/branches/<branch_id>/sessions | json_pp
```

**Success looks like:** `data.session.status` is `"running"`,
`data.conversations` has exactly one entry with `role: "assistant"` — the
start summary — whose `content` is a few sentences describing the current
diff against the repo's default branch and any prior recorded discussion for
this CO (there won't be any yet, on a brand-new CO). `data.requirements` is
`[]` and `data.otherSessions` is `[]`. Note `data.session.id` (`<session_id>`
below).

Repeat the exact same call again:

```
curl -s -b jdoe.cookies.txt -X POST \
  http://localhost:3000/api/repos/<repo_id>/branches/<branch_id>/sessions | json_pp
```

**Success looks like:** the same `session.id` comes back (resumed, not
recreated) and `data.conversations` still has exactly one entry — the
summary is generated once per session, not regenerated on every resume (see
`agent-prompts.md`'s Phase 3 section / `sessionService.js`'s
`startOrResumeSession` comment).

Check the DB:

```sql
SELECT id, status FROM sessions WHERE branch_id = <branch_id>;      -- one row, status='running'
SELECT role, LEFT(content, 60) FROM conversations WHERE session_id = <session_id>;  -- one 'assistant' row
SELECT raw_instructions, LEFT(qa_history, 60) FROM audit_log WHERE co_number = 'C20000001';
```

**Success looks like:** the `audit_log` row has `raw_instructions` **NULL**
(this was a system-triggered call, not a user instruction) and `qa_history`
populated with the model's summary text.

## Test 2 — clarifying Q&A exchange

Send an intentionally vague instruction so the model has something to ask
about:

```
curl -s -b jdoe.cookies.txt -X POST \
  http://localhost:3000/api/repos/<repo_id>/branches/<branch_id>/sessions/<session_id>/messages \
  -H 'Content-Type: application/json' \
  -d '{"message":"Add better error handling to the API."}' | json_pp
```

**Success looks like:** `data.finalized` is `false` and `data.reply` is a
plain-text clarifying question or comment (no fenced code block) — the model
judged it doesn't have enough information yet. If instead it finalizes
immediately (`data.finalized: true`), that's also valid behavior for this
convention (the model decided "better error handling" was concrete enough)
— skip ahead to Test 3's checks using whatever it returned.

Confirm the transcript grew:

```
curl -s -b jdoe.cookies.txt http://localhost:3000/api/repos/<repo_id>/branches/<branch_id>/sessions/<session_id> | json_pp
```

**Success looks like:** `data.conversations` now has 3 entries in order —
the start summary (`assistant`), your message (`user`), and the model's
question (`assistant`).

## Test 3 — finalizing requirements

Answer the question (or, if it already finalized in Test 2, skip to the DB
check below). If it's still asking questions after a couple of replies, you
can push it toward finalizing directly — this is a legitimate use of the
Q&A loop, not a workaround:

```
curl -s -b jdoe.cookies.txt -X POST \
  http://localhost:3000/api/repos/<repo_id>/branches/<branch_id>/sessions/<session_id>/messages \
  -H 'Content-Type: application/json' \
  -d '{"message":"That'"'"'s everything - please finalize the requirements now."}' | json_pp
```

**Success looks like:** `data.finalized` is `true`, `data.reply` contains a
` ```requirements-ready ` fenced block, and `data.requirements` is an array
of objects like `{"id":<id>,"content":"...","resolutionStatus":"confirmed_proceed","overlapFlagRequirementId":null}`
— since this is the first requirement ever submitted on this branch, there's
nothing for it to overlap with, so it should proceed automatically with no
pause (per roadmap.md: "Only non-overlapping items proceed without
prompting").

Check the session flipped to `queued` (see the state-machine comment atop
`sessionService.js`: every requirement left `pending_confirm` and at least
one is `confirmed_proceed`):

```sql
SELECT status FROM sessions WHERE id = <session_id>;   -- 'queued'
SELECT content, resolution_status FROM session_requirements WHERE session_id = <session_id>;
```

This is also **Test — session status transition to `queued`**: nothing
downstream consumes it yet (Phase 4 doesn't exist), so it just sits there —
that's expected, not a bug.

## Test 4 — overlap detection pause + confirm/override

This needs a *second* requirement on the *same branch* that plausibly
overlaps with the one just confirmed. Have a second user continue onto the
same branch. First, clear the pipeline lock left over from Test 3's
prerequisite resolve (same caveat as `Phase2_test.md` Test 5):

```sql
DELETE FROM pipeline_locks WHERE repo_id = <repo_id> AND co_number = 'C20000001';
```

```
curl -s -b asmith.cookies.txt -X POST http://localhost:3000/api/repos/<repo_id>/resolve \
  -H 'Content-Type: application/json' \
  -d '{"coNumber":"C20000001","action":"continue","branchId":<branch_id>}' | json_pp
```

Start asmith's own session on the same branch, then submit a requirement
worded closely enough to the one jdoe already got confirmed that the model
should recognize it as the same ask (adjust the wording below to actually
overlap with whatever jdoe's session finalized in Test 3):

```
curl -s -b asmith.cookies.txt -X POST \
  http://localhost:3000/api/repos/<repo_id>/branches/<branch_id>/sessions | json_pp

curl -s -b asmith.cookies.txt -X POST \
  http://localhost:3000/api/repos/<repo_id>/branches/<branch_id>/sessions/<asmith_session_id>/messages \
  -H 'Content-Type: application/json' \
  -d '{"message":"Please finalize this single requirement now: <wording close to jdoe'"'"'s confirmed requirement>."}' | json_pp
```

**Success looks like:** `data.requirements[0].resolutionStatus` is
`"pending_confirm"` and `overlapFlagRequirementId` is jdoe's earlier
requirement's id. asmith's session should **not** have flipped to `queued`
(check `SELECT status FROM sessions WHERE id = <asmith_session_id>` — still
`running`, since the one requirement it has is still pending).

Duplicate/overlap detection is a semantic LLM judgment, not a guarantee
(roadmap.md Accepted Risk #8) — if the model doesn't flag it as a duplicate
this time, that's a real, expected possibility, not a broken test. Reword to
make the overlap more obvious and retry, or move on; either way, confirm the
**fail-closed** behavior instead by temporarily pointing `MODEL_PROVIDER` at
something that can't respond (or just skip ahead) and checking `Common
errors` below for what an unparseable overlap-check reply produces
(`pending_confirm` with `overlapFlagRequirementId: null`, never an
auto-proceed).

Now resolve it as the submitting user (asmith):

```
curl -s -b asmith.cookies.txt -X POST \
  http://localhost:3000/api/repos/<repo_id>/branches/<branch_id>/sessions/<asmith_session_id>/requirements/<requirement_id>/resolve \
  -H 'Content-Type: application/json' \
  -d '{"resolution":"confirmed_proceed"}' | json_pp
```

**Success looks like:** `data.requirement.resolutionStatus` is
`"confirmed_proceed"`, and asmith's session now flips to `queued` (check the
DB as in Test 3). Try the same call again — it should now fail, since the
requirement is no longer `pending_confirm`:

```
curl -s -b asmith.cookies.txt -X POST \
  http://localhost:3000/api/repos/<repo_id>/branches/<branch_id>/sessions/<asmith_session_id>/requirements/<requirement_id>/resolve \
  -H 'Content-Type: application/json' \
  -d '{"resolution":"confirmed_skip"}'
```

→ HTTP 409, `"Requirement is not awaiting confirmation (current status:
confirmed_proceed)"`.

Confirm **only the submitting user** can resolve it — have jdoe try to
resolve one of asmith's requirements:

```
curl -s -b jdoe.cookies.txt -X POST \
  http://localhost:3000/api/repos/<repo_id>/branches/<branch_id>/sessions/<asmith_session_id>/requirements/<requirement_id>/resolve \
  -H 'Content-Type: application/json' \
  -d '{"resolution":"confirmed_skip"}'
```

→ HTTP 403 (jdoe doesn't even own the session — `GET`/`POST` against
another user's session id returns `"This session belongs to another user"`
before the resolution logic runs at all).

## Test 5 — other-users'-sessions visibility

```
curl -s -b jdoe.cookies.txt \
  http://localhost:3000/api/repos/<repo_id>/branches/<branch_id>/sessions/<session_id> | json_pp
```

**Success looks like:** `data.otherSessions` now contains one entry for
asmith — `{"sessionId":...,"username":"asmith","initials":"AS","status":"queued","requirements":[{"content":"...","resolutionStatus":"confirmed_proceed"}]}`.
This is read-only context (roadmap.md: "visible to other users on that
branch") — there's no endpoint for jdoe to act on asmith's requirement, only
to see it, which Test 4's 403 above already confirmed.

## Test 6 — terminal-session handling

There's no way to reach `completed`/`failed` yet (that's Phase 4/5), so this
can only be checked by hand:

```sql
UPDATE sessions SET status = 'failed' WHERE id = <session_id>;
```

```
curl -s -b jdoe.cookies.txt -X POST \
  http://localhost:3000/api/repos/<repo_id>/branches/<branch_id>/sessions/<session_id>/messages \
  -H 'Content-Type: application/json' -d '{"message":"anything"}'
```

→ HTTP 409, `"This session has already finished and cannot accept new
messages"`.

```
curl -s -b jdoe.cookies.txt -X POST \
  http://localhost:3000/api/repos/<repo_id>/branches/<branch_id>/sessions | json_pp
```

**Success looks like:** a **new** session is created (different `id`) with a
fresh start summary — per the state machine, a terminal session is never
resumed.

## Test 7 — browser click-through

1. Log in as `jdoe` (or `asmith`), navigate to `/repos` → your test repo →
   the branch list.
2. Filter to the CO you used above. The branch row should now show an
   **"Open session"** button/link instead of "Continue" (Phase 2's
   `mySessionStatus` is no longer `null` once Phase 3 has written a
   `sessions` row for this user on this branch) — click it.
3. On `/repos/<id>/branches/<id>/session`, you should see: a status banner,
   the transcript (the start summary as the first bubble), a message
   input/Send button, and an "Other sessions on this branch" panel on the
   right.
4. Type a message and click **Send**. The transcript should grow with your
   message and the model's reply.
5. Keep replying until the model finalizes. A **"Requirements needing your
   confirmation"** panel should appear if anything came back
   `pending_confirm`, each with **Proceed anyway** / **Skip** buttons; a
   **"Resolved requirements for this session"** panel shows anything already
   decided.
6. Click **Proceed anyway** or **Skip** on a pending item — it should move
   from the confirmation panel into the resolved panel, and the status
   banner should update to "queued" once nothing is left pending.
7. Log out, log in as the other user, and open a session on the *same*
   branch. The right-hand panel should list the first user's session,
   status, and requirement text (read-only — no buttons).
8. Navigate back to the branch list for this repo/CO. Confirm the row for a
   branch you already have a session on shows **"Open session"** (a plain
   navigation, no API call) rather than **"Continue"** — clicking "Continue"
   again would hit the still-held pipeline lock and 409, which is why the
   list distinguishes the two states.

## Common errors

| Symptom | Likely cause |
|---|---|
| `Not authenticated` (401) on any `/api/repos/.../sessions*` route | No session cookie — same as Phase 1/2; log in again |
| `Repo not found or access denied` (404) | Same `user_repo_group_permissions` gap as Phase 2 |
| `Active branch not found on this repo` (404) | Wrong `branchId`, the branch belongs to a different repo, or it's been marked `deleted` (Phase 3 does not re-check GitHub for existence — that on-demand check is Phase 2's list-render and Phase 4's session-start check, not this phase's job) |
| `Session not found on this branch` (404) | Wrong `sessionId`, or it belongs to a different branch than the one in the URL |
| `This session belongs to another user` (403) | Every route past start/resume is owner-only; use the owning user's cookie jar, or read the lightweight `otherSessions` list instead (Test 5) |
| `message is required (non-empty, max 8000 characters)` (400) | Empty/missing `message`, or over the length cap |
| `This session has already finished and cannot accept new messages` (409) | Session status is `completed`/`failed`; start a new one (`POST .../sessions`) instead of posting to the old id |
| `Requirement is not awaiting confirmation (current status: ...)` (409) | Trying to resolve a requirement that isn't `pending_confirm` (already resolved, or never flagged) |
| `resolution must be "confirmed_proceed" or "confirmed_skip"` (400) | Any other value in the resolve request body — there is no auto-skip or third option, by design |
| A `pending_confirm` item has `overlapFlagRequirementId: null` | Either the overlap-check reply failed to parse, or the model named an id that wasn't actually offered to it as an existing requirement — both fail closed to `pending_confirm` rather than guessing (see `agent-prompts.md`'s Phase 3 section); check server logs for a `overlap-check reply failed to parse` / `named an unknown duplicateOfRequirementId` warning to tell which |
| Model never emits a `requirements-ready` block | Not a bug — the model decides when it has enough information; keep answering its questions, or explicitly tell it you're done and to finalize (Test 3) |
| `Pipeline lock already held for repo <id>, CO <co>` (409) on `/resolve` | Same Phase 2 behavior — the lock isn't released until Phase 5. If you already have a session on this branch, you don't need `/resolve` again at all; use `POST .../sessions` (or the branch list's "Open session" button) instead |
| `NVIDIA NIM chat request failed (...)` / `fetch failed` | Model adapter misconfigured — see `Phase1_test.md`'s error table |
| `GitHub compare failed (...)` | GitHub App creds wrong, or `repos.default_branch_name` doesn't match the real default branch (see `Phase2_test.md`'s equivalent branch-creation error) |

## What this does and doesn't prove

This proves the full clarification loop end to end against a real model
backend and a real GitHub repo: start/resume reuses a non-terminal session
and generates a diff+history summary exactly once; free-text Q&A continues
until the model finalizes via the fenced-block convention; finalized
requirements are checked for overlap against already-agreed work on the same
branch, with a documented fail-closed behavior on any parse ambiguity; only
the submitting user can confirm/override a paused item; other users' sessions
on the same branch are visible read-only; and a session transitions to
`queued` exactly when the roadmap says it should (and back to `running` if
new pending items show up later).

It does **not** prove anything about what happens to a `queued` session next
— there is no Phase 4 (sandboxed execution) yet, so nothing ever picks a
queued session up, runs a build, or pushes code, and no session ever reaches
`completed` on its own (Test 6 sets `failed` by hand precisely because
nothing else can). There is also no Phase 5 (DEV-branch delivery, Spec doc
generation, requirements-log file) — the `session_requirements` rows
recorded here are Apex's internal record, not yet written anywhere into the
branch itself. Duplicate/overlap detection remains a semantic judgment call,
not a guarantee, exactly as roadmap.md's Accepted Risk #8 describes; this
phase's job is only to make sure a wrong judgment gets caught by a human
rather than executed silently, not to make the judgment itself reliable.
