# NIM Model Integration

How Apex talks to its LLM backend (NVIDIA NIM today), and — the part that matters most
for understanding Apex's behavior — exactly how it decides what repo content to send on
each call. See [SPEC.md](SPEC.md) for where each of these calls fits in the overall
Change Order lifecycle.

## The adapter contract

All model calls go through one function:

```
generate(messages) -> Promise<{ text, usage, provider, model }>
```

`messages` is a standard chat-style array (`{ role: 'system' | 'user' | 'assistant',
content }`). [app/lib/model/modelAdapter.js](app/lib/model/modelAdapter.js) wraps the
current concrete implementation
([nvidiaNimAdapter.js](app/lib/model/nvidiaNimAdapter.js)) with two provider-level
concerns that don't belong in any one call site — no call site imports the NIM adapter
directly, so swapping providers later means changing one `require`, not every call
site:

- **Circuit breaker**: before attempting a call, checks
  [providerHealth.js](app/lib/model/providerHealth.js)'s DB-backed status for the active
  provider and fails fast with a clear error if it's `locked`. After a failed call, a
  quota/billing-shaped error (HTTP 429/402, or a quota/billing/credit keyword in the
  message) locks the provider; a transient network error does not. See
  [SPEC.md](SPEC.md)'s Observability section and `/admin/usage` for the admin-facing
  status + manual "Clear lock" action.
- **Usage passthrough**: `usage` (`{inputTokens, outputTokens}`, parsed off NIM's
  response) and `provider`/`model` are returned alongside `text` so each call site can
  log its own `usage_events` row via
  [usageService.js](app/lib/model/usageService.js) — cost attribution needs
  session/repo context `modelAdapter.js` itself doesn't have, so the actual
  `usageService.recordUsage(...)` call happens at each of the four call sites below,
  not here.

Every call site below now does `const { text, usage, provider, model } =
await modelAdapter.generate(messages)` and uses `text` wherever it used to use the bare
string `generate()` resolved with before Phase 14.

### Configuration

Endpoint credentials come from the environment; **which** model to call does not.

| Env var | Purpose |
|---|---|
| `NVIDIA_BASE_URL` | Base URL, e.g. `https://integrate.api.nvidia.com/v1`. |
| `NVIDIA_API_KEY` | Bearer token. |

`MODEL` and `MODEL_MAX_TOKENS` were removed in Phase 22. Models are now rows in the
`models` table, managed by an admin at `/admin/models`, with per-model `max_tokens` and
pricing — context windows differ per model, so one global `MODEL_MAX_TOKENS` was wrong
for every model but one.

| Model field | Purpose |
|---|---|
| `model_id` | Model name sent to the chat-completions endpoint (e.g. `google/gemma-4-31b-it`). |
| `max_tokens` | `max_tokens` on every request for this model. A reply that hits this limit is **discarded**, not used (see Reliability below), so setting it too low doesn't degrade output quality, it fails turns outright. |
| `price_in_per_1m` / `price_out_per_1m` | $/million tokens, applied at `usage_events` write time. |
| `enabled` / `is_default` | Whether users can select it, and what they get before they pick. |

The catalog ships **empty** and there is no env fallback, so a fresh install has no
usable model: the app locks itself with a "No model available" message (see
`app/lib/appLock.js`) until an admin adds one. Admins are exempt from that lock, or
`/admin/models` would be unreachable from a fresh install.

A model is resolved once per unit of work and **stamped** onto it (`sessions.model`,
`pipeline_runs.model`, `spec_doc_jobs.model`) — never looked up at call time. The worker
picks a session up in a different process minutes later, so looking it up then would let
a user switch models between pipeline turns by changing their selection mid-run.

Which model gets stamped depends on who asked for the work:

| Work | Model used |
|---|---|
| Clarification, overlap, codegen (`apex-worker`) | The requesting user's selection, stamped on the session when it was created. `/resume` reuses the failed run's own model. |
| Spec/Communication Protocol docs (`docWorker.js`) | The **Spec document model** set on `/admin/models`; falls back to the catalog default when unset, or when the configured model has been disabled or deleted. |

### Request/response handling

Every call is a single `POST {NVIDIA_BASE_URL}/chat/completions` with `{ model,
messages, max_tokens }`. Reply text is read from `choices[0].message.content`, falling
back to `choices[0].message.reasoning_content` if `content` is empty — observed
necessary for `moonshotai/kimi-k3`, which sometimes returns its answer in
`reasoning_content` instead. (The `.env.example` also notes that model has an
intermittent bug where it responds with a string of `!!!!` — the default model is
currently set to `google/gemma-4-31b-it` instead.)

