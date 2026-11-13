-- 记忆整理：手机上传要整理的东西（按角色），每天凌晨 4 点（用户时区）云端整理一次，结果留给手机拉取应用
CREATE TABLE memory_contexts (
  character_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE memory_jobs (
  character_id TEXT NOT NULL,
  date TEXT NOT NULL,
  context_revision INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  done_at INTEGER,
  PRIMARY KEY (character_id, date)
);
CREATE INDEX memory_jobs_done ON memory_jobs(done_at);
