// Auth provider factory — the one place call sites go to get an AuthProvider.
// Routes must require this module, never a concrete provider class directly,
// so that adding an SSO provider later is a matter of implementing
// AuthProvider and adding a case here (plus flipping AUTH_PROVIDER) —
// no route/call-site changes.

const LocalPasswordAuthProvider = require('./localPasswordAuthProvider');

let instance;

function getAuthProvider() {
  if (!instance) {
    const providerName = process.env.AUTH_PROVIDER || 'local';

    switch (providerName) {
      case 'local':
        instance = new LocalPasswordAuthProvider();
        break;
      // case 'sso':
      //   instance = new SsoAuthProvider();
      //   break;
      default:
        throw new Error(`Unknown AUTH_PROVIDER "${providerName}"`);
    }
  }

  return instance;
}

module.exports = { getAuthProvider };
