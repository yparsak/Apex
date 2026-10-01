// Shared create-user logic (see docs/Phase1_setup.md) used by both the
// scripts/createUser.js CLI and the Phase 2 admin User Maintenance route.
const bcrypt = require('bcryptjs');
const db = require('./db');

async function createUser({ username, password, initials, isAdmin = false }) {
  const passwordHash = await bcrypt.hash(password, 10);
  const [result] = await db.query(
    'INSERT INTO users (username, password_hash, initials, is_admin) VALUES (?, ?, ?, ?)',
    [username, passwordHash, initials, isAdmin]
  );
  return result.insertId;
}

// Self-service password change (see ROADMAP.md Phase 11) - caller is
// responsible for verifying the user's current password first (via
// authProvider.authenticate), same as createUser leaves hashing as the only
// concern here.
async function updatePassword(userId, newPassword) {
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId]);
}

module.exports = { createUser, updatePassword };
