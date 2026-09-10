# Agent prompts & model/platform integration

Phase 1 built the two swappable-backend interfaces the agent depends on — a
model adapter and a GitHub App token-minting service — plus the secrets
abstraction the token service is built on. This doc describes what exists
today. See `roadmap.md` for the phase-by-phase plan.

Phase 3 (below) is the first phase with actual system-prompt / conversation-
strategy content. Phase 4 (also below) is the second, and the first phase
that turns model output into actual file changes rather than a discrete
requirements list.

## Model adapter contract

`app/lib/model/modelAdapter.js` defines the `ModelAdapter` abstract class.
Agent logic must obtain an adapter via `getModelAdapter()` in
`app/lib/model/index.js`, never a concrete class directly, so a future
provider swap is a new file + factory case, not a rewrite of call sites.

Contract:

```js
async chat({ messages }) => Promise<{ content: string }>
```

- `messages` — an array of `{ role, content }` objects, OpenAI-style chat
  message shape (`role` is `system` | `user` | `assistant`), since NIM and
  most providers speak that dialect.
- Return value — `{ content }`, the model's reply text, normalized across
  providers regardless of each provider's native response envelope.

This is intentionally minimal. Full tool-calling / structured Q&A shape is
Phase 3+ territory and is not built yet.

A new provider adapter must:

1. Extend `ModelAdapter` and implement `chat()` per the contract above.
2. Handle its own auth, request/response shape translation, and error
   surfacing internally — callers only ever see the normalized return
   shape or a thrown error.
3. Be added as a `case` in `app/lib/model/index.js`'s factory, keyed off
   `MODEL_PROVIDER`.

### Config vars (provider selection)

| Var | Meaning |
|---|---|
| `MODEL_PROVIDER` | Selects the adapter. `nvidia-nim` is the only implementation today. |
| `NVIDIA_BASE_URL` | NIM's OpenAI-compatible base URL, e.g. `https://integrate.api.nvidia.com/v1`. |
| `MODEL` | Model name passed straight through to NIM, e.g. `meta/llama-3.1-70b-instruct`. |
| `NVIDIA_API_KEY` | Bearer token for NIM. Read directly from env by the adapter — not routed through the secrets provider, which is reserved for the GitHub App private key. |

Swaps *within* the NIM catalog (a different Llama size, etc.) are
config-only — just change `MODEL`. Swapping to a different API shape
(Anthropic, OpenAI direct, self-hosted) requires a new adapter file
implementing the same contract. That's by design: the adapter interface
isolates provider-specific auth/request/response details so a future
switch is contained inside the adapter, not a rewrite touching agent logic
elsewhere.

## GitHub App token-minting service

`app/lib/github/githubAppTokenProvider.js` exports
`mintInstallationToken({ repositories } = {})`, which mints a short-lived
GitHub App installation access token on demand.

Guarantees:

