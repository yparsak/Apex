// Bootstrap CLI for creating users. Still needed for the very first admin
// (Phase 2's User Maintenance screen requires an admin to already be logged
// in), and shares createUser logic with that screen via userService.js.
//
// Usage:
//   node scripts/createUser.js --username=yp --password=secret123 --initials=YP [--admin]
require('dotenv').config();

const db = require('../app/lib/db');
const { createUser } = require('../app/lib/userService');

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

  try {
    await createUser({ username, password, initials, isAdmin: admin });
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
