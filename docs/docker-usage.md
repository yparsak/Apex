# How Docker is used in Apex

Docker shows up in two unrelated roles in this codebase: running the app's own
supporting services during development, and running each AI pipeline session's
sandboxed code execution. This document covers both.

## 1. Infrastructure containers (dev environment)

Driven entirely by the `Makefile`. Docker runs the app's own supporting processes as
long-lived containers on a shared `apex-net` network:

- `apex-mariadb` — the database (`make db-up`).
- `apex-app` — the Express app itself, running `nodemon app.js` (`make dev`).
- `apex-worker` — `worker.js`, the AI-pipeline poller (`make worker`).
- `apex-doc-worker` — `docWorker.js`, the generated-document regeneration script
  (`make doc-worker`), run once nightly by cron rather than staying up as a
  persistent container (see ROADMAP.md Phase 15). It regenerates whichever
  document types an admin has enabled on `/admin/documents` (Phase 23).

All of these bind-mount the repo into the container and run off the stock
`node:22-slim` image — there's no custom Dockerfile for the app itself. Most targets
run as the invoking host user (`RUN_AS_HOST_USER`) so bind-mounted files (e.g.
`node_modules`) aren't left owned by root on a rootful Docker daemon.

`apex-app`/`apex-worker` also run with `--log-opt max-size=10m --log-opt max-file=3`
(see ROADMAP.md Phase 12), so `docker logs`/`podman logs` output for each stays
bounded instead of growing unbounded. `apex-doc-worker` doesn't need this - as a
one-shot `--rm` container (Phase 15) it never accumulates enough log output to
matter, and is gone by the time a count-based rotation would do anything. This is
independent of, and in addition to, the structured, rotated
`logs/*.log` files each process also writes via [`app/lib/logger.js`](../app/lib/logger.js)
(pino) — the Docker-level flags bound the container's own log driver storage; the
`logs/` files are what survive container recreation and are directly `grep`-able from
the host.

## 2. Ephemeral sandbox containers (per-session code execution)

This is the more interesting half, built in Phase 7 of [ROADMAP.md](../ROADMAP.md).
Every AI pipeline session (clone → codegen → build → test → push) runs inside its own
throwaway container, driven by
[`app/lib/docker/dockerRunner.js`](../app/lib/docker/dockerRunner.js) — a thin wrapper
that shells out to the `docker` CLI (`child_process.spawn`), not a Docker SDK client,
consistent with this project's "plain Docker containers" stack decision.

Lifecycle, orchestrated by
[`app/lib/pipeline/pipelineRunner.js`](../app/lib/pipeline/pipelineRunner.js):

- **Created** from each repo's own declared image (`apex.pipeline.json`'s `image`
  field — the runner never invents a default). Started with
  `--entrypoint sleep ... infinity` so it just stays alive for the `docker exec` calls
  that follow, rather than running the image's own default command.
- **Network is a per-step toggle, not a fixed container property**: open during
  clone/codegen (so the model adapter can reach NIM, and the sandbox can reach
  GitHub), then `docker network disconnect` seals it before build/test run — so a
  repo's build/test commands have no registry egress (npm/PyPI/Maven/etc.) once
  sealed. Repos must vendor/cache all dependencies up front for this reason.
- **Reads, writes, build, and test** all happen via `docker exec` into the container;
  nothing is bind-mounted from the host for the sandboxed code itself. File writes are
  streamed over stdin (`sh -c 'mkdir -p ... && cat > ...'`) rather than embedded in an
  argv string, avoiding shell-escaping and `ARG_MAX` issues.

  *Reads* are new in Phase 21, and they reverse something this document previously
  implied: the container used to be write-only to codegen, with every read served from
  GitHub. It now serves every codegen read — whole files, line ranges, and the file list
  the structural index is built from. The read path (`dockerRunner.readFile`) emits the
  file's byte size on its own line *before* any content, because `dockerRunner` clips
  stdout at 5 MB silently and a size inferred from a clipped read is how a ranged write
  ends up splicing into a file it only half has.
- **An index-building pass runs at the start of codegen**, which is the one new thing an
  operator will notice in a pipeline run's logs. It is a single `exec` — `git ls-files`
  piped into an `awk` script staged at `/tmp/apex-outline.awk` — producing exact line
  counts and a per-file declaration outline from the clone that is already there.
  Expect either `structural index built` (with a file count) or `structural index
  unavailable - codegen continues without outlines` (with a reason) in the worker log,
  once per codegen stage.

  **What this expects of the sandbox image:** only POSIX `sh`, `awk`, and `git`. `git`
  is already a hard requirement — the clone step runs inside this same image — so in
  practice the new demand is `awk`, which every mainstream base image including Alpine's
  busybox provides. Verified to produce identical output under busybox awk, mawk, and
  gawk. The pass deliberately avoids `{n,m}` regex intervals and bracket-escaped
  brackets for exactly that reason. **An image without `awk` does not fail the
  pipeline** — the index is a navigation aid, the build logs a warning, and codegen
  continues.
- **Push happens via the host, not the container**: after tests pass, the container's
  already-committed working tree is pulled out with `docker cp` into a host temp dir,
  and the *host* process pushes it with plain `git`. The write-capable GitHub push
  token never enters the sandbox — only a `contents: read`-scoped clone token is used
  inside the container.
- **Kept alive on failure**: a failing container is *not* torn down immediately.
  `pipeline_runs.container_id` keeps pointing at it so Phase 9's "resume from failed
  step" can `docker exec` back into the same container and continue from the last
  successful step (reusing whatever that step already produced), rather than
  re-running the whole pipeline from scratch. Capped at 3 resume attempts
  (`resume_attempt_count`); past that, the container is torn down and the session
  falls back to a full from-scratch retry. A container is only `docker rm -f`'d on
  success, resume-limit exhaustion, or explicit retry/abandonment — there's currently
  no timeout-based cleanup for a container that's simply never retried and never
  explicitly abandoned (see ROADMAP.md's Open/future list).

## Docker-outside-of-Docker

`worker.js` itself runs inside the `apex-worker` container, so the sandbox containers
it creates need to be *siblings* on the host's Docker daemon, not nested inside
`apex-worker`. The `worker` Makefile target bind-mounts the host's
`/var/run/docker.sock` into the worker container and installs the `docker` CLI + `git`
on top of the stock Node image. This is also why `apex-worker` runs as root instead of
`RUN_AS_HOST_USER`: `apt-get install` needs root, and root sidesteps having to match
the container's uid/gid against the host socket's owning group.

It's also why sandbox containers clone into their own internal filesystem rather than
a bind-mounted host directory — a host path specified from inside the worker
container wouldn't resolve correctly against the host daemon that actually creates the
sibling sandbox container.

## Where Docker is *not* involved

- `apex-app` (the web process) never touches the Docker socket or creates sandbox
  containers directly — only `worker.js` does, consistent with the
  Docker-outside-of-Docker setup above.
- `docWorker.js` doesn't use Docker/sandboxing at all — it only needs GitHub and
  NIM network access, so it runs on the plain Node image the same way `make dev` does.
  It's also the one container here that isn't long-running: `make doc-worker`
  runs it to completion and removes it (`--rm`), meant to be invoked nightly by cron
  rather than kept alive (see ROADMAP.md Phase 15).
