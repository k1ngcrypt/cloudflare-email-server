-- Users table: one row per mailbox account
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  -- Denormalized primary address mirrored from user_addresses.
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- RBAC role assignment per user.
CREATE TABLE IF NOT EXISTS user_roles (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Backfill role rows for pre-existing users.
INSERT OR IGNORE INTO user_roles (user_id, role)
SELECT id, 'user'
FROM users;

-- Ensure there is always at least one admin after migration bootstrap.
UPDATE user_roles
SET role = 'admin', updated_at = datetime('now')
WHERE user_id = (
  SELECT id
  FROM users
  ORDER BY id ASC
  LIMIT 1
)
AND (SELECT COUNT(*) FROM user_roles WHERE role = 'admin') = 0;

-- User address aliases: one user can own multiple inbound/outbound email addresses.
CREATE TABLE IF NOT EXISTS user_addresses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address       TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL CHECK(length(trim(display_name)) > 0),
  oci_sender_id TEXT NOT NULL CHECK(length(trim(oci_sender_id)) > 0),
  is_primary    INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0, 1)),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Address rows must include OCI sender OCIDs from control-plane create responses.
DROP TRIGGER IF EXISTS trg_users_insert_primary_address;
DROP TRIGGER IF EXISTS trg_users_update_primary_address;

-- Emails table: one row per received message
CREATE TABLE IF NOT EXISTS emails (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  message_id    TEXT,
  from_address  TEXT NOT NULL,
  from_name     TEXT,
  to_address    TEXT NOT NULL,
  subject       TEXT,
  body_text     TEXT,
  body_html     TEXT,
  raw_size      INTEGER,
  received_at   TEXT NOT NULL DEFAULT (datetime('now')),
  read          INTEGER NOT NULL DEFAULT 0,
  starred       INTEGER NOT NULL DEFAULT 0,
  folder        TEXT NOT NULL DEFAULT 'inbox'
);

-- Sent emails table
CREATE TABLE IF NOT EXISTS sent_emails (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  to_address    TEXT NOT NULL,
  subject       TEXT,
  body_text     TEXT,
  body_html     TEXT,
  sent_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Attachment metadata: file bytes are stored in R2 using storage_key
CREATE TABLE IF NOT EXISTS attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  email_id      INTEGER REFERENCES emails(id) ON DELETE CASCADE,
  sent_email_id INTEGER REFERENCES sent_emails(id) ON DELETE CASCADE,
  storage_key   TEXT NOT NULL UNIQUE,
  filename      TEXT NOT NULL,
  mime_type     TEXT,
  size_bytes    INTEGER NOT NULL,
  content_id    TEXT,
  disposition   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Session tokens
CREATE TABLE IF NOT EXISTS sessions (
  token         TEXT PRIMARY KEY, -- stores HMAC-SHA256(session_token, AUTH_SECRET)
  user_id       INTEGER NOT NULL REFERENCES users(id),
  expires_at    TEXT NOT NULL
);

-- Legacy DB-backed login throttling table/index are no longer used.
DROP INDEX IF EXISTS idx_login_attempts_blocked;
DROP TABLE IF EXISTS login_attempts;

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_emails_user_folder ON emails(user_id, folder);
CREATE INDEX IF NOT EXISTS idx_emails_received ON emails(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sent_user_time ON sent_emails(user_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_addresses_user ON user_addresses(user_id);
CREATE INDEX IF NOT EXISTS idx_user_addresses_address ON user_addresses(address);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_addresses_sender_ocid ON user_addresses(oci_sender_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role);
DROP INDEX IF EXISTS idx_user_addresses_single_primary;
CREATE INDEX IF NOT EXISTS idx_attachments_email ON attachments(email_id);
CREATE INDEX IF NOT EXISTS idx_attachments_sent ON attachments(sent_email_id);
CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_id);
