const bcrypt = require('bcryptjs');
const db = require('../db');

// authenticate({ username, password }) -> user object or null.
// Implements the authProvider contract (see authProvider.js) against the local
// users table with bcrypt-hashed passwords.
async function authenticate({ username, password }) {
  const [rows] = await db.query(
    'SELECT id, username, password_hash, initials, is_admin FROM users WHERE username = ? LIMIT 1',
    [username]
  );
  const row = rows[0];
  if (!row) return null;

  const passwordMatches = await bcrypt.compare(password, row.password_hash);
  if (!passwordMatches) return null;

  return {
    id: row.id,
    username: row.username,
    initials: row.initials,
    isAdmin: Boolean(row.is_admin),
  };
}

// Capability flag consumed by password-specific call sites (admin create-user,
// self-service password change) instead of scattered AUTH_PROVIDER === 'local'
// checks (see ROADMAP.md Phase 17).
module.exports = { authenticate, managesPasswordsLocally: true };
