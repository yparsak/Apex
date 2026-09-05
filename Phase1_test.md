# Phase 1 manual testing

Phase 1 adds two backend services — a GitHub App token-minting service and
a model adapter — plus the secrets abstraction the token service is built
on. There is **no UI or HTTP route to click through yet** (Phase 2 adds
repo/branch selection UI); these are backend-only checks run via Node
scripts. See `agent-prompts.md` for the contracts these scripts exercise.

## Prerequisites

1. **A GitHub App**, installed org-wide, with `contents: write` as its
   only repository permission (no `pull_requests`, no other scopes — per
   `roadmap.md`'s confirmed permission scope).
   - Create/find it under your GitHub organization's Settings > Developer
     settings > GitHub Apps. You'll need:
     - **App ID** — shown on the App's settings page.
     - **Installation ID** — shown in the URL when you view the App's
       installation under the org (or via the installations API).
     - **A private key** — generate one from the App's settings page; this
       downloads a `.pem` file. Save it somewhere on disk outside the repo
       (it must never be committed).
   - The `dev/**` branch-pattern restriction from `roadmap.md` is enforced
     via a GitHub repository ruleset, not by this app's code — set that up
     separately in the target repo's Settings > Rules > Rulesets if you
     want to test that restriction is actually in effect. It has no
     bearing on whether the scripts below succeed.

2. **An NVIDIA NIM API key** — get one from build.nvidia.com (NVIDIA's
   model catalog / API key management for NIM-hosted models).

## Configure `.env`

Copy `.env.example` to `.env` if you haven't already (see
`phase0.setup.md` for the Phase 0 vars). Add/fill in the Phase 1 vars:

```
SECRETS_PROVIDER=env

GITHUB_APP_ID=<your App ID>
GITHUB_APP_INSTALLATION_ID=<your installation ID>
GITHUB_APP_PRIVATE_KEY_PATH=/absolute/path/to/your-app-private-key.pem

MODEL_PROVIDER=nvidia-nim
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
MODEL=meta/llama-3.1-70b-instruct
NVIDIA_API_KEY=<your NIM API key>
```

`GITHUB_APP_PRIVATE_KEY_PATH` is how the local "env" secrets provider
resolves a multi-line PEM — it reads the file at that path. (You could
instead set `GITHUB_APP_PRIVATE_KEY` directly to the key contents, but a
file path is far easier for a multi-line value; see
`app/lib/secrets/envSecretsProvider.js`.)

Install the new dependency (`jsonwebtoken`) along with the rest:

```
make install
```

## Test 1 — GitHub App token minting

```
node scripts/test-github-token.js
```

or

```
make test-github-token
```

**Success looks like:**

```
Token minted OK. Masked token: ghs_ab...  Expires at: 2026-09-05T13:15:00Z
```

The full token is never printed — only the first 6 characters and the
expiry. If you want to confirm the token actually works, you can use it
yourself against the GitHub API (e.g. `curl -H "Authorization: token
<full token>" https://api.github.com/installation/repositories`), but the
script intentionally doesn't do that for you.

**Common config errors and what they look like:**

| Symptom | Likely cause |
|---|---|
| `GITHUB_APP_ID and GITHUB_APP_INSTALLATION_ID must both be set` | One or both env vars missing from `.env` |
| `Secret "GITHUB_APP_PRIVATE_KEY" is not set — expected env var "GITHUB_APP_PRIVATE_KEY" or "GITHUB_APP_PRIVATE_KEY_PATH"` | Neither var set, or the `_PATH` value doesn't point at an existing file (also check for an `ENOENT` file-read error, which means the path is wrong) |
| `GitHub installation token request failed (401): ...` | Private key doesn't match the App, or `GITHUB_APP_ID` is wrong |
| `GitHub installation token request failed (404): ...` | `GITHUB_APP_INSTALLATION_ID` is wrong, or the App isn't actually installed on this org/account |

## Test 2 — Model adapter

```
node scripts/test-model-adapter.js
```

or

```
make test-model-adapter
```

**Success looks like:**

```
Model response: Apex phase one works.
```

(The model may not reproduce the exact phrasing verbatim — LLMs are not
perfectly deterministic even with a literal instruction — but you should
see a coherent short reply, not an error.)

**Common config errors and what they look like:**

| Symptom | Likely cause |
|---|---|
| `NVIDIA NIM chat request failed (401): ...` | `NVIDIA_API_KEY` is missing or invalid |
| `NVIDIA NIM chat request failed (404): ...` | `MODEL` name isn't valid/available on NIM, or `NVIDIA_BASE_URL` is wrong |
| `fetch failed` / network error | `NVIDIA_BASE_URL` unreachable (typo, no network, proxy required) |
| `Unknown MODEL_PROVIDER "..."` | `MODEL_PROVIDER` in `.env` doesn't match the `nvidia-nim` case in `app/lib/model/index.js` |

## What this does and doesn't prove

These two scripts confirm the Phase 1 backend services work in isolation:
a GitHub installation token can be minted on demand, and a chat call to
the configured model backend round-trips correctly. There is nothing to
click through in a browser yet — no routes, no views — that starts with
Phase 2 (repo/branch selection).