- **Short-lived.** The App JWT used to request the token is valid for at
  most 600 seconds (GitHub's hard cap), with a 60-second `iat` backdate to
  tolerate clock drift. The installation token GitHub returns has its own
  (longer, GitHub-controlled) expiry, returned as `expiresAt`.
- **Never persisted.** The token is handed back to the caller in memory
  only — never written to the DB, disk, or logs. Only metadata (expiry,
  installation ID) is logged around a mint, never the token string.
- **Private key via the secrets provider.** The App's private key is
  fetched through `getSecretsProvider().getSecret('GITHUB_APP_PRIVATE_KEY')`
  (see below), never read as a raw env var inside the GitHub code — this
  is what makes swapping to a real secrets manager later a drop-in change.
- **Repo-level scoping only.** If `repositories` is passed, it's included
  in the token request body to scope the token to those repos — the only
  *programmatic* scoping GitHub's installation-token API supports.
- **No branch-level scoping in code.** GitHub's installation-token API has
  no parameter to restrict which branches a token can push to. The
  roadmap's "scoped to DEV-branch pattern" requirement is enforced on
  GitHub's side via a repository ruleset (Settings > Rules > Rulesets)
  restricting pushes matching `dev/**` to this App's installation — a
  one-time, org-admin GitHub configuration step, not something expressible
  in this Node code. Do not go looking for branch-scoping logic here; it
  cannot exist at this layer.

### Config vars

| Var | Meaning |
|---|---|
| `GITHUB_APP_ID` | The App's ID, from its GitHub settings page. Used as the JWT `iss` claim. |
| `GITHUB_APP_INSTALLATION_ID` | The org's installation ID for this App. Used in the access-token request URL. |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Path to the App's downloaded private key `.pem`, resolved via the "env" secrets provider (see below). |

## Secrets provider contract

`app/lib/secrets/secretsProvider.js` defines the `SecretsProvider`
abstract class (`async getSecret(name) => Promise<string>`), obtained via
`getSecretsProvider()` in `app/lib/secrets/index.js`, keyed off
`SECRETS_PROVIDER` (default `env`). This exists so the GitHub private key
doesn't get hardcoded to a raw env-var read inline in the GitHub code —
swapping to a real secrets manager (AWS Secrets Manager, Vault, etc.)
later is a new file + factory case, same pattern as `AuthProvider`.

The "env" implementation (`app/lib/secrets/envSecretsProvider.js`), for a
secret named `NAME`: checks `NAME_PATH` first and, if set, reads and
returns that file's contents (how a multi-line PEM gets supplied in local
dev); otherwise falls back to reading `NAME` directly as the env var
value; throws if neither is set.

## Phase 3: clarification loop

Phase 3 is the first thing built on top of the model adapter's plain
`chat({messages}) => {content}` contract above. The adapter still does not
speak tool-calling — nothing was added to `modelAdapter.js` or
`nvidiaNimAdapter.js` for this. Everything below is prompting plus
deterministic parsing on top of that one call, living in
`app/lib/branches/` (`clarificationPrompts.js`, `responseParsing.js`,
`sessionService.js`), not in the adapter layer itself.

### Why no tool-calling

The roadmap scopes the model backend to "NIM for prototyping, swappable
later" and the adapter contract note above already says full tool-calling
is "Phase 3+ territory." Building Phase 3 without extending the adapter
keeps that promise literally: a future adapter swap only ever has to
implement `chat()`, never a tool-calling schema, because Phase 3 doesn't
depend on one. The cost is that any structured output has to be recovered
from free text, which is what the next two sections describe.

### Response-parsing convention

Every model reply is either:

1. **Plain prose** — a clarifying question or commentary. This is the
   default reply shape and just continues the conversation.
2. **A single fenced code block**, and nothing else, labeled with a fixed
   tag, containing JSON:
   - `` ```requirements-ready `` — a JSON array of one or more non-empty
     requirement strings. Emitted by the model when it judges it has
     enough information to stop asking questions.
   - `` ```overlap-check `` — a JSON array with one
     `{requirementIndex, duplicate, duplicateOfRequirementId, reason}`
     object per candidate requirement, covering every index exactly once.
     Emitted only for the system-triggered overlap check described below,
     never shown to the user as a reply.

Parsing (`app/lib/branches/responseParsing.js`) is deterministic and
fails safe by construction: a missing block, invalid JSON, wrong shape, a
non-string/empty requirement, a missing or duplicated `requirementIndex`,
or a `duplicateOfRequirementId` that doesn't correspond to a requirement
actually offered to the model, all produce `null` — never a partial or
best-guess result. Callers decide what `null` means for their case:

- `requirements-ready` parse failure → the whole reply is treated as an
  ordinary clarifying question. The loop just continues; nothing is
  finalized on an ambiguous reply.
- `overlap-check` parse failure → **fail closed**, per roadmap.md's
  Accepted Risk #8: every candidate requirement in that batch defaults to
  `pending_confirm` rather than being silently let through. The whole
  point of overlap detection is that a human makes the final call when the
  model's judgment is least reliable — an unparseable judgment is the
  least reliable case there is, so it gets the most conservative outcome,
  not the most permissive one.

The prompts that instruct the model to follow this convention live in
`app/lib/branches/clarificationPrompts.js`, kept separate from the parsing
and the DB/session orchestration so prompt wording can change without
touching either.

### Audit-log semantics

