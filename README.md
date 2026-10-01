# Apex

Internal AI-driven change-order implementation tool. An engineer picks a repo and
branch, clarifies a Change Order (CO) with an LLM, and Apex implements it in a
sandboxed container and pushes the result to a DEV branch.

See [ROADMAP.md](ROADMAP.md) for the full build plan and design decisions, and
[docs/Phase1_setup.md](docs/Phase1_setup.md) for detailed first-time setup and
troubleshooting.

## First-time setup

```
cp .env.example .env
make setup
make create-admin ARGS='--username=yourname --password=yourpassword --initials=XX --admin'
```

See [docs/Phase1_setup.md](docs/Phase1_setup.md) for what each step does.

## Running the app

Apex is made up of several independent processes, each started as its own
container. All of them need `apex-mariadb` up first (`make dev`/`make worker`/
`make spec-doc-worker` all start it automatically via their `db-up` dependency).

| Command                | Container                 | What it runs                                                             |
|------------------------|----------------------------|----------------------------------------------------------------------------|
| `make dev`             | `apex-app`                 | The web app (Express + EJS). Visit http://localhost:3000/login.           |
| `make worker`          | `apex-worker`               | `worker.js` — polls for queued sessions and drives each one's AI pipeline (clone/codegen/build/test/push) in its own sandbox container. |
| `make spec-doc-worker` | `apex-spec-doc-worker`      | `specDocWorker.js` — regenerates the Spec/Communication Protocol doc on its own interval, decoupled from the pipeline worker. |

`make dev` alone is enough to log in and browse repos/branches, but **AI pipeline
sessions need `make worker` running too** — without it, sessions just sit in
`queued` forever. Run each in its own terminal (they're detached containers, so you
don't strictly need to keep the terminal open, but running one target at a time
keeps the output readable).

```
make dev
make worker
make spec-doc-worker   # only needed if you're exercising Spec doc regeneration
```

To stop everything:

```
make stop       # removes apex-app, apex-worker, apex-spec-doc-worker
make db-down    # also stops apex-mariadb (keeps the data volume)
make clean      # full reset - also removes the data volume and network
```

## Viewing logs

Each process logs to its own container's stdout/stderr — there's no centralized log
file.

```
make logs                              # tails apex-app (the web process)
docker logs -f apex-worker              # the pipeline worker
docker logs -f apex-spec-doc-worker     # the spec-doc regeneration worker
docker logs -f apex-mariadb             # the database
```

(Substitute `podman` for `docker` if you're running with `RUNTIME=podman`.)

Drop `-f` to print what's logged so far and exit, instead of following live. Each
sandboxed pipeline session also gets its own ephemeral container (not listed above —
created and torn down per session); its build/test output is captured into the
`pipeline_runs` table rather than left in container logs, so use the branch/session
view in the UI to see that, not `docker logs`.

## Project structure

- `app/` — Express routes, views (EJS), and `lib/` service modules.
- `worker.js` — AI pipeline poller (see `make worker` above).
- `specDocWorker.js` — Spec/Communication Protocol doc regeneration loop.
- `db/schema.sql` — full data model, applied up front by `make setup`.
- `docs/` — setup guide, key-rotation runbook, Docker usage, and other operational docs.

## Connect to Database
```
docker exec -it apex-mariadb mariadb -uroot -p<rootpass> apex

docker exec -it apex-mariadb mariadb -uroot -p"$(grep '^DB_ROOT_PASSWORD=' .env | cut -d'=' -f2)" "$(grep '^DB_NAME=' .env | cut -d'=' -f2)"

```

