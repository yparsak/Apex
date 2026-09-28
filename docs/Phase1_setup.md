# Phase 1 setup

Apex's local dev environment runs entirely through [podman](https://podman.io/)
containers — there is no Node.js or MariaDB installed on the host, and none is
required. `podman machine` must already be running (`podman machine list` should show
a `Currently running` VM); this is a one-time setup on a new machine, not covered here.

## First-time setup

```
cp .env.example .env
make setup
```

`make setup` will:

1. Create the `apex-net` podman network (if it doesn't already exist).
2. Start a MariaDB 11 container (`apex-mariadb`), persisted to the `apex-mariadb-data`
   volume.
3. Apply [db/schema.sql](../db/schema.sql) — all tables, not just the ones Phase 1
   uses (see ROADMAP.md: the full data model is migrated up front).
4. Install npm dependencies into `node_modules` on the host filesystem (bind-mounted
   into a throwaway Node container to do the install — nothing is installed on the
   host itself).

`make setup` is safe to re-run; it skips creating the network/DB container if they
already exist and just re-applies the schema and dependencies.

## Bootstrap an admin user

Phase 1 ships no admin UI yet (that's Phase 2), so the very first user has to be
created from the command line:

```
make create-admin ARGS='--username=yourname --password=yourpassword --initials=XX --admin'
```

`initials` is what later phases use for branch naming (`dev/{initials}-{CO}-{n}`).

## Run the app

```
make dev
```

Starts Apex in a Node container with `nodemon` (auto-restarts on file changes,
since the source directory is bind-mounted). Visit **http://localhost:3000/login**.

Useful during development:

```
make logs    # tail the app container's stdout/stderr
make stop    # stop just the app container
```

## Tearing down

```
make db-down   # stop and remove the MariaDB container (keeps the data volume)
make clean     # also removes the data volume and the network - full reset
```

## Troubleshooting

- **"MariaDB is ready" never prints during `make setup`**: check
  `podman logs apex-mariadb` — most often a stale container from a previous crashed
  run; `make clean` and retry.
- **Port 3000 or 3306 already in use**: something else on the host (or a leftover
  container) is bound to it. `podman ps` to check for leftover `apex-app` /
  `apex-mariadb` containers from a previous session.
