// Mints short-lived GitHub App installation access tokens on demand. Tokens
// (and the App JWTs used to obtain them) are cached in memory only - never
// persisted (see notes.md / ROADMAP.md Phase 3).
const fs = require('fs');
const jwt = require('jsonwebtoken');

const REFRESH_BUFFER_MS = 60 * 1000;

let cachedToken = null;
let cachedExpiresAt = 0;

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

async function mintInstallationToken() {
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
      },
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

// getInstallationToken() -> Promise<string>. Returns the cached token while it
// still has more than REFRESH_BUFFER_MS left on its ~1hr lifetime; mints a
// fresh one otherwise. Single attempt - fails loudly, no retry (unlike the
// model adapter, this isn't exercised under the same reliability pressure).
async function getInstallationToken() {
  if (cachedToken && cachedExpiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return cachedToken;
  }

  const { token, expiresAt } = await mintInstallationToken();
  cachedToken = token;
  cachedExpiresAt = expiresAt;
  return cachedToken;
}

module.exports = { getInstallationToken };