`audit_log` is append-only — every model call in `sessionService.js` goes
through one internal helper (`runChatTurn`) that writes exactly one new
`audit_log` row per call and never updates an existing one:

- `raw_instructions` — the user's message text for a real Q&A turn, or
  `null` for a system-triggered call that has no user-authored instruction
  behind it (the start/resume summary, the overlap check).
- `qa_history` — the model's raw reply text, verbatim, including the
  fenced block if present, so a later parsing dispute can be re-audited
  against exactly what the model said.
- `user_id` / `repo_id` / `co_number` — the session's owning user and the
  branch's repo/CO, on every row, regardless of who or what triggered it.

Every audit-logged call also writes to `conversations`, which is the
visible/replayable transcript rather than the raw audit trail:
`role: 'user'` / `'assistant'` for anything the user should see (Q&A
turns, and the start/resume summary, which is stored as `'assistant'`
so it appears as the first transcript message), or `role: 'system'` for
the overlap check specifically — recorded for audit purposes but excluded
from the transcript the UI renders and from the prior-turn history replayed
into subsequent Q&A calls, since it's an internal check, not part of the
back-and-forth with the user.

See `roadmap.md`'s "Phase 3 — Clarification loop" section for the feature
scope this implements, and `Phase3_test.md` for how to exercise it.

## Phase 4: sandboxed execution

Phase 4 is where a `queued` session actually turns into pushed code. Nothing
before this phase ever wrote to a repo's files — Phases 0–3 only ever
produced a `session_requirements` list. This phase adds the first
code-generation step in the whole project, a worker process that consumes
`queued` sessions independent of any browser tab, and a sandboxed build/test
run before anything is pushed. See roadmap.md's "Phase 4 — Sandboxed
execution" bullets for the scope, and `Phase4_test.md` for how to exercise
it end to end.

### Why the pipeline is split "host does GitHub/model, container does build/test only"

Phases 1–3 kept all GitHub access as plain `fetch()` calls
(`app/lib/github/branchService.js`, `diffService.js`) — no `git` CLI, no
`simple-git`/`isomorphic-git` dependency, no plan to add one. Phase 4 keeps
that discipline rather than reaching for a git binary the moment "clone" and
"push" enter the picture:

- **"Clone" = download.** `app/lib/pipeline/workingTreeService.js` fetches
  the branch's tree via GitHub's tarball endpoint
  (`GET /repos/{owner}/{repo}/tarball/{ref}`) and extracts it to a host-side
  temp directory with the system `tar` binary (already on the box, no new
  dependency) — the same "shell a CLI instead of adding a library" choice
  this phase makes for Docker.
- **"Push" = GitHub's Git Data API**, not `git push` — blob(s), a tree, a
  commit, then a ref update (`app/lib/github/commitService.js`), reusing
  `githubRequest`/token-minting from `branchService.js` rather than
  reimplementing that wrapper. This is also what makes fetch-and-retry (see
  below) a natural fit: reading the current head SHA and rebuilding a tree
  against it is just another API call, not a local working-copy rebase.
- **Everything involving a GitHub token or the model adapter runs on the
  host** (the worker process), which already has network access to both
  GitHub and the model backend. **Nothing GitHub- or model-related ever runs
  inside the sandbox container.** The container's only inputs are an
  already-`git`-free working directory and two shell commands; its only job
  is running them. This is what makes "the write-capable token never enters
  the sandbox" trivially, structurally true rather than a policy someone has
  to remember to uphold — the token isn't merely unused inside the
  container, it's never minted anywhere the container could reach it.

### Clone-only vs. push tokens

`app/lib/github/githubAppTokenProvider.js`'s `mintInstallationToken` gained
an optional second parameter this phase:

```js
mintInstallationToken({ repositories, permissions } = {})
```

`permissions` is passed straight through to GitHub's installation
access-token request body when present, requesting a subset of the App's
granted permissions (the App has `contents: write`; a caller can ask for
just `contents: read`). Two new named wrappers in `branchService.js` use
this:

