// Mints short-lived GitHub App installation access tokens on demand. Tokens
// (and the App JWTs used to obtain them) are cached in memory only - never
// persisted (see notes.md / ROADMAP.md Phase 3).
const fs = require('fs');
const jwt = require('jsonwebtoken');

const REFRESH_BUFFER_MS = 60 * 1000;

// Cached per distinct cache key - the clone-only (contents: read) token used
// inside Phase 7's sandbox and the default (full-App-permission) token used
// for everything else, including the host-side push, are minted and cached
// independently so they're never conflated (see ROADMAP.md Phase 7: the
// write-capable push token must never enter the sandbox that holds the
// clone-only one).
const tokenCache = new Map();

function buildAppJwt() {
  const privateKey = fs.readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8');
  const nowSeconds = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iat: nowSeconds - 60, // back-dated to tolerate clock drift, per GitHub App docs
      exp: nowSeconds + 600, // GitHub's max JWT lifetime is 10 minutes
      iss: process.env.GITHUB_APP_ID,
    },
    privateKey,
    { algorithm: 'RS256' }
  );
}

// permissions, when given, narrows the resulting token below the App's own
// granted permissions (GitHub allows this on the access-token-minting call,
// but never the reverse).
async function mintInstallationToken(permissions) {
  const appJwt = buildAppJwt();
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;

  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(permissions ? { 'Content-Type': 'application/json' } : {}),
      },
      body: permissions ? JSON.stringify({ permissions }) : undefined,
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `GitHub installation token request failed with HTTP ${response.status}: ${body.slice(0, 300)}`
    );
  }

  const data = await response.json();
  return { token: data.token, expiresAt: new Date(data.expires_at).getTime() };
}

// getInstallationToken(cacheKey, permissions) -> Promise<string>. Returns the
// cached token for that key while it still has more than REFRESH_BUFFER_MS
// left on its ~1hr lifetime; mints a fresh one otherwise. Single attempt -
// fails loudly, no retry (unlike the model adapter, this isn't exercised
// under the same reliability pressure). `permissions` is only meaningful on
// first mint for a given key - see getCloneOnlyToken.
async function getInstallationToken(cacheKey = 'default', permissions = undefined) {
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return cached.token;
  }

  const { token, expiresAt } = await mintInstallationToken(permissions);
  tokenCache.set(cacheKey, { token, expiresAt });
  return token;
}

// getCloneOnlyToken() -> Promise<string>. Scoped to contents:read - used
// exclusively inside Phase 7's sandbox container for the clone step (see
// ROADMAP.md Phase 7).
function getCloneOnlyToken() {
  return getInstallationToken('clone-read-only', { contents: 'read' });
}

module.exports = { getInstallationToken, getCloneOnlyToken };
