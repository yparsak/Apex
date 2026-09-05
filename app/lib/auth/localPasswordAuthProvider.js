// Local username/password implementation of AuthProvider, backed by the
// `users` table. bcrypt-hashed passwords; never store or log plaintext.

const bcrypt = require('bcryptjs');
const AuthProvider = require('./authProvider');
const db = require('../db');

const SALT_ROUNDS = 12;

class LocalPasswordAuthProvider extends AuthProvider {
  async register(username, password, initials) {
    const existing = await db.query('SELECT id FROM users WHERE username = ?', [username]);
    if (existing.length > 0) {
      const err = new Error('Username already exists');
      err.code = 'USERNAME_TAKEN';
      throw err;
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await db.query(
      'INSERT INTO users (username, password_hash, initials) VALUES (?, ?, ?)',
      [username, passwordHash, initials]
    );

    return { id: result.insertId, username, initials };
  }

  async verify(username, password) {
    const rows = await db.query(
      'SELECT id, username, password_hash, initials FROM users WHERE username = ?',
      [username]
    );
    if (rows.length === 0) return null;

    const user = rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) return null;

    return { id: user.id, username: user.username, initials: user.initials };
  }
}

module.exports = LocalPasswordAuthProvider;
