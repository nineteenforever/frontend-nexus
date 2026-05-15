PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS graph_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  exported INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL DEFAULT '',
  meta_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  reason TEXT NOT NULL DEFAULT '',
  source_file_path TEXT NOT NULL DEFAULT '',
  target_file_path TEXT NOT NULL DEFAULT '',
  line INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(source) REFERENCES nodes(id) ON DELETE CASCADE,
  FOREIGN KEY(target) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  embedding_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(
  id UNINDEXED,
  name,
  type,
  file_path,
  content
);

CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);
