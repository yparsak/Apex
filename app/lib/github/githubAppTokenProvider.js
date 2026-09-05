// GitHub App installation-token minting service.
//
// Mints short-lived installation access tokens on demand and hands them
// back to the caller in memory only — nothing here writes a token to the
// DB, disk, or logs. The App itself is scoped to `contents: write` only
// (configured on GitHub, not here).
//
// Branch-pattern scoping note: GitHub's installation-token API has no
// branch-level scoping parameter — only repo-level (`repositories` /
// `repository_ids`). Restricting *which branches* this token can push to
// (the `dev/**` pattern from roadmap.md) is enforced separately via a
// GitHub repository ruleset (Settings > Rules > Rulesets) that restricts
// pushes matching `dev/**` to this App's installation. That's a one-time,
// org-admin GitHub configuration step — there is no code-side mechanism to
// add here, so don't go looking for one.

const jwt = require('jsonwebtoken');
const { getSecretsProvider } = require('../secrets');
const logger = require('../logger');

const JWT_CLOCK_DRIFT_TOLERANCE_SECONDS = 60;
const JWT_MAX_LIFETIME_SECONDS = 600; // GitHub's hard cap on App JWTs.

async function mintInstallationToken({ repositories } = {}) {
  const appId = process.env.GITHUB_APP_ID;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
  if (!appId || !installationId) {
    throw new Error('GITHUB_APP_ID and GITHUB_APP_INSTALLATION_ID must both be set');
  }

  const privateKey = await getSecretsProvider().getSecret('GITHUB_APP_PRIVATE_KEY');

  const now = Math.floor(Date.now() / 1000);
  const appJwt = jwt.sign(
    {
      iat: now - JWT_CLOCK_DRIFT_TOLERANCE_SECONDS,
      exp: now + JWT_MAX_LIFETIME_SECONDS,
      iss: appId,
    },
    privateKey,
    { algorithm: 'RS256' }
  );

  const body = repositories ? { repositories } : undefined;

  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub installation token request failed (${response.status}): ${detail}`);
  }

  const data = await response.json();

  logger.info('minted GitHub installation token', {
    installationId,
    expiresAt: data.expires_at,
  });

  return { token: data.token, expiresAt: data.expires_at };
}

module.exports = { mintInstallationToken };