- `mintCloneOnlyToken(repoName)` — `{ contents: 'read' }`, used by
  `workingTreeService.downloadAndExtractTree` for the tarball download. This
  is what makes "clone-only token" a literal, verifiable property of the
  code rather than an aspirational comment — a token minted this way
  physically cannot push, regardless of what the rest of the pipeline does
  with it.
- `mintPushToken(repoName)` — `{ contents: 'write' }`, minted fresh inside
  `commitService.commitAndPushChanges` immediately before the push step,
  rather than reused from an earlier step. This is the "write-capable token"
  the roadmap says must never enter the sandbox; per the point above, it
  never does, because nothing GitHub-related runs inside the container at
  all.

When `permissions` is omitted (every pre-Phase-4 call site), the token
carries the installation's full granted permission set, unchanged from
before this parameter existed — this is a strictly additive change to the
token-minting contract.

### Fetch-and-retry, never force-push

`commitService.commitAndPushChanges` reads the branch's current head SHA
immediately before building each attempt's tree/commit. If the ref update
comes back non-fast-forward (GitHub returns 422, occasionally 409 — an
engineer pushed directly to the DEV branch in the meantime, an explicitly
anticipated case per roadmap.md), it re-fetches the current head and
rebuilds the tree/commit against it, up to three attempts total, then fails
loudly. `force: false` is written explicitly in the ref-update request body
everywhere in this module — never `true`, and never merely omitted and left
to a default.

### Declarative per-repo build/test config

`app/lib/pipeline/pipelineConfig.js` reads a fixed file,
`apex.pipeline.json`, from the repo root of the extracted working tree:

```json
{
  "buildCommand": "npm ci",
  "testCommand": "npm test",
  "image": "node:20",
  "timeoutSeconds": 600
}
```

Kept as plain JSON, not YAML — there is no YAML-parsing dependency anywhere
in this project, and adding one for a single config file isn't justified.
`buildCommand` and `testCommand` are required and never defaulted — a
missing or invalid config file fails the run loudly with a clear message,
the same "no silent guessing" convention `repos.default_branch_name` and the
branch-existence checks already follow. `image` and `timeoutSeconds` are the
one exception: they may fall back to `SANDBOX_IMAGE` /
`SANDBOX_TIMEOUT_SECONDS` env vars when omitted, since a container image and
a timeout are infra concerns, not the "what does this repo's build/test
actually do" business logic the roadmap says must never be invented.

### The container's scope

`app/lib/pipeline/sandboxRunner.js` shells out to the `docker` CLI via
`child_process` rather than adding a `dockerode` dependency — this project
has added zero incidental dependencies through Phase 3, and a CLI spawn is
enough for "run a container, capture output, enforce a timeout." Each run:

- `docker run --rm --network none --name <container> -v <treeDir>:/workspace:rw -w /workspace <image> sh -c "<buildCommand> && <testCommand>"`
- `--network none` — no network access at all, matching roadmap.md's
  "network-isolated container." Nothing inside needs the network: the
  working tree is already fully populated (code changes included) before
  the container starts. If a repo's build genuinely needs network access
  (e.g. to install dependencies), that's a per-repo concern for its
  `apex.pipeline.json` commands to solve (a prebuilt image with dependencies
  baked in, a vendored cache, etc.), not something this runner grants by
  default.
- An explicit `--name` so a timeout can target `docker kill <name>`
  precisely — killing the local `docker run` client process alone would not
  reliably stop the container itself.