`choices[0].finish_reason` is checked on every reply. **`finish_reason: 'length'` means
the provider cut the reply off at `max_tokens` mid-output, and such a reply is thrown
away, never returned** — before Phase 19 it was indistinguishable from a complete one,
so codegen would take a file body ending mid-function and write it verbatim over the
real file.

### Reliability

Up to 3 attempts, exponential backoff (500ms, 1000ms) — but **only for failures that
are plausibly transient.** Nothing about the request changes between attempts, so a
failure caused by the request itself can only be reproduced, and it fails on the first
attempt instead (ROADMAP.md Phase 19):

| Failure | Retried? |
|---|---|
| Network/transport error (no HTTP response at all) | Yes |
| HTTP 5xx, HTTP 408 | Yes |
| **Content failure** — 2xx with both `content` and `reasoning_content` blank | Yes |
| **Any other 4xx** — 400 context overflow, 401, 403, 429 | No — fails fast |
| **`finish_reason: 'length'`** — reply cut off at `max_tokens` | No — fails fast |

Whichever failure ended the loop is what gets thrown — a transport error is never
misreported as "no usable content," and vice versa. `generate()` either resolves with
non-blank, non-cut-off text or rejects; it never resolves with blank/null.

A `400` whose body mentions the context window is reported as *"the request exceeded the
model's context window"* rather than a bare `HTTP 400`, and carries
`err.contextOverflow`. Note it is **not** quota-locking: `providerHealth.js` classifies
only `429`/`402` as tripping the breaker, so a context overflow surfaces as a
step failure naming its real cause and leaves the provider healthy.

## The guiding rule: paths first, content on demand

Apex never bulk-sends a repo's file contents to the model. Every call site that needs
repo awareness follows the same two-step shape:

1. Fetch the **repo file map** — a recursive, blobs-only listing from GitHub's Git Trees
   API (`githubApi.getTreeBySha`), built and cached by
   [app/lib/repoMap.js](app/lib/repoMap.js). This is cheap (one API call) and scales to
   large repos. See "The file map" below for what it contains and how it is selected.
2. Let the **model pull individual files, or spans of them, by path**, on demand, via a
   `FETCH_FILE: <path>` / `FETCH_RANGE: <path>:<start>-<end>` / `FETCH_OUTLINE: <path>`
   directive the model emits mid-conversation. A whole-file read is clipped to **8,000
   characters** (`MAX_FILE_CHARS`); a ranged read returns at most **400 lines**
   (`MAX_RANGE_LINES`), line-numbered.

Since Phase 21 "content on demand" means **ranges** on demand, and that is the more
important half of the rule. A 3,000-line file used to be all-or-nothing — read every
line or none, rewrite every line or none. Now the model reads the file's outline, pulls
the two regions it needs, and leaves the other 2,600 lines out of the context entirely.
The win is not a bigger context window; it is reading less.

**Where the bytes come from differs by call site, and the difference is deliberate:**

| Call site | Reads served from | Why |
|---|---|---|
| Clarification, Spec doc | GitHub, at the branch tip | No container exists yet. Nothing here writes, so a line number cannot go stale mid-conversation. |
| Codegen | **The sandbox container's working tree** | Writes land in the container. A range read from GitHub and an anchored write into the container would drift apart the moment the model makes one edit — it would be reading coordinates from one artifact and writing into another. |

**Clipping is announced, never silent** (ROADMAP.md Phase 19). A complete read is
labelled *"complete file, N lines, N characters"*; a clipped one is labelled
`PARTIAL contents of <path>. This is NOT the whole file.`, states the real file's line
and character totals and the range actually shown, and tells the model that rewriting
the file would delete what it wasn't shown. Previously the model received a bare
`Contents of <path>:` and had no way to know it was looking at 6% of a 3,000-line file —
which, paired with codegen's whole-file-replace protocol, silently deleted the other
94%.

Further read outcomes are distinct rather than collapsed into "not found":

- A file over **1 MB** can't be returned by GitHub's contents API. `getFileContent`
  throws `code: 'file_too_large'` instead of mapping the response's different shape to
  `null`, so the model is told the file *exists but is unreadable* — it used to be told
  the file "was not found," and would then offer to create it from scratch. **Codegen no
  longer hits this at all**, since it reads the local clone; its equivalent ceiling is
  `MAX_CONTAINER_FILE_BYTES` (2 MB).
