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

| Env var | Purpose |
|---|---|
| `MODEL` | Model name sent to the chat-completions endpoint (e.g. `google/gemma-4-31b-it`). |
| `NVIDIA_BASE_URL` | Base URL, e.g. `https://integrate.api.nvidia.com/v1`. |
| `NVIDIA_API_KEY` | Bearer token. |
| `MODEL_MAX_TOKENS` | `max_tokens` on every request. Defaults to 4096. |

### Request/response handling

Every call is a single `POST {NVIDIA_BASE_URL}/chat/completions` with `{ model,
messages, max_tokens }`. Reply text is read from `choices[0].message.content`, falling
back to `choices[0].message.reasoning_content` if `content` is empty — observed
necessary for `moonshotai/kimi-k3`, which sometimes returns its answer in
`reasoning_content` instead. (The `.env.example` also notes that model has an
intermittent bug where it responds with a string of `!!!!` — the default model is
currently set to `google/gemma-4-31b-it` instead.)

### Reliability

Up to 3 attempts, exponential backoff (500ms, 1000ms). Two distinct failure modes share
the same retry budget and the same final error-reporting path:

- **Transport failures** — network errors, non-2xx HTTP status.
- **Content failures** — a 2xx response where both `content` and `reasoning_content`
  come back blank.

Whichever failure happened on the *final* attempt is what gets thrown — a transport
error is never misreported as "no usable content," and vice versa. `generate()` either
resolves with non-blank text or rejects; it never resolves with blank/null.

## The guiding rule: paths first, content on demand

Apex never bulk-sends a repo's file contents to the model. Every call site that needs
repo awareness follows the same two-step shape:

1. Fetch the **file tree** — a recursive, paths-only listing from GitHub's Git Trees
   API (`githubApi.getTree`, blobs only), capped at **500 paths**
   (`MAX_TREE_PATHS`). This is cheap (one API call) and scales to large repos.
2. Let the **model pull individual files by path**, on demand, via a `FETCH_FILE:
   <path>` directive the model emits mid-conversation. Each fetched file is read live
   from GitHub at the branch's current tip and truncated to **8,000 characters**
   (`MAX_FILE_CHARS`) before being shown back to the model.

The one deliberate exception is the Spec/Communication Protocol doc generator, which
pre-selects a small fixed set of files instead of letting the model ask (see below) —
everywhere else, file selection is entirely model-driven.

## The four call sites

### 1. Clarification — [clarificationService.js](app/lib/clarificationService.js)

Runs once per message the engineer sends in the clarification chat.

**Messages sent:** a system prompt + the file tree + (if set) this repo's admin-authored
clarification instructions, as one system message, followed by the **entire
conversation history** for this session (every row in `conversations`, in order).

**What the model can do, each turn:**
- Ask a plain-text clarifying question (ends the turn; shown to the user).
- `FETCH_FILE: <path>` — resolved immediately against GitHub content at the branch tip,
  appended to a scratch copy of the message list, and the loop continues **without**
  surfacing this round-trip in the stored `conversations` transcript. Capped at
  **5 fetches** (`MAX_FILE_FETCHES`) per submitted message; if the model is still
  fetching after 5, Apex falls back to a canned "I wasn't able to gather enough context
  automatically" question rather than looping forever.
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

**What the model can do, each turn (up to 40 turns, `MAX_TURNS`):**
- `FETCH_FILE: <path>` — resolved against **this session's own not-yet-committed
  writes first** (an in-memory `written` map), falling back to GitHub content at the
  branch tip only if this session hasn't already written that path. This matters
  because the sandbox container's cloned tree and the branch tip are identical at clone
  time — so re-fetching a path the model already wrote earlier *this session* correctly
  sees its own edit, not the stale upstream copy, without needing to read the
  container's filesystem at all. **Only `WRITE_FILE` ever touches the container** (via
  `docker exec`); every read, including of files the model itself wrote, is served from
  this in-memory map or GitHub.
