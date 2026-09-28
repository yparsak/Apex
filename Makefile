PODMAN := /opt/podman/bin/podman

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

.PHONY: setup network db-up db-wait migrate install dev stop create-admin logs db-down clean

setup: network db-up db-wait migrate install
	@echo ""
	@echo "Setup complete. Run 'make create-admin' to bootstrap a login, then 'make dev'."

network:
	$(PODMAN) network exists $(NETWORK) || $(PODMAN) network create $(NETWORK)

db-up: network
	@$(PODMAN) ps --format '{{.Names}}' | grep -qx '$(DB_CONTAINER)' || \
	$(PODMAN) run -d --name $(DB_CONTAINER) --network $(NETWORK) \
	  -e MARIADB_DATABASE=$(DB_NAME) \
	  -e MARIADB_USER=$(DB_USER) \
	  -e MARIADB_PASSWORD=$(DB_PASSWORD) \
	  -e MARIADB_ROOT_PASSWORD=$(DB_ROOT_PASSWORD) \
	  -p 3306:3306 \
	  -v $(DB_VOLUME):/var/lib/mysql \
	  $(DB_IMAGE)

db-wait:
	@echo "Waiting for MariaDB..."
	@until $(PODMAN) exec $(DB_CONTAINER) mariadb-admin ping -uroot -p$(DB_ROOT_PASSWORD) --silent 2>/dev/null; do sleep 1; done
	@echo "MariaDB is ready."

migrate:
	cat db/schema.sql | $(PODMAN) exec -i $(DB_CONTAINER) mariadb -uroot -p$(DB_ROOT_PASSWORD) $(DB_NAME)

install:
	$(PODMAN) run --rm -v "$(CURDIR)":/app -w /app $(NODE_IMAGE) npm install

create-admin: db-up
	@echo "Usage: make create-admin ARGS='--username=yp --password=secret123 --initials=YP --admin'"
	$(PODMAN) run --rm --network $(NETWORK) -v "$(CURDIR)":/app -w /app --env-file .env $(NODE_IMAGE) \
	  node scripts/createUser.js $(ARGS)

dev: db-up
	@$(PODMAN) rm -f $(APP_CONTAINER) 2>/dev/null || true
	$(PODMAN) run -d --name $(APP_CONTAINER) --network $(NETWORK) \
	  -v "$(CURDIR)":/app -w /app -p $(APP_PORT):$(APP_PORT) --env-file .env \
	  $(NODE_IMAGE) npx nodemon app.js
	@echo "Apex starting at http://localhost:$(APP_PORT) (container: $(APP_CONTAINER))"

logs:
	$(PODMAN) logs -f $(APP_CONTAINER)

stop:
	$(PODMAN) rm -f $(APP_CONTAINER) 2>/dev/null || true

db-down:
	$(PODMAN) rm -f $(DB_CONTAINER) 2>/dev/null || true

clean: stop db-down
	$(PODMAN) volume rm $(DB_VOLUME) 2>/dev/null || true
	$(PODMAN) network rm $(NETWORK) 2>/dev/null || true
