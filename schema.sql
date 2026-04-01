-- Users table: one row per mailbox account
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

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

-- Session tokens
CREATE TABLE IF NOT EXISTS sessions (
  token         TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  expires_at    TEXT NOT NULL
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_emails_user_folder ON emails(user_id, folder);
CREATE INDEX IF NOT EXISTS idx_emails_received ON emails(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sent_user_time ON sent_emails(user_id, sent_at DESC);