- `WRITE_FILE: <path>` followed by the file's **complete** new contents (this replaces
  the whole file, not a diff/patch) — rejected if `<path>` has a leading `/` or any
  `..` segment, with the rejection reason sent back to the model to retry. On success,
  streamed into the container via `dockerRunner.writeFile` (stdin, not an argv string,
  so it isn't subject to shell-escaping or `ARG_MAX`) and recorded in the `written` map.
- `DONE` — ends codegen. Throws (fails the pipeline at the codegen stage) if the model
  says `DONE` having written zero files, or if 40 turns pass without a `DONE`.

Immediately after codegen returns, `pipelineRunner.js` runs `git add -A && git commit`
inside the container — so every file the model wrote this turn, not just the ones it
re-fetched, ends up in the commit regardless of whether the model asked to see them
again.

### 4. Spec/Communication Protocol doc — [specDocService.js](app/lib/documents/specDocService.js)

Runs on `specDocWorker.js`'s own schedule, once per repo whose trunk has moved. **The
one call site where file selection is not model-driven**: there's no `FETCH_FILE` loop
here at all. Instead, Apex pre-selects a small fixed allowlist —

```
README.md, package.json, apex.pipeline.json
```

— and includes the content of whichever of those three actually exist in the tree
(each truncated to 8,000 chars), alongside the same capped 500-path file tree every
other call site uses. The model is asked to synthesize a complete Markdown document
from that material in one shot — the whole document is regenerated from scratch every
time, never incrementally patched, so there's no prior-document state to feed back in.

## Limits at a glance

| Constant | Value | Applies to |
|---|---|---|
| `MAX_TREE_PATHS` | 500 | Every call site — file tree listing |
| `MAX_FILE_CHARS` | 8,000 | Any individual fetched/pre-selected file's content |
| `MAX_FILE_FETCHES` | 5 | Clarification — `FETCH_FILE` round-trips per message |
| `MAX_TURNS` | 40 | Codegen — total model turns before failing the pipeline |
| `MAX_DIFF_CHARS` | 12,000 | Overlap detection — total diff text |
| `MAX_PATCH_CHARS_PER_FILE` | 2,000 | Overlap detection — per-file patch, before the total cap above |
| `MAX_INSTRUCTIONS_LENGTH` | 6,000 | Admin clarification instructions — enforced at save time, not read time |

All four call sites that accept admin-authored `repo_clarification_instructions` (every
one except the Spec/Communication Protocol doc) inject it as a clearly labeled
`=== ADMIN CLARIFICATION INSTRUCTIONS (authoritative) ===` block, separate from the file
tree — the model is told this is authoritative guidance, not repo content it asked for.

## Known failure modes

- **Provider locked** — surfaces as `"Model provider "<provider>" is locked (<reason>) -
  clear the lock from /admin/usage before retrying."`, thrown by `modelAdapter.js`
  before any request is even attempted. Only clears via the manual admin action on
  `/admin/usage` — there's no auto-expiry.
- **Blank reply exhausting retries** — surfaces as `"NVIDIA NIM returned no usable
  content (both content and reasoning_content were blank)"`.
- **Transport error exhausting retries** — surfaces as `"NVIDIA NIM returned HTTP
  <status>: <body>"`.
- **Codegen exhausts 40 turns, or says `DONE` with nothing written** — fails the
  pipeline at the codegen stage with an explicit error; never silently produces a
  no-op pipeline run.
- **Codegen emits something that isn't `FETCH_FILE:`/`WRITE_FILE:`/`DONE`** — not a
  failure: the model is re-prompted in place ("Unrecognized response...") and the turn
  counter keeps advancing toward the 40-turn cap.
- **Overlap JSON doesn't parse at all** — fails open to "no overlap," per the
  human-judgment design above; never blocks or crashes the clarification loop.

See [apex_troubleshooting.md](apex_troubleshooting.md) for how these surface in logs
and what to check when they happen.
