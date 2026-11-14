-- 朋友圈：手机上传每个角色发朋友圈要的东西（角色卡、节律、记忆、最近的聊天）；
-- Cron 每天在随机的时间替她发（按角色和日期算出来的时间，一天一条一个格子），结果留给手机拉取
CREATE TABLE social_contexts (
  character_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE social_posts (
  character_id TEXT NOT NULL,
  date TEXT NOT NULL,
  slot INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  data TEXT,
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  done_at INTEGER,
  PRIMARY KEY (character_id, date, slot)
);
CREATE INDEX social_posts_done ON social_posts(done_at);
