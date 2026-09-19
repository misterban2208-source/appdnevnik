CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL DEFAULT '',
  username TEXT,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  start_min INTEGER,
  end_min INTEGER,
  category_id TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'todo',
  checklist TEXT NOT NULL DEFAULT '[]',
  reminders TEXT NOT NULL DEFAULT '[]',
  repeat TEXT,
  carried_from TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_user_updated ON tasks(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_tasks_user_date ON tasks(user_id, date);

CREATE TABLE IF NOT EXISTS occurrences (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  status TEXT,
  start_min INTEGER,
  end_min INTEGER,
  checklist TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_occ_user_updated ON occurrences(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_occ_user_date ON occurrences(user_id, date);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cat_user_updated ON categories(user_id, updated_at);

CREATE TABLE IF NOT EXISTS day_notes (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  morning TEXT NOT NULL DEFAULT '',
  evening TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_user_updated ON day_notes(user_id, updated_at);

CREATE TABLE IF NOT EXISTS sent_notifications (
  key TEXT PRIMARY KEY,
  sent_at INTEGER NOT NULL
);