- A **binary** file — one containing a NUL byte, or one that isn't valid UTF-8 — is
  reported as such rather than read. Container-side only, where the bytes are whatever
  is on disk rather than something the contents API already decided was text. The second
  check matters more than it looks: a latin-1-encoded source file decodes with
  replacement characters, and an anchored write read-modify-writes the whole file, so
  writing it back would commit mojibake over every non-ASCII character in a file the
  model never meant to touch.
- A read that failed for any other reason is reported as a failed read, not an absent
  file.

All of this lives in one module, [app/lib/repoContext.js](app/lib/repoContext.js) —
the caps, the tree fetch, the formatter, and since Phase 21 **the line model** — shared
by every call site. `MAX_TREE_PATHS` and `MAX_FILE_CHARS` used to be declared separately
in `codegenService`, `clarificationService`, and `docService`; the write guard below
is only sound if every reader agrees on exactly where truncation happens.

The line model joined it for the same reason, one phase later: a ranged read hands the
model a line number and an anchored write takes one back, so any two components that
count lines differently will eventually edit the wrong line. (They did differ. Phase 19's
`countLines` was a bare `split('\n').length`, which counts a file's terminating newline
as an extra empty line — so a 231-line file was reported as 232, harmless as prose in a
truncation warning and an off-by-one against the container's own count the moment ranges
existed. A file's last line is the last line with text on it.)

The one deliberate exception is the Spec/Communication Protocol doc generator, which
pre-selects a small fixed set of files instead of letting the model ask (see below) —
everywhere else, file selection is entirely model-driven.

## The file map

Step 1 above used to be literally paths — `paths.slice(0, 500)` joined with newlines.
ROADMAP.md Phase 20 replaced that with a **size-aware map**
([app/lib/repoMap.js](app/lib/repoMap.js)), still from the same single tree call:

- **Every entry carries its byte size**, which GitHub already sends per blob and the old
  code discarded. The tree is rendered as `src/foo.js - 118 KB, ~3,210 lines`, and any
  file over `MAX_FILE_CHARS` is marked `[too large to read in full or rewrite]`. This is
  what makes Phase 19's write refusal predictable instead of surprising: the model sees
  the constraint before it spends a `FETCH_FILE` turn discovering it. Sizes are exact;
  line counts are **estimated** from bytes (`BYTES_PER_LINE`, 40) and rendered with a
  `~`, because exact counts would mean reading every file.
- **Selection is explicit, and what was dropped is stated in the prompt.** Generated,
  vendored, and non-text paths (`node_modules/`, `dist/`, lockfiles, minified bundles,
  images, archives, binaries) are excluded outright; the remainder is ranked — root
  manifests and docs, then source, then tests, then other text config, then everything
  else, shallowest-first within each tier — and the top `MAX_TREE_PATHS` are shown. The
  rendered block ends with a count of what was excluded and omitted and an explicit *"they
  all still exist in the repo"*. A tree that is quietly 500 of 4,000 files reads to the
  model as the whole repo. Exclusion rules are global, not per-repo.
- **GitHub's own `truncated` flag is honored.** `recursive=1` sets it when the API
  response itself was clipped; nothing looked at it before, so an enormous repo produced a
  partial listing Apex presented as complete — and that Phase 19's write guard trusted.
- **What the model sees and what the guard trusts are separate.** The map keeps the
  commit's *entire* blob path list alongside the rendered selection. The write guard asks
  the full list whether a path exists, so narrowing the prompt never widens what a
  whole-file write is allowed to replace. One practical gain: codegen can now create new
  files in a >500-file repo without spending a `FETCH_FILE` turn on each to prove absence.
- **Cached per `(repo_id, commit_sha)`** in `repo_file_maps`, so the three callers in one
  session share one tree call and a repo whose trunk hasn't moved isn't re-walked. A moved
  sha simply misses the cache, so rebuild needs no invalidation step; rows unread for 14
  days are retired by the nightly scanner (see `docScanService.js`). A cache the DB
  can't serve degrades to building the map live — it is a performance store, not a source
  of truth.

## The four call sites

### 1. Clarification — [clarificationService.js](app/lib/clarificationService.js)

Runs once per message the engineer sends in the clarification chat.

**Messages sent:** a system prompt + the file map + (if set) this repo's admin-authored
clarification instructions, as one system message, followed by the **entire
conversation history** for this session (every row in `conversations`, in order).

**What the model can do, each turn:**
- Ask a plain-text clarifying question (ends the turn; shown to the user).
- `FETCH_FILE: <path>` — resolved immediately against GitHub content at the branch tip,
  appended to a scratch copy of the message list, and the loop continues **without**
  surfacing this round-trip in the stored `conversations` transcript. Capped at
  **5 fetches** (`MAX_FILE_FETCHES`) per submitted message; if the model is still
  fetching after 5, Apex falls back to a canned "I wasn't able to gather enough context
  automatically" question rather than looping forever. The cap counts *all* the fetch
  verbs below together.
- `FETCH_RANGE: <path>:<start>-<end>` — the same GitHub read, sliced here rather than
  by the API (the contents API has no range form, so the request cost is identical and
  only the *context* cost differs). Worth more here than in codegen, because this loop
  gets at most five requests for the entire turn. One caveat: the GitHub read is already
  clipped at `MAX_FILE_CHARS`, so a range past that point in a very large file reads as
  past the end of the file and says so. Codegen, reading the container, has no such
  ceiling.
- `FETCH_OUTLINE: <path>` — served from the structural index **if some earlier codegen
  run left one for this exact commit**. Clarification has no container and so cannot
  build one; a repo with no successful run yet is simply told there is no outline, which
  costs a turn and nothing else. See "The structural index" below for why the asymmetry
  is accepted rather than fixed.
- `FINALIZE_REQUIREMENT:\n<restatement>` — ends the clarification loop for this
  requirement and hands the restated text to overlap detection (below).

### 2. Overlap detection — [overlapService.js](app/lib/overlapService.js)

Runs once, automatically, every time a requirement is finalized. Not a loop — one
prompt, one reply.

**What's sent:**
- The branch's diff against the repo's default branch (`githubApi.compareCommits`),
  rendered as per-file patches, each truncated to **2,000 characters**
  (`MAX_PATCH_CHARS_PER_FILE`), concatenated and truncated again to a total of
  **12,000 characters** (`MAX_DIFF_CHARS`).
- Every requirement already `confirmed_proceed` on this branch (not `pending_confirm`,
  not `confirmed_skip` — only work that's actually been judged and is proceeding counts
  as "already implemented").
- The new requirement's finalized text.

**Expected reply:** strict JSON, `{"overlaps": true|false, "matchedRequirementId":
<id>|null}`. Parsing is tolerant — a direct `JSON.parse` first, falling back to a regex
scrape of the two fields if that fails — and **fails open**: if the diff can't be
fetched, there's nothing to compare against, the model call errors, or the reply can't
be parsed at all, the result is simply "no overlap detected." This is intentional (see
[docs/human-judgment-reliance.md](docs/human-judgment-reliance.md)) — overlap detection
is a heuristic that pauses the loop for a human to confirm or override via
"Confirm & proceed anyway" / "Skip — already done"; it never auto-skips, so failing
open here can't cause an unreviewed duplicate to land.

### 3. Codegen — [codegenService.js](app/lib/pipeline/codegenService.js)

Runs once per session, inside the sandbox, after approval. Same system-prompt + tree +
admin-instructions shape as clarification, but the trailing content is this session's
full list of `confirmed_proceed` requirement text (not a conversation to continue), and
the model can now **write**, not just read.

Before the first model turn, codegen builds the **structural index** from the clone (see
below) so the file tree in the system prompt can carry exact line counts.

**What the model can do, each turn (up to 40 turns, `MAX_TURNS`):**
- `FETCH_FILE: <path>` — read whole from **the container's working tree**, clipped to
  `MAX_FILE_CHARS`.
- `FETCH_RANGE: <path>:<start>-<end>` — 1-based inclusive, at most `MAX_RANGE_LINES`
  lines, returned line-numbered. **Deliberately does not count as having read the
  file**: seeing 200 lines of a file is not seeing the file, and letting a range license
  a whole-file write would hand the Phase 19 guard below exactly the false positive it
  exists to prevent.
- `FETCH_OUTLINE: <path>` — the file's declaration lines with their line ranges, from
  the index.
- `REPLACE_LINES: <path>:<start>-<end>` followed by `--- EXPECTED` / `--- REPLACEMENT` /
  `--- END` sections. See "Anchored writes" below.
- `WRITE_FILE: <path>` followed by the file's **complete** new contents (this replaces
  the whole file, not a diff/patch) — rejected if `<path>` has a leading `/` or any
  `..` segment, with the rejection reason sent back to the model to retry. On success,
  streamed into the container via `dockerRunner.writeFile` (stdin, not an argv string,
  so it isn't subject to shell-escaping or `ARG_MAX`) and recorded in the `written` map.
  The payload is normalized to exactly one trailing newline; it used to be `trim()`ed
  along with the rest of the reply, so every file codegen wrote whole landed with
  `\ No newline at end of file` in its diff.

> **Changed in Phase 21 — this section used to say the opposite.** Through Phase 20 the
> rule was *"only `WRITE_FILE` ever touches the container; every read, including of
> files the model itself wrote, is served from an in-memory map or GitHub."* **Both
> halves are now false.** The container builds the index and serves every read; the
> in-memory overlay that existed to make the model's own writes re-readable is gone,
> because reading the actual file makes that case disappear rather than handling it.
> Flagging it explicitly because it read like architecture rather than a changeable
> detail, and anyone reasoning from the old sentence will reach wrong conclusions about
> where a stale read could come from.

  **A write is accepted only against a file the model fully saw** (ROADMAP.md Phase 19).
  `dockerRunner.writeFile` is `cat > "$1"` — a truncating overwrite — so a whole-file
  replace of a file the model only partly read deletes the rest of it. The four grounds
  for accepting a write are exactly the cases where nothing unseen can be lost: the
  model wrote the path earlier this session; it fetched the path and was shown the
  entire file; it fetched the path and the file genuinely doesn't exist (so this creates
  it); or it never fetched the path but the path is absent from a **complete** file map,
  which is equally proof the file is new. Since Phase 20 that last ground checks the
  commit's *entire* blob path list rather than the paths the prompt happened to show, so
  it holds for files the model was never shown — which is why creating a new file in a
  large repo no longer costs a wasted `FETCH_FILE` turn to prove absence. A partial read, a >1 MB file, a failed read, or
  no read at all against a file map we know is incomplete are all refused —
  as a turn fed back to the model, same shape as the unsafe-path refusal, not a pipeline
  failure, so it can route around the file or finish without it.

  **What Phase 21 changed is what a refusal means, not when it fires.** All four grounds
  survive unchanged. But the refusal used to be a dead end — "codegen cannot edit a file
  larger than `MAX_FILE_CHARS`", honest behaviour and still a hard stop. Now every
  refusal points at `REPLACE_LINES`, which edits a file of any size without restating
  the parts the model has not seen. The guard went from "this file is off limits" to
  "not this way."
