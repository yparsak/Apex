// Local/dev implementation of SecretsProvider, backed by the environment.
//
// For a secret named `NAME`, this checks `NAME_PATH` first and, if set,
// reads and returns that file's contents — this is how a multi-line PEM
// private key gets supplied without cramming newlines into a single env
// var. Falls back to reading `NAME` directly as the value otherwise.

const fs = require('fs');
const SecretsProvider = require('./secretsProvider');

class EnvSecretsProvider extends SecretsProvider {
  async getSecret(name) {
    const pathVar = `${name}_PATH`;
    const path = process.env[pathVar];
    if (path) {
      return fs.readFileSync(path, 'utf8');
    }

    const value = process.env[name];
    if (value) {
      return value;
    }

    throw new Error(`Secret "${name}" is not set — expected env var "${name}" or "${pathVar}"`);
  }
}

module.exports = EnvSecretsProvider;
