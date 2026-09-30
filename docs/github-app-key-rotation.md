# GitHub App key rotation

Apex authenticates to GitHub as a GitHub App, not as any individual user. This
document is the runbook for rotating that App's private key — routine rotation, or
responding to a suspected leak.

## How the key is used today

- `GITHUB_APP_PRIVATE_KEY_PATH` (env var) points at the App's private key file on
  disk. `app/lib/github/githubAppAuth.js` reads it on every JWT it signs — the key
  itself is never held in memory longer than a single `buildAppJwt()` call, and never
  sent anywhere.
- That JWT (10-minute lifetime, per GitHub's own cap) is exchanged for a short-lived
  installation access token via `POST /app/installations/{id}/access_tokens`. Tokens
  are cached in memory only (`tokenCache` in `githubAppAuth.js`) — never written to
  disk or the database — and re-minted once they're within a minute of expiring.
- Two tokens are minted from the same key, at two different permission scopes (see
  ROADMAP.md Phase 7): a default, full `contents: write` token used for reads and the
  host-side push, and a `contents: read`-only token used inside the sandbox for
  cloning. Rotating the key invalidates neither differently — both are just JWT
  signatures made with the same private key.

## Rotating on a schedule (routine)

1. In the GitHub App's settings (Developer settings → GitHub Apps → Apex →
   "Private keys"), click **Generate a private key**. GitHub lets multiple keys be
   valid simultaneously — generating a new one does not revoke the old one.
2. Download the new `.pem` and place it on the host at the path
   `GITHUB_APP_PRIVATE_KEY_PATH` already points to (overwrite the file in place, or
   update the env var to a new path — either works, since the app re-reads the file
   on every JWT signature rather than caching its contents).
3. Restart the app and worker containers (`make dev`, `make worker`) so any
   already-cached installation token keeps working until it naturally expires (≤1
   hour), and the *next* JWT `buildAppJwt()` signs uses the new key.
4. Confirm the app is still minting tokens successfully — the next repo page load or
   worker pipeline run will fail loudly (see `githubAppAuth.js`'s single-attempt,
   fail-loud design) if the new key doesn't work.
5. Once confirmed, delete the old private key from the App's settings.

Because both keys are valid until you explicitly delete the old one, steps 2–4 have
no downtime window — there's no moment where neither key works.

## Rotating on a suspected leak (incident)

Same steps as above, but skip straight to generating the new key and **delete the old
key immediately** after confirming the new one works in step 4, rather than leaving it
valid on a routine schedule. Two things this does *not* immediately fix:

- **Already-minted installation tokens** signed with the compromised key remain valid
  until their own expiry (≤1 hour) regardless of whether the signing key is later
  deleted — deleting the App key does not retroactively revoke tokens already issued
  from it. If the leak is severe enough that an active token is itself a concern,
  revoke it directly via `DELETE /installation/token` (GitHub's token-revocation
  endpoint) using that token — Apex has no built-in support for this today, since it's
  an incident-response action, not a normal operational one.
- **The App's own permissions/ruleset scope** (`contents: write`, restricted to
  `dev/**` — see ROADMAP.md Phase 3) are unaffected by key rotation; they're a
  property of the App/installation, not the key.

## Where this doesn't apply

`SESSION_SECRET` (the Express session-signing secret) and `NVIDIA_API_KEY` are
separate credentials with their own rotation stories — this document is specifically
about the GitHub App's private key.