- A reply the provider **cut off at `max_tokens`** is a failed turn, not a result: the
  truncated text is discarded without entering the transcript, and the model is told its
  reply was cut off and nothing was written, so it can choose a smaller change. Two such
  replies in one run (`MAX_CUT_OFF_REPLIES`) fails the codegen stage — a file too big to
  emit in one reply can't be retried into fitting. Since Phase 21 the nudge names
  `REPLACE_LINES`, because there genuinely is now a smaller way to say the same edit.
- `DONE` — ends codegen. Throws (fails the pipeline at the codegen stage) if the model
  says `DONE` having changed nothing, or if 40 turns pass without a `DONE`.

Immediately after codegen returns, `pipelineRunner.js` runs `git add -A && git commit`
inside the container — so every file the model wrote this turn, not just the ones it
re-fetched, ends up in the commit regardless of whether the model asked to see them
again.

#### Anchored writes — `REPLACE_LINES`

    REPLACE_LINES: app/lib/foo.js:1200-1204
    --- EXPECTED
    <the current contents of exactly those lines>
    --- REPLACEMENT
    <what they should become; empty to delete them>
    --- END

**The problem this solves is an output ceiling, not an input one.** Editing 20 lines of
a 3,000-line file via `WRITE_FILE` costs 3,000 lines of *model output*, and `max_tokens`
cuts the reply off somewhere in the middle. An anchored write costs 20 lines.

