// Seam for swapping auth backends without touching call sites (see notes.md /
// ROADMAP.md Phase 1 - SSO is a future second implementation of this same
// contract: authenticate({ username, password }) -> user object or null).
const localAuthProvider = require('./localAuthProvider');

module.exports = localAuthProvider;
