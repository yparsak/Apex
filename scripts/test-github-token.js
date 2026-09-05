// Manual test script for the GitHub App token-minting service. Run:
//   node scripts/test-github-token.js
// Requires GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, and
// GITHUB_APP_PRIVATE_KEY_PATH (or GITHUB_APP_PRIVATE_KEY) set in .env.
// Prints only the token's expiry and a masked prefix — never the full token.

require('dotenv').config();

const { mintInstallationToken } = require('../app/lib/github/githubAppTokenProvider');

async function main() {
  const { token, expiresAt } = await mintInstallationToken();
  const masked = `${token.slice(0, 6)}...`;
  console.log(`Token minted OK. Masked token: ${masked}  Expires at: ${expiresAt}`);
}

main().catch((err) => {
  console.error('Failed to mint installation token:', err.message);
  process.exit(1);
});
