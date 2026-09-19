-- Server-assigned receive timestamp: the pull cursor must not depend on client clocks.
ALTER TABLE tasks ADD COLUMN synced_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE occurrences ADD COLUMN synced_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE categories ADD COLUMN synced_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE day_notes ADD COLUMN synced_at INTEGER NOT NULL DEFAULT 0;

UPDATE tasks SET synced_at = updated_at;
UPDATE occurrences SET synced_at = updated_at;
UPDATE categories SET synced_at = updated_at;
UPDATE day_notes SET synced_at = updated_at;

CREATE INDEX IF NOT EXISTS idx_tasks_user_synced ON tasks(user_id, synced_at);
CREATE INDEX IF NOT EXISTS idx_occ_user_synced ON occurrences(user_id, synced_at);
CREATE INDEX IF NOT EXISTS idx_cat_user_synced ON categories(user_id, synced_at);
CREATE INDEX IF NOT EXISTS idx_notes_user_synced ON day_notes(user_id, synced_at);
CREATE INDEX IF NOT EXISTS idx_tasks_user_repeat ON tasks(user_id) WHERE repeat IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sent_at ON sent_notifications(sent_at);
