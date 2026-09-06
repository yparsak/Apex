# Agent prompts & model/platform integration

Phase 1 built the two swappable-backend interfaces the agent depends on — a
model adapter and a GitHub App token-minting service — plus the secrets
abstraction the token service is built on. This doc describes what exists
today. See `roadmap.md` for the phase-by-phase plan.

Phase 3 (below) is the first phase with actual system-prompt / conversation-
strategy content. Phase 4 (sandboxed execution) still has none — this doc
does not speculate about it.

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