- A host-enforced timeout (`SANDBOX_TIMEOUT_SECONDS`, overridable per repo
  via `apex.pipeline.json`'s `timeoutSeconds`): a `setTimeout` on the host
  calls `docker kill` if the container is still running when it fires.
- An optional `--memory` limit via `SANDBOX_MEMORY_LIMIT`, applied only when
  set.
- No credentials, no `git`, no model adapter call — the container's *only*
  job is running the two declarative commands against an
  already-code-modified working directory.

Combined stdout/stderr is captured and written to `pipeline_runs.log`
(capped and truncated past a fixed character limit, same truncate-and-log
discipline `diffService.js` already established for oversized diffs) — this
is what the UI's Pipeline panel renders.

### Code generation: the new fenced-block tags

The model adapter still only exposes `chat({messages}) => {content}` — see
"Why no tool-calling" above; that reasoning is Phase-3-flavored but the
conclusion holds unchanged here: Phase 4 needed no changes to
`modelAdapter.js` or `nvidiaNimAdapter.js`, either. Code generation is
prompting plus deterministic parsing on top of that one call, exactly like
Phase 3, extended with two new tags in a two-step, non-tool-calling protocol
(`app/lib/pipeline/pipelinePrompts.js` / `pipelineResponseParsing.js`):

1. **`` ```files-needed `` `** — step one. Given the confirmed requirements,
   the branch's diff vs. its default branch, and a listing of every file
   path in the working tree, the model names which existing files (if any)
   it needs to read in full before writing changes. A JSON array of
   repo-relative path strings. **Unlike Phase 3's `requirements-ready`, an
   empty array is a valid, unambiguous reply** — "I only need to create new
   files" is a legitimate outcome here, not a sign the model failed to
   answer, so `parseFilesNeeded` does not reject a zero-length result the
   way `parseRequirementsReady` does. Every named path is checked against
   the actual working tree after parsing; a path that doesn't exist fails
   the run closed (the same unverifiable-reference treatment
   `sessionService.applyOverlapCheck` already gives an unknown
   `duplicateOfRequirementId`), rather than being silently dropped or
   guessed at.
2. **`` ```file-changes `` `** — step two. Given the full content of
   whatever files it asked for in step one, the model emits the concrete
   changes as a single JSON array:
   `[{"path": "...", "action": "create"|"modify"|"delete", "content": "..."}]`.
   `content` is the **entire new file content**, never a diff/patch format —
   a deliberate choice: applying a full replacement with a plain
   `fs.writeFile` is far more deterministic than applying a patch, which
   risks an LLM getting line offsets wrong with no way to detect that at
   apply time. A non-empty array is required (same non-empty-result
   convention as `requirements-ready`); every path must stay inside the
   working tree once normalized (no `..` segment, no leading `/`, no null
   byte) and must not repeat.

Both tags follow the exact same fail-safe-by-construction rule Phase 3
established: any parse failure or ambiguous shape returns `null`, never a
partial or best-guess result. The fenced-block *extraction* itself was
factored out into `app/lib/parsing/fencedBlock.js`, shared by
`app/lib/branches/responseParsing.js` and
`app/lib/pipeline/pipelineResponseParsing.js`, so the tag-matching regex
isn't duplicated per phase.

**Fail-closed behavior at the pipeline level:** unlike Phase 3 (where an
unparseable `requirements-ready` reply just continues the Q&A loop, and an
unparseable `overlap-check` reply defaults to `pending_confirm`), Phase 4
has no "keep going" option once a session is queued and a pipeline run has
started — there's no human mid-loop to hand an ambiguous reply back to. So
`app/lib/pipeline/pipelineService.js` treats any parse failure from either
step (`CODEGEN_PARSE_FAILED`) as an unrecoverable error for that run: the
session is marked `failed`, the `pipeline_runs` row records the error
message, and nothing is applied to the working tree or pushed. This is the
same "no silent guessing" philosophy Phases 0–3 apply everywhere else,
carried through to the one place in this phase where the model's reply
directly becomes file contents.

### Working-tree path safety

Every path the model names (in either `files-needed` or `file-changes`) is
validated in `pipelineResponseParsing.js`, at parse time, before it's ever
joined with the working directory's absolute path: normalized, then
rejected if it starts with `/`, contains a `..` segment, or contains a null
byte. This is what stops a hallucinated or adversarial path from ever
reaching an `fs` write outside the extracted tree — the check happens once,
centrally, at the parsing boundary, rather than being re-derived at every
call site that touches the filesystem.

### Audit-log semantics (Phase 4 additions)

Both of Phase 4's model calls (the file-selection turn, the code-changes
turn) go through the exact same `runChatTurn` helper Phase 3's
`sessionService.js` already established — `pipelineService.js` imports and
reuses it directly rather than reimplementing the
`conversations`/`audit_log` write pair. This means:

