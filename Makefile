-include .env
export

MYSQL := mysql -h $(DB_HOST) -P $(DB_PORT) -u $(DB_USER) $(if $(DB_PASSWORD),-p$(DB_PASSWORD))

.PHONY: help setup db-create db-schema db-drop install dev start test-github-token test-model-adapter

help:
	@echo "Targets:"
	@echo "  setup               Create the database (if missing) and apply db/schema.sql"
	@echo "  db-create           Create the database if it doesn't exist"
	@echo "  db-schema           Apply db/schema.sql to the database"
	@echo "  db-drop             Drop the database - destructive, local dev only"
	@echo "  install             npm install app dependencies"
	@echo "  dev                 Run the app with auto-restart on file changes"
	@echo "  start               Run the app"
	@echo "  test-github-token   Manually verify GitHub App token minting (see Phase1_test.md)"
	@echo "  test-model-adapter  Manually verify the model adapter (see Phase1_test.md)"

setup: db-create db-schema

db-create:
	$(MYSQL) -e "CREATE DATABASE IF NOT EXISTS $(DB_NAME) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

db-schema:
	$(MYSQL) $(DB_NAME) < db/schema.sql

db-drop:
	$(MYSQL) -e "DROP DATABASE IF EXISTS $(DB_NAME);"

install:
	npm install

dev:
	npm run dev

start:
	npm start

test-github-token:
	node scripts/test-github-token.js

test-model-adapter:
	node scripts/test-model-adapter.js
