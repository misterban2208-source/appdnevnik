-- Voice note metadata. Bytes live in R2 (r2_key); the row is the fifth synced entity.
CREATE TABLE IF NOT EXISTS voice_notes (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  section TEXT NOT NULL,
  mime TEXT NOT NULL,
  duration INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  peaks TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'app',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  synced_at INTEGER NOT NULL DEFAULT 0,   -- server receive stamp, the pull cursor (same as other tables)
  deleted_at INTEGER,
  r2_key TEXT,                            -- server-owned
  uploaded_at INTEGER,                    -- server-owned
  tg_file_id TEXT,                        -- server-owned
  tg_file_unique_id TEXT                  -- server-owned
);
CREATE INDEX IF NOT EXISTS idx_voice_user_synced ON voice_notes(user_id, synced_at);
CREATE INDEX IF NOT EXISTS idx_voice_user_date ON voice_notes(user_id, date);
CREATE INDEX IF NOT EXISTS idx_voice_purge ON voice_notes(deleted_at) WHERE deleted_at IS NOT NULL AND r2_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_tg_unique ON voice_notes(user_id, tg_file_unique_id) WHERE tg_file_unique_id IS NOT NULL;
