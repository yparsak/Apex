// Secrets provider factory — the one place call sites go to get a
// SecretsProvider. Code that needs a secret (e.g. the GitHub App private
// key) must require this module, never a concrete provider class directly,
// so that adding a real secrets manager later is a matter of implementing
// SecretsProvider and adding a case here (plus flipping SECRETS_PROVIDER) —
// no call-site changes. Mirrors app/lib/auth/index.js.

const EnvSecretsProvider = require('./envSecretsProvider');

let instance;

function getSecretsProvider() {
  if (!instance) {
    const providerName = process.env.SECRETS_PROVIDER || 'env';

    switch (providerName) {
      case 'env':
        instance = new EnvSecretsProvider();
        break;
      // case 'aws-secrets-manager':
      //   instance = new AwsSecretsManagerProvider();
      //   break;
      default:
        throw new Error(`Unknown SECRETS_PROVIDER "${providerName}"`);
    }
  }

  return instance;
}

module.exports = { getSecretsProvider };
