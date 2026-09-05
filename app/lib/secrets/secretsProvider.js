// SecretsProvider interface (contract only — never instantiate directly).
//
// Today, secrets (e.g. the GitHub App private key) live in local env vars /
// files. A future real secrets manager (AWS Secrets Manager, Vault, etc.)
// must implement this same shape. Call sites depend only on this interface
// (obtained via `getSecretsProvider()` in ./index.js), never on a concrete
// provider class, so swapping the backend later is a drop-in change:
// implement this contract, flip SECRETS_PROVIDER, done. Mirrors the
// AuthProvider pattern in app/lib/auth/.
class SecretsProvider {
  /**
   * Resolve a named secret.
   * @param {string} name
   * @returns {Promise<string>}
   */
  async getSecret(_name) {
    throw new Error('SecretsProvider.getSecret() is not implemented');
  }
}

module.exports = SecretsProvider;
