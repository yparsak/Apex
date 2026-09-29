RUNTIME ?= docker

NETWORK := apex-net
DB_CONTAINER := apex-mariadb
DB_VOLUME := apex-mariadb-data
DB_IMAGE := docker.io/library/mariadb:11
DB_NAME := apex
DB_USER := apex
DB_PASSWORD := apex_dev_password
DB_ROOT_PASSWORD := apex_dev_root_password

APP_CONTAINER := apex-app
APP_PORT := 3000
NODE_IMAGE := docker.io/library/node:22-slim

# Runs npm/node as the invoking host user, not container root - matters on a
# rootful Docker daemon (default on Linux), which otherwise leaves bind-mounted
# files (node_modules, etc.) owned by root on the host. Harmless no-op under
# rootless Podman, which already maps to the host user.
RUN_AS_HOST_USER := --user "$$(id -u):$$(id -g)" -e HOME=/tmp

.PHONY: setup network db-up db-wait migrate install dev stop create-admin logs db-down clean

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
	@until $(RUNTIME) exec $(DB_CONTAINER) mariadb-admin ping -uroot -p$(DB_ROOT_PASSWORD) --silent 2>/dev/null; do sleep 1; done
	@echo "MariaDB is ready."

migrate:
	cat db/schema.sql | $(RUNTIME) exec -i $(DB_CONTAINER) mariadb -uroot -p$(DB_ROOT_PASSWORD) $(DB_NAME)

install:
	$(RUNTIME) run --rm -v "$(CURDIR)":/app -w /app $(RUN_AS_HOST_USER) $(NODE_IMAGE) npm install

create-admin: db-up
	@echo "Usage: make create-admin ARGS='--username=yp --password=secret123 --initials=YP --admin'"
	$(RUNTIME) run --rm --network $(NETWORK) -v "$(CURDIR)":/app -w /app $(RUN_AS_HOST_USER) --env-file .env $(NODE_IMAGE) \
	  node scripts/createUser.js $(ARGS)

dev: db-up
	@$(RUNTIME) rm -f $(APP_CONTAINER) 2>/dev/null || true
	$(RUNTIME) run -d --name $(APP_CONTAINER) --network $(NETWORK) \
	  -v "$(CURDIR)":/app -w /app -p $(APP_PORT):$(APP_PORT) $(RUN_AS_HOST_USER) --env-file .env \
	  $(NODE_IMAGE) npx nodemon app.js
	@echo "Apex starting at http://localhost:$(APP_PORT) (container: $(APP_CONTAINER))"

logs:
	$(RUNTIME) logs -f $(APP_CONTAINER)

stop:
	$(RUNTIME) rm -f $(APP_CONTAINER) 2>/dev/null || true

db-down:
	$(RUNTIME) rm -f $(DB_CONTAINER) 2>/dev/null || true

clean: stop db-down
	$(RUNTIME) volume rm $(DB_VOLUME) 2>/dev/null || true
	$(RUNTIME) network rm $(NETWORK) 2>/dev/null || true