- One new `audit_log` row per call, `raw_instructions` **NULL** (these are
  system-triggered, like Phase 3's start-summary and overlap-check calls,
  not user-authored instructions), `qa_history` the model's raw reply
  verbatim (fenced block and all).
- One new `conversations` row per call with `role: 'system'` — recorded for
  audit purposes but excluded from both the transcript the UI renders and
  the prior-turn history replayed into Q&A calls, exactly like Phase 3's
  overlap-check turn. A user watching the session page sees the *outcome*
  (the Pipeline panel) but not these two internal turns verbatim in the
  transcript — that's intentional, matching how the overlap-check turn is
  already treated as internal rather than conversational.
- `user_id` on both rows is the session's owner (`session.userId`) and
  `repo_id`/`co_number` come from the branch being worked on, same
  convention as every other audit row in this project.

### Worker process and claiming

`worker.js` (repo root, mirrors `server.js`'s entrypoint style) polls
`sessions` for `status = 'queued'` rows and claims one via a single
conditional `UPDATE sessions SET status='running' WHERE id=? AND status='queued'`,
checking the affected-row count. This is what prevents double pickup
without needing DB-specific `SKIP LOCKED` syntax — only one such `UPDATE`
can ever affect a given row, so a second worker process (or the same worker
racing itself across ticks) started by mistake simply affects zero rows and
moves on to the next poll. `WORKER_POLL_INTERVAL_MS` controls the interval
between polls (default 5000ms).

Before doing any work on a claimed session, the worker's pipeline
(`pipelineService.runPipelineForSession`) re-checks branch existence via
`branchExists` (reused from `branchService.js`, same call Phase 2's
list-render uses) — this is the **second of the two on-demand deletion
checkpoints** roadmap.md describes (the first is Phase 2's branch-list
render). If the branch is gone, it's marked `deleted` in `branches`, the
session is marked `failed` with a clear error, and the pipeline halts before
downloading anything or calling the model — never pushing into a stale
branch name.

**Known limitation, not addressed by this phase:** if the worker process
crashes mid-run, the session it had claimed is left in `running` with no
further consumer (only `queued` rows get picked up) and its `pipeline_runs`
row is left `running` indefinitely. Detecting and recovering a stuck
`running` session isn't in roadmap.md's Phase 4 scope and isn't built here;
it would need a staleness/heartbeat check similar in spirit to the
branch-deletion on-demand checks, which is a Phase 7 (observability/
hardening)-shaped concern, not this phase's.

### Scope boundary vs. Phase 5

Per roadmap.md's Phase 4/5 split (and `pipelineLock.js`'s file comment,
which frames the full pipeline as "clone → sandbox build/test → push" as one
serialized unit): **Phase 4 ends with the code changes committed and pushed
to the DEV branch, and the session marked `completed`/`failed`.** It does
**not** release the `pipeline_locks` row for the `(repo_id, co_number)` pair
— that lock stays held until Phase 5 also pushes the Spec/Communication
Protocol doc and the requirements-log file update and then releases it.
Phase 4's code never calls `releaseLock`. This means, in current
(non-manually-hacked) operation, a CO's pipeline lock outlives even a fully
successful Phase 4 run — expected, not a bug, and exactly what
`Phase4_test.md`'s tests describe.

### `pipeline_runs` table

One row per worker pickup attempt of a queued session
(`session_id, status, started_at, finished_at, log, commit_sha, error_message`),
added as a new table via a plain `CREATE TABLE IF NOT EXISTS` in
`db/schema.sql` rather than new columns on `sessions` — this needs no
ALTER-based migration story (safe to apply against an already-provisioned
dev database exactly like every other table in this schema), and matches
how normalized the rest of the schema already is
(`session_requirements`/`conversations`/`audit_log` are all separate from
`sessions` too). `sessionService.getSessionDetail` reads the latest row for
a session directly (a plain query, not a call into `pipelineService.js`, to
avoid a require cycle since `pipelineService.js` already depends on
`sessionService.js` for `runChatTurn`) and returns it as `pipelineRun` in
the existing `GET .../sessions/:id` response — no new endpoint was added for
this, per roadmap.md's UI requirement that the whole flow be watchable from
a single page.
