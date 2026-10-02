RUNTIME ?= docker

# .env is the single source of truth for DB credentials and the app port - both
# the Node app and this Makefile read the same file, so they can't drift out of
# sync with each other. -include tolerates a missing .env (e.g. before the
# first `cp .env.example .env`), falling back to the ?= defaults below.
# Caveat: this file is parsed by Make (via include), Docker (--env-file), and
# Node (dotenv) - keep values unquoted, and avoid literal `$` in any value,
# since Make treats it as a variable reference.
-include .env

NETWORK := apex-net
DB_CONTAINER := apex-mariadb
DB_VOLUME := apex-mariadb-data
DB_IMAGE := docker.io/library/mariadb:11
DB_NAME ?= apex
DB_USER ?= apex
DB_PASSWORD ?= apex_dev_password
DB_ROOT_PASSWORD ?= apex_dev_root_password

APP_CONTAINER := apex-app
WORKER_CONTAINER := apex-worker
SPEC_DOC_WORKER_CONTAINER := apex-spec-doc-worker
PORT ?= 3000
NODE_IMAGE := docker.io/library/node:22-slim

# Runs npm/node as the invoking host user, not container root - matters on a
# rootful Docker daemon (default on Linux), which otherwise leaves bind-mounted
# files (node_modules, etc.) owned by root on the host. Harmless no-op under
# rootless Podman, which already maps to the host user.
RUN_AS_HOST_USER := --user "$$(id -u):$$(id -g)" -e HOME=/tmp

.PHONY: setup network db-up db-wait migrate install dev worker spec-doc-worker stop create-admin logs db-down clean

setup: network db-up db-wait migrate install
	@echo ""
	@echo "Setup complete. Run 'make create-admin' to bootstrap a login, then 'make dev'."

network:
	$(RUNTIME) network inspect $(NETWORK) >/dev/null 2>&1 || $(RUNTIME) network create $(NETWORK)

db-up: network
	@$(RUNTIME) ps --format '{{.Names}}' | grep -qx '$(DB_CONTAINER)' || \
	$(RUNTIME) run -d --name $(DB_CONTAINER) --network $(NETWORK) \
	  -e MARIADB_DATABASE=$(DB_NAME) \
	  -e MARIADB_USER=$(DB_USER) \
	  -e MARIADB_PASSWORD=$(DB_PASSWORD) \
	  -e MARIADB_ROOT_PASSWORD=$(DB_ROOT_PASSWORD) \
	  -v $(DB_VOLUME):/var/lib/mysql \
	  $(DB_IMAGE)

db-wait:
	@echo "Waiting for MariaDB..."
	@until $(RUNTIME) exec $(DB_CONTAINER) mariadb-admin ping -h127.0.0.1 -uroot -p$(DB_ROOT_PASSWORD) --silent 2>/dev/null; do sleep 1; done
	@echo "MariaDB is ready."

migrate:
	cat db/schema.sql | $(RUNTIME) exec -i $(DB_CONTAINER) mariadb -h127.0.0.1 -uroot -p$(DB_ROOT_PASSWORD) $(DB_NAME)

install:
	$(RUNTIME) run --rm -v "$(CURDIR)":/app -w /app $(RUN_AS_HOST_USER) $(NODE_IMAGE) npm install

create-admin: db-up
	@echo "Usage: make create-admin ARGS='--username=yp --password=secret123 --initials=YP --admin'"
	$(RUNTIME) run --rm --network $(NETWORK) -v "$(CURDIR)":/app -w /app $(RUN_AS_HOST_USER) --env-file .env $(NODE_IMAGE) \
	  node scripts/createUser.js $(ARGS)

# Phase 12: --log-driver is explicit, not left to the daemon default - some
# Podman configs default to journald, which silently ignores max-size/
# max-file (they're json-file/k8s-file-only options), so `docker logs`/
# `podman logs` would keep growing unbounded despite these flags being passed.
dev: db-up
	@$(RUNTIME) rm -f $(APP_CONTAINER) 2>/dev/null || true
	$(RUNTIME) run -d --name $(APP_CONTAINER) --network $(NETWORK) \
	  --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
	  -v "$(CURDIR)":/app -w /app -p $(PORT):$(PORT) $(RUN_AS_HOST_USER) --env-file .env \
	  $(NODE_IMAGE) npx nodemon app.js
	@echo "Apex starting at http://localhost:$(PORT) (container: $(APP_CONTAINER))"

# Phase 7: runs worker.js, which polls for queued AI-pipeline sessions and
# drives each one's ephemeral sandbox container. Needs the host's Docker
# socket bind-mounted (Docker-outside-of-Docker - this container's own
# sandbox containers are created as siblings on the *host* daemon, not nested
# inside this container) and the docker CLI + git installed on top of the
# stock Node image, so it runs as root rather than RUN_AS_HOST_USER: apt-get
# install needs root, and root also sidesteps having to match this container's
# uid/gid against the host socket's owning group. ca-certificates is explicit
# here, not implicit via git's package dependencies: --no-install-recommends
# drops it (it's only a Recommends of the git package on Debian), and
# node:22-slim doesn't ship it either - without it, pushService.js's host-side
# `git push` to github.com fails with "server certificate verification
# failed. CAfile: none CRLfile: none".
worker: db-up
	@$(RUNTIME) rm -f $(WORKER_CONTAINER) 2>/dev/null || true
	$(RUNTIME) run -d --name $(WORKER_CONTAINER) --network $(NETWORK) \
	  --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
	  -v "$(CURDIR)":/app -w /app -v /var/run/docker.sock:/var/run/docker.sock \
	  --env-file .env $(NODE_IMAGE) \
	  sh -c "apt-get update -qq && apt-get install -y -qq --no-install-recommends docker.io git ca-certificates >/dev/null && npx nodemon worker.js"
	@echo "Apex pipeline worker started (container: $(WORKER_CONTAINER))"

# Phase 8: runs specDocWorker.js on its own interval loop, decoupled from
# worker.js's AI-pipeline poll loop (see ROADMAP.md Phase 8) - just GitHub +
# NIM network access needed, no Docker socket, so this uses the plain Node
# image the same way `dev` does.
spec-doc-worker: db-up
	@$(RUNTIME) rm -f $(SPEC_DOC_WORKER_CONTAINER) 2>/dev/null || true
	$(RUNTIME) run -d --name $(SPEC_DOC_WORKER_CONTAINER) --network $(NETWORK) \
	  --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
	  -v "$(CURDIR)":/app -w /app $(RUN_AS_HOST_USER) --env-file .env \
	  $(NODE_IMAGE) npx nodemon specDocWorker.js
	@echo "Apex spec-doc worker started (container: $(SPEC_DOC_WORKER_CONTAINER))"

logs:
	$(RUNTIME) logs -f $(APP_CONTAINER)

stop:
	$(RUNTIME) rm -f $(APP_CONTAINER) 2>/dev/null || true
	$(RUNTIME) rm -f $(WORKER_CONTAINER) 2>/dev/null || true
	$(RUNTIME) rm -f $(SPEC_DOC_WORKER_CONTAINER) 2>/dev/null || true

db-down:
	$(RUNTIME) rm -f $(DB_CONTAINER) 2>/dev/null || true

clean: stop db-down
	$(RUNTIME) volume rm $(DB_VOLUME) 2>/dev/null || true
	$(RUNTIME) network rm $(NETWORK) 2>/dev/null || true
