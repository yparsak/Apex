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
  status ENUM('active', 'deleted') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_branches_repo_initials_co_increment (repo_id, initials, co_number, increment),
  CONSTRAINT fk_branches_repo FOREIGN KEY (repo_id) REFERENCES repos (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Phase 5 / Phase 7 / Phase 8: sessions, requirements, pipeline execution
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sessions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  branch_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  status ENUM('awaiting_approval', 'queued', 'running', 'completed', 'failed') NOT NULL DEFAULT 'awaiting_approval',
  approved_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sessions_branch (branch_id),
  KEY idx_sessions_user (user_id),
  CONSTRAINT fk_sessions_branch FOREIGN KEY (branch_id) REFERENCES branches (id),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
CREATE TABLE IF NOT EXISTS repo_documents (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  repo_id INT UNSIGNED NOT NULL,
  doc_type ENUM('requirements_log', 'spec_communication_protocol') NOT NULL,
  co_number VARCHAR(9) NOT NULL DEFAULT '',
  content LONGTEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_repo_documents_repo_doctype_co (repo_id, doc_type, co_number),
  CONSTRAINT fk_repo_documents_repo FOREIGN KEY (repo_id) REFERENCES repos (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS spec_doc_jobs (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  repo_id INT UNSIGNED NOT NULL,
  status ENUM('queued', 'running', 'completed', 'failed') NOT NULL DEFAULT 'queued',
  trunk_commit_sha VARCHAR(40) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_spec_doc_jobs_repo (repo_id),
  CONSTRAINT fk_spec_doc_jobs_repo FOREIGN KEY (repo_id) REFERENCES repos (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
