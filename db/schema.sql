-- Apex schema. Full data model migrated up front (see ROADMAP.md Phase 1).
-- Most tables here are not read/written until later phases; they exist now so no
-- phase needs a follow-up migration for something notes.md already specifies.

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------------
-- Phase 1: auth
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  initials VARCHAR(10) NOT NULL,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Phase 2 / Phase 4: orgs, repo groups, repos, permissions, change orders, branches
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS orgs (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_orgs_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS repo_groups (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id INT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_repo_groups_org_name (org_id, name),
  CONSTRAINT fk_repo_groups_org FOREIGN KEY (org_id) REFERENCES orgs (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS repos (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  repo_group_id INT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  description VARCHAR(500) NULL,
  default_branch_name VARCHAR(255) NOT NULL DEFAULT 'main',
  -- Superseded by the repo_doc_sync table in Phase 23 and no longer read or
  -- written by any code. Kept, not dropped: the backfill below reads it, and
  -- dropping a column is the one genuinely irreversible step in that migration
  -- (see undecided_topics.md). Treat it as frozen history, not current state.
  spec_doc_synced_commit_sha VARCHAR(40) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_repos_group_name (repo_group_id, name),
  CONSTRAINT fk_repos_repo_group FOREIGN KEY (repo_group_id) REFERENCES repo_groups (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_repo_group_permissions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NOT NULL,
  repo_group_id INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_repo_group (user_id, repo_group_id),
  CONSTRAINT fk_urgp_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_urgp_repo_group FOREIGN KEY (repo_group_id) REFERENCES repo_groups (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS change_orders (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  repo_id INT UNSIGNED NOT NULL,
  co_number VARCHAR(9) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_change_orders_repo_co (repo_id, co_number),
  CONSTRAINT fk_change_orders_repo FOREIGN KEY (repo_id) REFERENCES repos (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS branches (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  repo_id INT UNSIGNED NOT NULL,
  initials VARCHAR(10) NOT NULL,
  co_number VARCHAR(9) NOT NULL,
  increment INT UNSIGNED NOT NULL,
  branch_name VARCHAR(255) NOT NULL,
  status ENUM('active', 'stale', 'deleted') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_branches_repo_initials_co_increment (repo_id, initials, co_number, increment),
  CONSTRAINT fk_branches_repo FOREIGN KEY (repo_id) REFERENCES repos (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- schema.sql has no incremental migration files - branches already existed
-- before Phase 13 added the 'stale' status, so the enum needs its own
-- idempotent widening (MODIFY COLUMN re-stating the same definition is a
-- no-op on a rerun, same spirit as the ADD COLUMN IF NOT EXISTS pattern used
-- elsewhere in this file for additive changes).
ALTER TABLE branches MODIFY COLUMN status ENUM('active', 'stale', 'deleted') NOT NULL DEFAULT 'active';

-- Phase 18: git refs are case-sensitive, so dev/jd-C00000001-1 and
-- dev/JD-C00000001-1 are two genuinely different branches on GitHub. Under
-- utf8mb4's default (case-insensitive) collation,
-- uq_branches_repo_initials_co_increment collapsed those into one slot and
-- rejected the second - for the wrong reason, and still rejecting it after the
-- first was soft-deleted, since a deleted row keeps occupying the slot.
-- initials therefore becomes case-sensitive at the DB level and the real rule
-- ("never two *live* branches for one logical slot") moves into
-- branchService.js, where it can actually consult status. Re-running this
-- MODIFY is a no-op, same idempotent-ALTER pattern as above.
ALTER TABLE branches MODIFY COLUMN initials VARCHAR(10) COLLATE utf8mb4_bin NOT NULL;

-- ---------------------------------------------------------------------------
-- Phase 5 / Phase 7 / Phase 8: sessions, requirements, pipeline execution
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sessions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  branch_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  status ENUM('awaiting_approval', 'queued', 'running', 'completed', 'failed') NOT NULL DEFAULT 'awaiting_approval',
  approved_at TIMESTAMP NULL,
  -- resume_requested: set when 'queued' via the Phase 9 resume-from-failed-
  -- step action rather than a normal approval/full retry - the only signal
  -- worker.js has for which pipelineRunner entry point (run vs. resume) to
  -- call, since both leave the session in the same 'queued' status.
  resume_requested BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sessions_branch (branch_id),
  KEY idx_sessions_user (user_id),
  CONSTRAINT fk_sessions_branch FOREIGN KEY (branch_id) REFERENCES branches (id),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- schema.sql has no incremental migration files - sessions already existed
-- before Phase 9 added this column, so it needs its own idempotent ALTER
-- (see the identical pattern for pipeline_runs.container_id in Phase 7).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS resume_requested BOOLEAN NOT NULL DEFAULT FALSE AFTER approved_at;

CREATE TABLE IF NOT EXISTS session_requirements (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id INT UNSIGNED NOT NULL,
  requirement_text TEXT NOT NULL,
  overlap_flag_requirement_id INT UNSIGNED NULL,
  confirm_status ENUM('pending_confirm', 'confirmed_proceed', 'confirmed_skip') NOT NULL DEFAULT 'confirmed_proceed',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_session_requirements_session (session_id),
  CONSTRAINT fk_session_requirements_session FOREIGN KEY (session_id) REFERENCES sessions (id),
  CONSTRAINT fk_session_requirements_overlap FOREIGN KEY (overlap_flag_requirement_id) REFERENCES session_requirements (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS conversations (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id INT UNSIGNED NOT NULL,
  role ENUM('user', 'assistant') NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_conversations_session (session_id),
  CONSTRAINT fk_conversations_session FOREIGN KEY (session_id) REFERENCES sessions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_log (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id INT UNSIGNED NULL,
  user_id INT UNSIGNED NULL,
  action VARCHAR(255) NOT NULL,
  detail TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_log_session (session_id),
  KEY idx_audit_log_user (user_id),
  CONSTRAINT fk_audit_log_session FOREIGN KEY (session_id) REFERENCES sessions (id),
  CONSTRAINT fk_audit_log_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pipeline_locks (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  repo_id INT UNSIGNED NOT NULL,
  co_number VARCHAR(9) NOT NULL,
  session_id INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pipeline_locks_repo_co (repo_id, co_number),
  CONSTRAINT fk_pipeline_locks_repo FOREIGN KEY (repo_id) REFERENCES repos (id),
  CONSTRAINT fk_pipeline_locks_session FOREIGN KEY (session_id) REFERENCES sessions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- pipeline_runs.stage / resume_attempt_count support the Phase 9 progress
-- indicator and resume-from-failed-step retry (see ROADMAP.md Phase 7/Phase 9).
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id INT UNSIGNED NOT NULL,
  attempt_number INT UNSIGNED NOT NULL DEFAULT 1,
  status ENUM('running', 'completed', 'failed') NOT NULL DEFAULT 'running',
  stage ENUM('cloning', 'codegen', 'building', 'testing', 'pushing') NULL,
  resume_attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  -- container_id: the ephemeral sandbox container for this run (see
  -- ROADMAP.md Phase 7). Cleared to NULL on success; left set on failure so
  -- Phase 9's resume-from-step retry can reuse the kept-alive container.
  container_id VARCHAR(64) NULL,
  error_message TEXT NULL,
  build_log LONGTEXT NULL,
  test_log LONGTEXT NULL,
  commit_sha VARCHAR(40) NULL,
  spec_doc_path VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_pipeline_runs_session (session_id),
  CONSTRAINT fk_pipeline_runs_session FOREIGN KEY (session_id) REFERENCES sessions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- schema.sql has no incremental migration files - CREATE TABLE IF NOT EXISTS
-- makes re-running it safe for new tables, but pipeline_runs already existed
-- before Phase 7 added these two columns, so they need their own idempotent
-- ALTER (MariaDB-specific IF NOT EXISTS on ADD COLUMN, supported since 10.0.2).
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS container_id VARCHAR(64) NULL AFTER resume_attempt_count;
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS error_message TEXT NULL AFTER container_id;

-- ---------------------------------------------------------------------------
-- Phase 6: admin-authored per-repo clarification instructions. Deliberately a
-- separate table from repo_documents - that one holds Apex-generated output
-- automated jobs may overwrite; this is admin-authored input nothing but the
-- admin CRUD screen may touch. instructions is capped at 6,000 chars, enforced
-- app-side at save time (see ROADMAP.md Phase 6).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS repo_clarification_instructions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  repo_id INT UNSIGNED NOT NULL,
  instructions TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_repo_clarification_instructions_repo (repo_id),
  CONSTRAINT fk_repo_clarification_instructions_repo FOREIGN KEY (repo_id) REFERENCES repos (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Phase 2: admin
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  admin_user_id INT UNSIGNED NOT NULL,
  action VARCHAR(255) NOT NULL,
  target_user_id INT UNSIGNED NULL,
  detail TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_admin_audit_log_admin (admin_user_id),
  KEY idx_admin_audit_log_target (target_user_id),
  CONSTRAINT fk_admin_audit_log_admin FOREIGN KEY (admin_user_id) REFERENCES users (id),
  CONSTRAINT fk_admin_audit_log_target FOREIGN KEY (target_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Phase 10: observability
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS blocked_allowlist_alerts (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  repo_id INT UNSIGNED NULL,
  session_id INT UNSIGNED NULL,
  http_status INT UNSIGNED NOT NULL,
  detail TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_blocked_allowlist_alerts_repo (repo_id),
  KEY idx_blocked_allowlist_alerts_session (session_id),
  CONSTRAINT fk_blocked_allowlist_alerts_repo FOREIGN KEY (repo_id) REFERENCES repos (id),
  CONSTRAINT fk_blocked_allowlist_alerts_session FOREIGN KEY (session_id) REFERENCES sessions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS lock_contention_events (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  repo_id INT UNSIGNED NOT NULL,
  co_number VARCHAR(9) NOT NULL,
  requesting_user_id INT UNSIGNED NOT NULL,
  holding_session_id INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_lock_contention_events_repo (repo_id),
  CONSTRAINT fk_lock_contention_events_repo FOREIGN KEY (repo_id) REFERENCES repos (id),
  CONSTRAINT fk_lock_contention_events_user FOREIGN KEY (requesting_user_id) REFERENCES users (id),
  CONSTRAINT fk_lock_contention_events_session FOREIGN KEY (holding_session_id) REFERENCES sessions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Phase 8: delivery docs
-- ---------------------------------------------------------------------------

-- co_number = '' is the sentinel for the repo-level (not per-CO) document.
--
-- doc_type is a VARCHAR, deliberately not an ENUM (it was one until Phase 23):
-- document types are a code-level registry (app/lib/documents/docTypes.js), so
-- an ENUM would make every new type a DDL change - exactly the coupling that
-- phase exists to remove. Do not "tidy" this back into an ENUM.
CREATE TABLE IF NOT EXISTS repo_documents (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  repo_id INT UNSIGNED NOT NULL,
  doc_type VARCHAR(50) NOT NULL,
  co_number VARCHAR(9) NOT NULL DEFAULT '',
  content LONGTEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_repo_documents_repo_doctype_co (repo_id, doc_type, co_number),
  CONSTRAINT fk_repo_documents_repo FOREIGN KEY (repo_id) REFERENCES repos (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Phase 23 renamed spec_doc_jobs -> doc_jobs (the rename deferred during the
-- docWorker rename, folded in while the table was gaining a column anyway).
-- Renaming BEFORE the CREATE below is what makes the pair idempotent: on an
-- upgraded database the rename moves the real table with its rows and the
-- CREATE is a no-op, and on a replay (or a fresh install) the rename finds
-- nothing and the CREATE builds the final shape. Reversing the two would leave
-- an empty doc_jobs alongside the populated spec_doc_jobs.
--
-- MariaDB's ALTER TABLE IF EXISTS is what buys the guard; plain RENAME TABLE
-- has no IF EXISTS and would hard-fail the whole migration on every replay.
ALTER TABLE IF EXISTS spec_doc_jobs RENAME TO doc_jobs;

CREATE TABLE IF NOT EXISTS doc_jobs (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  repo_id INT UNSIGNED NOT NULL,
  -- A docTypes.js registry key, not a repo_documents.doc_type value - see the
  -- key/docType note in that module. No FK is possible: the thing it points at
  -- is a module, not a table.
  doc_type VARCHAR(50) NOT NULL,
  -- 'skipped' is terminal and set at drain time for a job whose type was
  -- disabled or de-registered after it was queued (see docService.js). Leaving
  -- such a job 'queued' instead would make it run - against a long-stale trunk
  -- sha - the moment the type was ever re-enabled.
  status ENUM('queued', 'running', 'completed', 'failed', 'skipped') NOT NULL DEFAULT 'queued',
  trunk_commit_sha VARCHAR(40) NULL,
  model VARCHAR(100) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- (repo_id, doc_type) because the in-flight check is per pair now. repo_id
  -- leads, so this also satisfies the FK below without a second index.
  KEY idx_doc_jobs_repo_type (repo_id, doc_type),
  CONSTRAINT fk_doc_jobs_repo FOREIGN KEY (repo_id) REFERENCES repos (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Which trunk sha each document type was last generated against, per repo.
-- Supersedes repos.spec_doc_synced_commit_sha (Phase 23): staleness is per
-- document type, not per repo - a Code Review doc and a Spec doc go stale
-- independently, and one column can only ever track one of them.
CREATE TABLE IF NOT EXISTS repo_doc_sync (
  repo_id INT UNSIGNED NOT NULL,
  doc_type VARCHAR(50) NOT NULL,
  synced_commit_sha VARCHAR(40) NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (repo_id, doc_type),
  CONSTRAINT fk_repo_doc_sync_repo FOREIGN KEY (repo_id) REFERENCES repos (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Phase 14: usage/cost reporting & model-provider circuit breaker
-- ---------------------------------------------------------------------------

-- One row per model call, written by app/lib/model/usageService.js from each
-- call site (overlapService.js, clarificationService.js, codegenService.js,
-- docService.js) right after a successful modelAdapter.generate() call -
-- see ROADMAP.md Phase 14.
CREATE TABLE IF NOT EXISTS usage_events (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- VARCHAR, not an ENUM (it was one until Phase 23): the document call sites
  -- come from the docTypes.js registry, and a new document type has to be able
  -- to bill itself without a migration. 'overlap_check', 'clarification',
  -- 'codegen' and 'spec_doc' are the values in use today.
  call_site VARCHAR(50) NOT NULL,
  session_id INT UNSIGNED NULL,
  repo_id INT UNSIGNED NULL,
  provider VARCHAR(50) NOT NULL,
  model VARCHAR(100) NOT NULL,
  input_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  output_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  cache_read_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  cache_write_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  -- Computed at write time from app/lib/model/pricing.js's lookup, not
  -- derived later, so historical rows stay accurate if pricing changes.
  cost_usd DECIMAL(12, 6) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_usage_events_session (session_id),
  KEY idx_usage_events_repo (repo_id),
  KEY idx_usage_events_created_at (created_at),
  CONSTRAINT fk_usage_events_session FOREIGN KEY (session_id) REFERENCES sessions (id),
  CONSTRAINT fk_usage_events_repo FOREIGN KEY (repo_id) REFERENCES repos (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per provider, upserted by app/lib/model/providerHealth.js -
-- existence of a row isn't the signal (unlike pipeline_locks); status is.
-- 'warning' is reachable in the schema for a future admin action, but
-- nothing automatically transitions a provider into it yet - no NIM quota is
-- knowable in advance to compare against (see ROADMAP.md Phase 14 Open).
CREATE TABLE IF NOT EXISTS model_provider_health (
  provider VARCHAR(50) NOT NULL,
  status ENUM('healthy', 'warning', 'locked') NOT NULL DEFAULT 'healthy',
  reason VARCHAR(500) NULL,
  locked_at TIMESTAMP NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Phase 20: size-aware repo file map
-- ---------------------------------------------------------------------------

-- One row per (repo, commit sha), written by app/lib/repoMap.js. Keyed on the
-- commit rather than the repo so the cache is content-addressed: three callers
-- in one session share one GitHub tree call, and a repo whose trunk hasn't
-- moved isn't re-walked at all. Rebuild needs no invalidation step - a moved
-- sha simply misses.
--
-- Two JSON blobs, and the split between them is the point (see ROADMAP.md
-- Phase 20): selected_json is the ranked, size-annotated subset the prompt
-- shows, while paths_json is every blob path in the commit. Phase 19's
-- write guard reads the latter, so narrowing what the model sees never widens
-- what the guard will approve.
CREATE TABLE IF NOT EXISTS repo_file_maps (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  repo_id INT UNSIGNED NOT NULL,
  commit_sha VARCHAR(40) NOT NULL,
  -- GitHub's own `truncated` flag on the recursive tree response. When set,
  -- paths_json is incomplete and "absent from this list" proves nothing.
  github_truncated BOOLEAN NOT NULL DEFAULT FALSE,
  total_files INT UNSIGNED NOT NULL DEFAULT 0,
  total_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  excluded_files INT UNSIGNED NOT NULL DEFAULT 0,
  omitted_files INT UNSIGNED NOT NULL DEFAULT 0,
  selected_json LONGTEXT NOT NULL,
  paths_json LONGTEXT NOT NULL,
  -- Touched on every cache hit. Retirement is by last use, not by whether the
  -- sha is still a branch head: the map for an in-flight DEV branch is exactly
  -- the one worth keeping (see docScanService.js).
  last_used_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_repo_file_maps_repo_sha (repo_id, commit_sha),
  KEY idx_repo_file_maps_last_used (last_used_at),
  CONSTRAINT fk_repo_file_maps_repo FOREIGN KEY (repo_id) REFERENCES repos (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Phase 21: structural index, carried on the Phase 20 row rather than in a
-- second table
-- ---------------------------------------------------------------------------

-- Written by app/lib/structuralIndex.js from one awk pass over the clone
-- inside a sandbox container: exact per-file line counts (Phase 20 could only
-- estimate them from bytes) and a per-file outline of declaration-looking
-- lines with their line numbers.
--
-- NULLable, and the asymmetry that makes it so is deliberate (see ROADMAP.md
-- Phase 21). The rest of this row is buildable from the GitHub API alone, so
-- it exists as soon as anyone opens the repo page. This column needs a
-- container, so it exists from the first codegen run onward - a repo with no
-- successful run yet has the map and no outline. That is fine because the
-- index is only ever *needed* where a container already exists; clarification
-- reads it when some earlier run happened to leave one for the same commit,
-- and does without when it did not.
--
-- Nothing's correctness depends on this column. Ranged reads and anchored
-- writes are both served and verified against the container's actual bytes;
-- the index is navigation only, and a stale or absent one costs the model a
-- wasted read, never a wrong write.
ALTER TABLE repo_file_maps ADD COLUMN IF NOT EXISTS structural_index_json LONGTEXT NULL AFTER paths_json;
ALTER TABLE repo_file_maps ADD COLUMN IF NOT EXISTS indexed_at TIMESTAMP NULL DEFAULT NULL AFTER structural_index_json;

-- ---------------------------------------------------------------------------
-- Phase 22: admin-managed model catalog & app-wide maintenance lock
-- ---------------------------------------------------------------------------

-- Replaces the MODEL / MODEL_MAX_TOKENS env vars the NIM adapter used to read
-- at require time, which allowed exactly one model per deployment. The catalog
-- is admin-managed through /admin/models and ships EMPTY on purpose: there is
-- no seed row and no env fallback, so a fresh install has no usable model and
-- the app locks itself (see app_settings below and app/lib/appLock.js) until an
-- admin adds one. That makes the "no model" path a normal, exercised state
-- rather than a crash nobody sees until the first generate() call.
--
-- model_id is the provider's own string (e.g. 'google/gemma-4-31b-it') - the
-- value sent in the chat-completions body and recorded in usage_events.model.
-- max_tokens and the two price columns live per row because they are genuinely
-- per-model: context windows differ, and the old global MODEL_MAX_TOKENS was
-- wrong for every model but one. Pricing moved here from the hardcoded (and
-- permanently empty, hence always-$0) PRICING map in app/lib/model/pricing.js.
--
-- Only one row may have is_default = TRUE; that is enforced app-side in
-- modelCatalog.setDefault(), not by a unique index, since FALSE repeats.
CREATE TABLE IF NOT EXISTS models (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  model_id VARCHAR(100) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  description TEXT NULL,
  provider VARCHAR(50) NOT NULL DEFAULT 'nvidia_nim',
  max_tokens INT UNSIGNED NOT NULL DEFAULT 4096,
  price_in_per_1m DECIMAL(10, 4) NOT NULL DEFAULT 0,
  price_out_per_1m DECIMAL(10, 4) NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_models_model_id (model_id),
  KEY idx_models_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Generic app-wide settings, read and written through app/lib/appSettings.js.
-- Key/value rather than a single-row table because this was the first app-wide
-- setting and was not the last. Keys in use:
--
--   maintenance_locked  '1'/'0'  - the admin maintenance lock (app/lib/appLock.js)
--   maintenance_message TEXT     - the message shown to locked-out users
--   doc_types_enabled   comma-separated docTypes.js registry keys - which
--                                document types the nightly worker generates
--                                (app/lib/documents/docSettings.js). A MISSING
--                                row and an EMPTY one mean different things:
--                                missing is "never configured" and enables the
--                                pre-Phase-23 set, empty is an admin choosing
--                                to generate nothing.
--   doc_model_id:<key>  models.id as a string, or '' for "use the catalog
--                                default" - which model generates that one
--                                document type. One row per registry key
--                                (Phase 23; was a single spec_doc_model_id in
--                                Phase 22). Document generation is the one
--                                model call with no requesting user to inherit
--                                a preference from.
--
-- Note that setting_value cannot carry a foreign key, so a doc_model_id:<key>
-- can dangle when the model it names is deleted; modelCatalog.resolveForDocType
-- re-validates it on every read and falls back rather than failing. The same
-- goes for doc_types_enabled naming a key no longer in the registry, which
-- docSettings.js ignores on read.
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key VARCHAR(100) NOT NULL,
  setting_value TEXT NULL,
  updated_by_user_id INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key),
  CONSTRAINT fk_app_settings_user FOREIGN KEY (updated_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A user's sticky model choice, set from the model selector on the repo list
-- (views/dashboard.ejs). ON DELETE SET NULL rather than RESTRICT: deleting a
-- model should not be blocked by someone merely having it selected, and
-- modelCatalog.resolveForUser() already falls back to the default when a
-- preference is missing or points at a disabled model.
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_model_id INT UNSIGNED NULL AFTER is_admin;
-- MariaDB puts IF NOT EXISTS after FOREIGN KEY, not after CONSTRAINT (unlike
-- the ADD COLUMN form above) - the latter is a syntax error, not a no-op.
ALTER TABLE users ADD CONSTRAINT fk_users_preferred_model
  FOREIGN KEY IF NOT EXISTS (preferred_model_id) REFERENCES models (id) ON DELETE SET NULL;

-- The model each unit of work was created with, stamped at creation time and
-- never re-resolved afterwards. This has to be a plain VARCHAR of the provider
-- string, NOT a FK to models.id, for the same reason usage_events.model is one:
-- a run's record of what actually generated it must survive the catalog row
-- being disabled, renamed, or deleted.
--
-- Stamping rather than looking up "the user's current choice" at generate()
-- time is load-bearing - worker.js picks a session up in a different process
-- minutes later, and a user changing the dropdown mid-run would otherwise
-- switch models between pipeline turns.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS model VARCHAR(100) NULL AFTER resume_requested;
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS model VARCHAR(100) NULL AFTER container_id;
ALTER TABLE doc_jobs ADD COLUMN IF NOT EXISTS model VARCHAR(100) NULL AFTER trunk_commit_sha;

-- The circuit breaker was keyed on provider alone, which was fine when one
-- deployment meant one model: with several models behind the same NIM endpoint,
-- one bad model id tripping the breaker would lock out every other model on
-- that provider. DROP + ADD PRIMARY KEY is idempotent here (there is always a
-- PK to drop, and re-adding the same one is a no-op in effect); the existing
-- single row per provider cannot collide on the '' default.
--
-- Pre-existing rows are backfilled with model = '', which app code reads as
-- "locked for every model on this provider" (providerHealth.PROVIDER_WIDE) -
-- NOT as a dead row. That matters: a provider genuinely locked on quota at
-- upgrade time has to keep blocking afterwards. Keying the lookup on the
-- narrower (provider, model) alone would have left that row matching nothing,
-- silently releasing a live lock on the one upgrade where it mattered.
ALTER TABLE model_provider_health ADD COLUMN IF NOT EXISTS model VARCHAR(100) NOT NULL DEFAULT '' AFTER provider;
ALTER TABLE model_provider_health DROP PRIMARY KEY, ADD PRIMARY KEY (provider, model);

-- ---------------------------------------------------------------------------
-- Phase 23: pluggable document types
--
-- Everything here is an upgrade path for a database created before Phase 23;
-- on a fresh install every statement is a no-op, because the CREATE TABLE
-- definitions above already describe the end state.
-- ---------------------------------------------------------------------------

-- ENUM -> VARCHAR on both columns that name a document type or its call site.
-- A new document type is a new file in app/lib/documents/docTypes.js; it must
-- not also be a schema change. MODIFY COLUMN is naturally idempotent (it
-- restates the target type), and widening an ENUM to a VARCHAR preserves every
-- existing row's label verbatim.
ALTER TABLE repo_documents MODIFY COLUMN doc_type VARCHAR(50) NOT NULL;
ALTER TABLE usage_events MODIFY COLUMN call_site VARCHAR(50) NOT NULL;

-- doc_jobs gained doc_type and a 'skipped' status. The DEFAULT is only there to
-- backfill pre-Phase-23 rows (all of which were spec docs - it was the only
-- type) and is dropped immediately after, so an upgraded database ends up with
-- the same column definition as a fresh one. Leaving the default in place would
-- be worse than cosmetic drift: an INSERT that forgot doc_type would silently
-- enqueue a spec-doc job instead of failing.
ALTER TABLE doc_jobs
  ADD COLUMN IF NOT EXISTS doc_type VARCHAR(50) NOT NULL DEFAULT 'spec_communication_protocol' AFTER repo_id;
ALTER TABLE doc_jobs ALTER COLUMN doc_type DROP DEFAULT;
ALTER TABLE doc_jobs
  MODIFY COLUMN status ENUM('queued', 'running', 'completed', 'failed', 'skipped') NOT NULL DEFAULT 'queued';

-- The index and FK survived the table rename under their old names. Order
-- matters: InnoDB refuses to drop an index a foreign key still needs, so the
-- FK goes first and comes back last.
ALTER TABLE doc_jobs DROP FOREIGN KEY IF EXISTS fk_spec_doc_jobs_repo;
ALTER TABLE doc_jobs DROP INDEX IF EXISTS idx_spec_doc_jobs_repo;
ALTER TABLE doc_jobs ADD INDEX IF NOT EXISTS idx_doc_jobs_repo_type (repo_id, doc_type);
ALTER TABLE doc_jobs ADD CONSTRAINT fk_doc_jobs_repo FOREIGN KEY IF NOT EXISTS (repo_id) REFERENCES repos (id);

-- Backfill repo_doc_sync from the column it supersedes. ON DUPLICATE KEY keeps
-- the EXISTING row rather than overwriting it: once the new table is being
-- written, repos.spec_doc_synced_commit_sha is frozen at whatever it held on
-- upgrade day, and a later replay of this file must not resurrect that stale
-- sha over a current one (which would make the scan regenerate every spec doc).
INSERT INTO repo_doc_sync (repo_id, doc_type, synced_commit_sha)
  SELECT id, 'spec_communication_protocol', spec_doc_synced_commit_sha
  FROM repos WHERE spec_doc_synced_commit_sha IS NOT NULL
  ON DUPLICATE KEY UPDATE synced_commit_sha = repo_doc_sync.synced_commit_sha;

-- The Phase 22 single-model setting becomes the spec type's per-type setting.
-- Selected through a derived table because MariaDB will not let an
-- INSERT ... SELECT read the table it is inserting into directly. Same
-- keep-the-existing-row rule as above, so a replay cannot clobber a model an
-- admin has since changed; then the old key is removed so nothing reads it
-- again.
INSERT INTO app_settings (setting_key, setting_value, updated_by_user_id)
  SELECT * FROM (
    SELECT 'doc_model_id:spec_communication_protocol' AS k, setting_value AS v, updated_by_user_id AS u
    FROM app_settings WHERE setting_key = 'spec_doc_model_id'
  ) AS legacy
  ON DUPLICATE KEY UPDATE setting_value = app_settings.setting_value;
DELETE FROM app_settings WHERE setting_key = 'spec_doc_model_id';

-- ---------------------------------------------------------------------------
-- express-session store. Deliberately NOT named `sessions` - that name is
-- already taken by the AI-pipeline sessions table above.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS express_sessions (
  session_id VARCHAR(128) NOT NULL,
  expires INT UNSIGNED NOT NULL,
  data MEDIUMTEXT NULL,
  PRIMARY KEY (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
