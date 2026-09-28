// Bootstrap CLI for creating users. Exists because Phase 1 ships no admin UI
// yet - Phase 2's User Maintenance screen (see ROADMAP.md) is expected to call
// the same underlying create-user logic from a route instead of argv.
//
// Usage:
//   node scripts/createUser.js --username=yp --password=secret123 --initials=YP [--admin]
require('dotenv').config();

const bcrypt = require('bcryptjs');
const db = require('../app/lib/db');

function parseArgs(argv) {
  const args = { admin: false };
  for (const raw of argv) {
    if (raw === '--admin') {
      args.admin = true;
      continue;
    }
    const match = raw.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

async function main() {
  const { username, password, initials, admin } = parseArgs(process.argv.slice(2));

  if (!username || !password || !initials) {
    console.error(
      'Usage: node scripts/createUser.js --username=<u> --password=<p> --initials=<XX> [--admin]'
    );
    process.exitCode = 1;
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    await db.query(
      'INSERT INTO users (username, password_hash, initials, is_admin) VALUES (?, ?, ?, ?)',
      [username, passwordHash, initials, admin]
    );
    console.log(`Created user "${username}" (initials: ${initials}, admin: ${admin}).`);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      console.error(`User "${username}" already exists.`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.end());
