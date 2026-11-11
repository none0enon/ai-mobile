CREATE TABLE contexts (
  character_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE secrets (id TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, iv TEXT NOT NULL);
CREATE TABLE devices (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE login_attempts (bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE touchpoints (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  push_error TEXT
);
CREATE INDEX touchpoints_due ON touchpoints(status, due_at, retry_at);
CREATE TABLE messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  character_id TEXT NOT NULL,
  touchpoint_id TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL,
  data TEXT NOT NULL,
  notification TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  push_lease TEXT,
  push_until INTEGER NOT NULL DEFAULT 0,
  push_retry_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX messages_character ON messages(character_id, created_at);
CREATE TABLE push_channels (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  last_ok_at INTEGER
);
CREATE TABLE usage (date TEXT PRIMARY KEY, tokens INTEGER NOT NULL DEFAULT 0, reserved INTEGER NOT NULL DEFAULT 0);
CREATE TABLE reservations (id TEXT PRIMARY KEY, date TEXT NOT NULL, tokens INTEGER NOT NULL, expires_at INTEGER NOT NULL);
