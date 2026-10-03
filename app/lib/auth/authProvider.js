// Seam for swapping auth backends without touching call sites (see notes.md /
// ROADMAP.md Phase 1 - SSO is a future second implementation of this same
// contract: authenticate({ username, password }) -> user object or null).
//
// AUTH_PROVIDER selects which module implements that contract (see ROADMAP.md
// Phase 17). Only `local` exists today; a future SSO provider registers here
// under its own key and sets `managesPasswordsLocally = false` so the
// password-specific call sites gated on that flag (admin create-user,
// self-service password change) fall away without re-auditing each one.
const providers = {
  local: require('./localAuthProvider'),
};

const providerName = process.env.AUTH_PROVIDER || 'local';
const provider = providers[providerName];

if (!provider) {
  throw new Error(`Unknown AUTH_PROVIDER "${providerName}" - no auth provider module registered for it.`);
}

module.exports = provider;
