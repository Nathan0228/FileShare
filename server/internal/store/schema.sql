CREATE TABLE IF NOT EXISTS schema_migrations (
    version INT UNSIGNED NOT NULL PRIMARY KEY,
    applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS users (
    id BINARY(16) NOT NULL PRIMARY KEY,
    username VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
    role ENUM('admin', 'user') NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    permissions TINYINT UNSIGNED NOT NULL DEFAULT 0 CHECK (permissions <= 7),
    quota_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
    used_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
    reserved_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS credentials (
    credential_id VARBINARY(1023) NOT NULL PRIMARY KEY,
    user_id BINARY(16) NOT NULL,
    public_key_cose BLOB NOT NULL,
    sign_count INT UNSIGNED NOT NULL DEFAULT 0,
    credential_json LONGTEXT NOT NULL CHECK (JSON_VALID(credential_json)),
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    revoked_at DATETIME(6) NULL,
    INDEX credentials_user_revoked (user_id, revoked_at),
    FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS invites (
    token_hash BINARY(32) NOT NULL PRIMARY KEY,
    user_id BINARY(16) NOT NULL,
    expires_at DATETIME(6) NOT NULL,
    consumed_at DATETIME(6) NULL,
    revoked_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    INDEX invites_user_active (user_id, consumed_at, revoked_at),
    INDEX invites_expires (expires_at),
    FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sessions (
    token_hash BINARY(32) NOT NULL PRIMARY KEY,
    user_id BINARY(16) NOT NULL,
    credential_id VARBINARY(1023) NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    idle_until DATETIME(6) NOT NULL,
    expires_at DATETIME(6) NOT NULL,
    revoked_at DATETIME(6) NULL,
    INDEX sessions_user_revoked (user_id, revoked_at),
    INDEX sessions_credential_revoked (credential_id, revoked_at),
    INDEX sessions_expires (expires_at),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (credential_id) REFERENCES credentials(credential_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS files (
    id BINARY(16) NOT NULL PRIMARY KEY,
    owner_id BINARY(16) NOT NULL,
    object_key BINARY(16) NOT NULL UNIQUE,
    name VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    size BIGINT UNSIGNED NOT NULL CHECK (size <= 536870912),
    sha256 BINARY(32) NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    deleted_at DATETIME(6) NULL,
    purged_at DATETIME(6) NULL,
    INDEX files_owner_active (owner_id, deleted_at, id),
    INDEX files_cleanup (purged_at, deleted_at),
    FOREIGN KEY (owner_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS file_acl (
    file_id BINARY(16) NOT NULL,
    grantee_id BINARY(16) NOT NULL,
    granted_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (file_id, grantee_id),
    INDEX file_acl_grantee (grantee_id, file_id),
    FOREIGN KEY (file_id) REFERENCES files(id),
    FOREIGN KEY (grantee_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS upload_jobs (
    id BINARY(16) NOT NULL PRIMARY KEY,
    owner_id BINARY(16) NOT NULL,
    op_id BINARY(16) NOT NULL,
    name VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    size BIGINT UNSIGNED NOT NULL CHECK (size <= 536870912),
    sha256 BINARY(32) NOT NULL,
    state ENUM('OPEN', 'VERIFYING', 'READY', 'CANCELLED', 'EXPIRED', 'FAILED') NOT NULL,
    expires_at DATETIME(6) NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    cleaned_at DATETIME(6) NULL,
    file_id BINARY(16) NULL,
    UNIQUE (owner_id, op_id),
    INDEX upload_jobs_expiry (state, expires_at),
    INDEX upload_jobs_cleanup (cleaned_at, state),
    FOREIGN KEY (owner_id) REFERENCES users(id),
    FOREIGN KEY (file_id) REFERENCES files(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS upload_chunks (
    upload_id BINARY(16) NOT NULL,
    idx INT UNSIGNED NOT NULL CHECK (idx < 2048),
    chunk_bytes INT UNSIGNED NOT NULL CHECK (chunk_bytes BETWEEN 1 AND 262144),
    sha256 BINARY(32) NOT NULL,
    PRIMARY KEY (upload_id, idx),
    FOREIGN KEY (upload_id) REFERENCES upload_jobs(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS download_receipts (
    user_id BINARY(16) NOT NULL,
    file_id BINARY(16) NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (user_id, file_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (file_id) REFERENCES files(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    actor_id BINARY(16) NULL,
    action VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    target_id BINARY(16) NULL,
    result VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    request_meta JSON NULL,
    INDEX audit_actor_date (actor_id, created_at),
    INDEX audit_action_date (action, created_at),
    INDEX audit_retention (created_at),
    FOREIGN KEY (actor_id) REFERENCES users(id)
) ENGINE=InnoDB;