**The anchor is the safety property, and it is why this isn't "send a unified diff and
`git apply` it".** The model states the text it believes occupies the lines it is
replacing. If that doesn't match the file, nothing is written and the refusal **quotes
what is actually there**, so the next attempt is self-correcting rather than a loop. A
patch protocol that fuzzes the offset to make a hunk fit is precisely the failure mode
this must not have — the result gets pushed to a real branch under an engineer's CO
number.

The anchor is also *proof the model saw those lines*, which is why a ranged write needs
no prior-read bookkeeping: it cannot touch a line outside its range, or one inside it
without having reproduced it first. Reproducing 20 exact lines by guess is not a
realistic failure mode.

Details worth knowing:

- **Trailing whitespace in `EXPECTED` is tolerated; leading whitespace is not.**
  Indentation is semantic in Python, YAML and Make, so a mismatch there is a real
  disagreement about the file. Trailing whitespace is semantic nowhere and is exactly
  what a model silently drops when restating a line — treating that as a mismatch is how
  you get the anchor-mismatch loop this protocol has to avoid. It's safe because the
  anchor is only ever *evidence*: what gets written is the replacement, never the anchor.
- **Applied host-side**, by reading the whole file out of the container, splicing, and
  writing it back through the same `dockerRunner.writeFile`. Reading a whole file to
  change 20 lines is the right trade because the cost being removed is model output
  tokens, not bytes over a local pipe — and it means verification and write see an
  identical copy, with no in-container editing tool to get an offset wrong.
