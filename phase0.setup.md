# Setup

Phase 0: gets a local database and the Node app running from a clean checkout.

## Prerequisites

- MariaDB server, reachable from your machine (local install or a container).
- `mysql` CLI client on your `PATH` (ships with MariaDB/MySQL; used by the `Makefile` to talk to the database).
- Node.js (latest LTS) and `npm` on your `PATH`.

## Steps

1. Copy the env template and fill in your local database connection details:

   ```
   cp .env.example .env
   ```

   Edit `.env` — `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, and the app vars added below (`PORT`, `SESSION_SECRET`, `AUTH_PROVIDER`).

   `SESSION_SECRET` is required — the server refuses to start without it. Generate one locally:

   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. Create the database and apply the schema:

   ```
   make setup
   ```

   This runs `db-create` (creates the database if it doesn't already exist) followed by `db-schema` (applies [`db/schema.sql`](db/schema.sql)).

3. Confirm the tables exist:

   ```
   mysql -h $DB_HOST -P $DB_PORT -u $DB_USER -p $DB_NAME -e "SHOW TABLES;"
   ```

4. Install app dependencies:

   ```
   make install
   ```

5. Run the app:

   ```
   make dev     # auto-restarts on file changes (node --watch)
   make start   # plain run
   ```

   The server listens on `PORT` (default `3000`) and logs `Apex server listening on port <PORT>` once up.

## Trying the auth endpoints

With the server running:

```
curl -i -c cookies.txt -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"jdoe","password":"correct-horse","initials":"JD"}'

curl -i -b cookies.txt -c cookies.txt -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"jdoe","password":"correct-horse"}'

curl -i -b cookies.txt http://localhost:3000/auth/me

curl -i -b cookies.txt -X POST http://localhost:3000/auth/logout
```

`-c cookies.txt` / `-b cookies.txt` persist the session cookie across calls, the way a browser would.

## Other Makefile targets

- `make db-create` — create the database only.
- `make db-schema` — (re-)apply the schema to an existing database.
- `make db-drop` — drop the database. Destructive; local dev only.
- `make install` — `npm install` app dependencies.
- `make dev` / `make start` — run the app.
- `make help` — list all targets.

## Notes

- `db/schema.sql` mirrors the "Data model (Phase 0)" section of [`roadmap.md`](roadmap.md) — if you change one, update the other.
- Auth is username/password against the `users` table, bcrypt-hashed (via `bcryptjs`, a pure-JS implementation — avoids native-module build issues in this environment; drop-in compatible hash format with `bcrypt` if you want to swap later), behind an `AuthProvider` interface (`app/lib/auth/authProvider.js`) so an SSO implementation can be swapped in later without touching route code. See `app/lib/auth/` for the interface and the local implementation.
- HTTP sessions use `express-session` with the default in-memory `MemoryStore` — a deliberate choice for this local-dev/prototype stage, not a production-ready store (sessions are lost on restart and don't scale across processes). If/when a persistent store is added, its table/collection must NOT be named `sessions` — that name is already used by the async AI-agent job table in `db/schema.sql`, and a collision there would be silent and hard to debug.
