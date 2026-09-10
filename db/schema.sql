-- Phase 0 schema — see roadmap.md "Data model (Phase 0)" for the rationale behind each table.

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  initials VARCHAR(10) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS orgs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS repo_groups (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  org_id INT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (org_id) REFERENCES orgs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS repos (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  repo_group_id INT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  default_branch_name VARCHAR(255) NOT NULL DEFAULT 'main',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (repo_group_id) REFERENCES repo_groups(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_repo_group_permissions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  repo_group_id INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (repo_group_id) REFERENCES repo_groups(id),
  UNIQUE (user_id, repo_group_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS change_orders (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  repo_id INT UNSIGNED NOT NULL,
  co_number VARCHAR(20) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'open',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (repo_id) REFERENCES repos(id),
  UNIQUE (repo_id, co_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS branches (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  repo_id INT UNSIGNED NOT NULL,
  created_by_user_id INT UNSIGNED NOT NULL,
  initials VARCHAR(10) NOT NULL,
  co_number VARCHAR(20) NOT NULL,
  increment INT UNSIGNED NOT NULL,
  branch_name VARCHAR(255) NOT NULL,
  status ENUM('active', 'deleted') NOT NULL DEFAULT 'active',
  last_checked_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (repo_id) REFERENCES repos(id),
  FOREIGN KEY (created_by_user_id) REFERENCES users(id),
  UNIQUE (repo_id, initials, co_number, increment)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  branch_id INT UNSIGNED NOT NULL,
  status ENUM('queued', 'running', 'completed', 'failed') NOT NULL DEFAULT 'queued',
  completed_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (branch_id) REFERENCES branches(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS session_requirements (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  session_id INT UNSIGNED NOT NULL,
  content TEXT NOT NULL,
  submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  overlap_flag_requirement_id INT UNSIGNED NULL,
  resolution_status ENUM('pending_confirm', 'confirmed_proceed', 'confirmed_skip') NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (overlap_flag_requirement_id) REFERENCES session_requirements(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS conversations (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  session_id INT UNSIGNED NOT NULL,
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_log (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  repo_id INT UNSIGNED NULL,
  co_number VARCHAR(20) NULL,
  raw_instructions TEXT NULL,
  qa_history TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (repo_id) REFERENCES repos(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Phase 2: serializes the full pipeline (clone -> sandbox build/test -> push)
-- one session at a time per (repo_id, co_number) - see roadmap.md's "Lock
-- scope: entire pipeline" decision. A row's existence IS the lock: acquiring
-- is an INSERT that relies on the UNIQUE constraint below to fail when
-- another session already holds it; releasing is a DELETE. Phase 2 only
-- wires acquire-at-CO-resolution and release-on-failure, since the sandbox/
-- execution phases (3-5) don't exist yet - releasing on a *successful*
-- full-pipeline completion is Phase 5's job, not this table's.
CREATE TABLE IF NOT EXISTS pipeline_locks (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  repo_id INT UNSIGNED NOT NULL,
  co_number VARCHAR(20) NOT NULL,
  locked_by_user_id INT UNSIGNED NOT NULL,
  locked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (repo_id) REFERENCES repos(id),
  FOREIGN KEY (locked_by_user_id) REFERENCES users(id),
  UNIQUE (repo_id, co_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Phase 4: one row per worker pickup attempt of a queued session (see
-- worker.js and app/lib/pipeline/pipelineService.js). Deliberately a new,
-- separate table rather than new columns bolted onto `sessions` - matches
-- how normalized the rest of this schema already is (session_requirements,
-- conversations, and audit_log are all separate from sessions too), and
-- means this table needs no ALTER-based migration story: it's additive via
-- plain CREATE TABLE IF NOT EXISTS, safe to apply against an
-- already-provisioned dev database exactly like every other table here.
-- `log` holds the sandboxed build/test run's captured stdout/stderr (capped
-- and truncated before being written - see sandboxRunner.js); `commit_sha`
-- is set only on a successful push; `error_message` is set only on failure
-- (branch deleted, config invalid, codegen unparseable, build/test failed,
-- push failed after exhausting fetch-and-retry).
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  session_id INT UNSIGNED NOT NULL,
  status ENUM('running', 'completed', 'failed') NOT NULL DEFAULT 'running',
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP NULL,
  log LONGTEXT NULL,
  commit_sha VARCHAR(64) NULL,
  error_message TEXT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