- **A ranged edit does not license a later `WRITE_FILE`.** It's tracked separately from
  the `written` map and drops whatever read record the model had for that path, since
  every line after the edit has moved.
- **Insertion** is "replace a line with itself plus your new lines"; **deletion** is an
  empty `REPLACEMENT`. An empty `EXPECTED` is rejected outright — an anchorless ranged
  write is a blind write at a guessed offset.
- Several edits to one file should go **bottom-up**, so an earlier edit doesn't shift a
  later one's line numbers. The applied-write reply says so every time.
- A malformed directive is answered with a *specific* parse error, not the generic
  "unrecognized response" — otherwise the model retries the same malformed shape until
  it runs out of turns.

#### The structural index — [structuralIndex.js](app/lib/structuralIndex.js)

Built from **one `exec` pass over the clone Phase 7 already put in the container** — at
zero GitHub API cost and zero token cost, over a working tree nobody was reading. It
yields exact per-file line counts (Phase 20 could only estimate them from bytes) and a
per-file outline of declaration lines with their line ranges.

Extraction is a language-agnostic regex pass in `awk`, assuming only POSIX `sh`, `awk`
and `git` — the sandbox image is the *user's* image and Phase 7 keeps it per-repo and
minimal, so Apex doesn't get to assume a toolchain is installed in it. The file list
comes from `git ls-files`; Phase 20's exclusion rules are applied host-side, so the two
halves of Apex can't disagree about what a listable file is.

**The outline is a navigation hint, not ground truth.** It will miss declarations and
invent a few. Nothing downstream trusts it: ranged reads are addressed by line number
and verified against the file, anchored writes are verified against their anchor, and
neither consults the outline. A wrong outline costs the model a wasted read, never a
wrong write. Index-build failure is logged and the run continues without outlines.

Persisted on the Phase 20 `repo_file_maps` row rather than in a second table, which
introduces one deliberate asymmetry: **the map is available before any pipeline run (it
comes from the GitHub API); the index only from the first successful codegen onward (it
needs a container).** Accepted, because the deeper data is only *needed* where the
container already exists. It is saved only if the container's `HEAD` matches the sha it
would be keyed under — a push landing between the two lookups would otherwise store this
commit's outline under that commit's key, which this run wouldn't notice but a later
clarification would.

### 4. Spec/Communication Protocol doc — [docService.js](app/lib/documents/docService.js)

Runs during `docWorker.js`'s nightly, one-shot cron invocation (see ROADMAP.md
Phase 15), once per repo whose trunk has moved. **The
one call site where file selection is not model-driven**: there's no `FETCH_FILE` loop
here at all. Instead, Apex pre-selects a small fixed allowlist —

```
README.md, package.json, apex.pipeline.json
```

