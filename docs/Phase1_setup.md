# Phase 1 setup

Apex's dev/deploy environment runs entirely through containers — there is no Node.js or
MariaDB installed on the host, and none is required. The `Makefile` defaults to
[Docker](https://docs.docker.com/), overridable with `make <target> RUNTIME=podman` if
you'd rather use [Podman](https://podman.io/) (e.g. on macOS).

- **Docker on Linux (e.g. a Raspberry Pi):** the daemon must be running
  (`sudo systemctl enable --now docker`), and your user must be in the `docker` group
  (`sudo usermod -aG docker $USER`, then log out/in) so `make` doesn't need `sudo` —
  running it under `sudo` would make root, not you, own bind-mounted files like
  `node_modules`.
- **Podman:** `podman machine` must already be running on macOS
  (`podman machine list` should show a `Currently running` VM); not needed on Linux,
  where Podman talks to the kernel directly.

## First-time setup

```
cp .env.example .env
make setup
```

`make setup` will:

1. Create the `apex-net` network (if it doesn't already exist).
2. Start a MariaDB 11 container (`apex-mariadb`), persisted to the `apex-mariadb-data`
   volume. Not published to the host — the app reaches it over the `apex-net` network
   by container name, so it can't collide with a MySQL/MariaDB already running on the
   host. To poke at it directly: `docker exec -it apex-mariadb mariadb -uroot -p<root
   password from .env> apex`.
3. Apply [db/schema.sql](../db/schema.sql) — all tables, not just the ones Phase 1
   uses (see ROADMAP.md: the full data model is migrated up front).
4. Install npm dependencies into `node_modules` on the host filesystem (bind-mounted
   into a throwaway Node container to do the install — nothing is installed on the
   host itself).

`make setup` is safe to re-run; it skips creating the network/DB container if they
already exist and just re-applies the schema and dependencies.

## Bootstrap an admin user

The Phase 2 admin UI needs an admin to already be logged in, so the very first user has
to be created from the command line:

```
make create-admin ARGS='--username=yourname --password=yourpassword --initials=XX --admin'
```

`initials` is what later phases use for branch naming (`dev/{initials}-{CO}-{n}`). Once
this user exists, use `/admin` in the browser to create everyone else.

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
  `docker logs apex-mariadb` (or `podman logs ...`) — most often a stale container from
  a previous crashed run; `make clean` and retry.
- **Port 3000 already in use**: something else on the host (or a leftover container)
  is bound to it. `docker ps` (or `podman ps`) to check for a leftover `apex-app`
  container from a previous session.
- **`permission denied` on the Docker socket**: your user isn't in the `docker` group
  yet (see above) — don't work around it with `sudo make ...`, it'll leave root-owned
  files in the repo.