— and includes the content of whichever of those three actually exist in the tree
(each clipped to 8,000 chars, with clipping announced the same way it is everywhere
else — a doc written from the first 8,000 characters of a long README, presented as the
whole thing, describes a repo that doesn't exist), alongside the same size-aware file map
every other call site uses. The allowlist stays hardcoded for now — a map-driven selection
here would change generated doc content, which is Phase 15's concern and wants its own
before/after review. The model is asked to synthesize a complete Markdown document
from that material in one shot — the whole document is regenerated from scratch every
time, never incrementally patched, so there's no prior-document state to feed back in.

## Limits at a glance

None of the pre-existing values here has changed since they were first set. What Phase
19 changed is where the first two are *declared*; what Phase 20 changed is what
`MAX_TREE_PATHS` *means* — no longer the point at which an arbitrary path list got cut,
but the size of a ranked selection, with everything it leaves out counted and stated in
the prompt. Phase 21 adds rows rather than changing values, except `BYTES_PER_LINE`,
which now only applies where no structural index exists. This table is the only place
these are written down outside code, so it names the module.

| Constant | Value | Declared in | Applies to |
|---|---|---|---|
| `MAX_TREE_PATHS` | 500 | `app/lib/repoMap.js` (re-exported by `repoContext.js`) | Every call site — files shown in the file map |
| `BYTES_PER_LINE` | 40 | `app/lib/repoMap.js` | File map — estimating line counts, **only for files the index doesn't cover** |
| `MAX_FILE_CHARS` | 8,000 | `app/lib/repoContext.js` | Any individual fetched/pre-selected file's content |
| `MAX_RANGE_LINES` | 400 | `app/lib/repoContext.js` | `FETCH_RANGE` — lines per ranged read (`MAX_FILE_CHARS` still applies on top) |
| `MAX_ANCHOR_LINES` | 300 | `app/lib/pipeline/rangedWrite.js` | `REPLACE_LINES` — lines a single anchored write may span |
| `MAX_REPLACEMENT_LINES` | 1,000 | `app/lib/pipeline/rangedWrite.js` | `REPLACE_LINES` — sanity bound; `max_tokens` binds first |
| `MAX_CONTAINER_FILE_BYTES` | 2 MB | `codegenService.js` | Codegen — largest file readable/editable from the container |
| `MAX_INDEX_FILES` | 4,000 | `app/lib/structuralIndex.js` | Structural index — files given an outline |
| `MAX_SYMBOLS_PER_FILE` | 300 | `app/lib/structuralIndex.js` | Structural index — outline entries per file |
| `MAX_LINES_SCANNED` | 100,000 | `app/lib/structuralIndex.js` | Structural index — lines scanned per file before giving up |
| `APEX_INDEX_TIMEOUT_MS` | 120,000 | `app/lib/structuralIndex.js` (env-overridable) | Structural index — whole-repo build timeout |
| `MAX_FILE_FETCHES` | 5 | `clarificationService.js` | Clarification — `FETCH_FILE` round-trips per message |
| `MAX_TURNS` | 40 | `codegenService.js` | Codegen — total model turns before failing the pipeline |
| `MAX_CUT_OFF_REPLIES` | 2 | `codegenService.js` | Codegen — `max_tokens`-cutoff replies tolerated per run |
| `MAX_DIFF_CHARS` | 12,000 | `overlapService.js` | Overlap detection — total diff text |
| `MAX_PATCH_CHARS_PER_FILE` | 2,000 | `overlapService.js` | Overlap detection — per-file patch, before the total cap above |
| `MAX_INSTRUCTIONS_LENGTH` | 6,000 | `repoClarificationInstructions.js` | Admin clarification instructions — enforced at save time, not read time |

All four call sites that accept admin-authored `repo_clarification_instructions` (every
one except the Spec/Communication Protocol doc) inject it as a clearly labeled
`=== ADMIN CLARIFICATION INSTRUCTIONS (authoritative) ===` block, separate from the file
map — the model is told this is authoritative guidance, not repo content it asked for.

## Known failure modes

- **Provider locked** — surfaces as `"Model provider "<provider>" is locked (<reason>) -
  clear the lock from /admin/usage before retrying."`, thrown by `modelAdapter.js`
  before any request is even attempted. Only clears via the manual admin action on
  `/admin/usage` — there's no auto-expiry.
- **Blank reply exhausting retries** — surfaces as `"NVIDIA NIM returned no usable
  content (both content and reasoning_content were blank)"`.
- **Transport error exhausting retries** — surfaces as `"NVIDIA NIM returned HTTP
  <status>: <body>"`. Only a network error, a 5xx, or a 408 actually exhausts the
  budget; any other 4xx reports the same message after a single attempt, with no delay.
- **Reply cut off at `max_tokens`** — surfaces as `"NVIDIA NIM stopped generating at the
  max_tokens limit (model "<id>", max_tokens=<n>, <n> output tokens) - the reply was cut
  off mid-output and has been discarded rather than used."` Never retried (the same request
  produces the same cutoff). In codegen the first two such replies are fed back to the
  model as "your previous reply was cut off... nothing was written" so it can pick a
  smaller change; the third fails the codegen stage. At every other call site it fails
  the operation immediately. **Nothing from a cut-off reply is ever written.**
- **Codegen refuses a write against a file it didn't fully see** — surfaces to the model
  as `"Refusing to write "<path>" - you were shown only the first <n> characters..."`
  (or the `too large` / failed-read / never-fetched variants). **Not a bug and not a
  failure** — it's the Phase 19 guard working. It becomes a pipeline failure only if the
  model then has nothing left it can legally do and ends with zero files written. The
  fix is not to raise `MAX_FILE_CHARS` (the `max_tokens` output ceiling still makes a
  3,000-line whole-file rewrite impossible) — it's `REPLACE_LINES`, which every refusal
  now points the model at. Since Phase 21, a run that *fails* here means the model
  declined the ranged route, not that no route existed.
- **Anchor mismatch on `REPLACE_LINES`** — surfaces to the model as `"Refusing
  REPLACE_LINES on <path> - the EXPECTED text does not match what is actually on lines
  <a>-<b>. Nothing was written."` followed by the real contents of those lines.
  **Not a bug** — it's the verification working, and it's designed to be self-correcting
  within a turn or two. It becomes a problem only as a *loop*: the same path refused
  repeatedly until `MAX_TURNS` runs out. Diagnose by reading the refusal text in the
  codegen transcript, and check for these in order:
  1. **The model is including the line-number prefixes** Apex adds when displaying a
     range. Those are display only. The refusal says so explicitly.
  2. **It's working top-down through several edits to one file**, so each applied edit
     shifts the line numbers of the next. Every applied-write reply states the new
     length and says to work bottom-up.
  3. **Leading whitespace differs.** Deliberately not tolerated (trailing whitespace is).
     A de-indented anchor in a Python file refuses, correctly.
- **Index build failure** — surfaces in the worker log as `"structural index unavailable
  - codegen continues without outlines"` with a reason, **never as a pipeline failure**.
  Consequences are bounded and cosmetic: the file tree falls back to Phase 20's `~`
  estimates, and `FETCH_OUTLINE` answers "no outline is available". Ranged reads and
  anchored writes are unaffected — they read and verify against the container directly.
  Most likely causes are an image with no `awk`, or a repo so large the 120-second
  `APEX_INDEX_TIMEOUT_MS` expires.
- **A file over 1 MB** — surfaces to the model as `"<path> exists but could not be read:
  it is <n> characters, over the 1 MB limit of the file-contents API..."`, and any write
  to it is refused. Before Phase 19 this was reported as "not found," and the model
  could respond by recreating the file from scratch.
- **Request exceeds the model's context window** — surfaces as `"NVIDIA NIM returned
  HTTP 400 - the request exceeded the model's context window: <body>"`. Fails fast,
  does **not** lock the provider (only 429/402 do that). Most likely in codegen, whose
  `messages` array is append-only across up to 40 turns.
- **Codegen exhausts 40 turns, or says `DONE` with nothing written** — fails the
  pipeline at the codegen stage with an explicit error; never silently produces a
  no-op pipeline run.
- **Codegen emits something that isn't `FETCH_FILE:`/`WRITE_FILE:`/`DONE`** — not a
  failure: the model is re-prompted in place ("Unrecognized response...") and the turn
  counter keeps advancing toward the 40-turn cap.
- **A file map that is incomplete** — the rendered tree says so: it ends with a count
  of what was excluded and omitted, and if GitHub's own tree response was truncated, an
  explicit *"some paths are unknown to Apex entirely"*. The visible consequence in
  codegen is a stricter write guard — when the map can't prove a path is new, a write to
  a file the model hasn't fetched is refused rather than allowed. Not a bug; the
  alternative is a whole-file write over a file nobody confirmed was absent.
- **Tree fetch fails outright** — the map degrades to empty and the prompt's tree block
  reads `(tree unavailable)`. Clarification and doc generation proceed with no repo
  structure at all; codegen proceeds but can only write files it has explicitly fetched
  first. Whether the step should instead fail is still open (see
  [undecided_topics.md](undecided_topics.md)).
- **Overlap JSON doesn't parse at all** — fails open to "no overlap," per the
  human-judgment design above; never blocks or crashes the clarification loop.

See [apex_troubleshooting.md](apex_troubleshooting.md) for how these surface in logs
and what to check when they happen.
