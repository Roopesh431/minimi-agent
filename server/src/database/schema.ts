
import Database from "better-sqlite3";

export function initializeSchema(db: Database.Database) {

  // Create core tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New conversation',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (
        role IN ('user', 'assistant', 'system', 'tool')
      ),
      content TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (conversation_id)
        REFERENCES conversations(id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages(conversation_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_conversations_updated
    ON conversations(updated_at DESC);
  `);

  // Check whether FTS index already exists
  const ftsExists = db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table'
    AND name = 'messages_fts'
  `).get();

  // Create full-text search index
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
    USING fts5(
      content,
      content='messages',
      content_rowid='rowid',
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS messages_fts_insert
    AFTER INSERT ON messages
    BEGIN
      INSERT INTO messages_fts(rowid, content)
      VALUES (new.rowid, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_delete
    AFTER DELETE ON messages
    BEGIN
      INSERT INTO messages_fts(
        messages_fts, rowid, content
      )
      VALUES ('delete', old.rowid, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_update
    AFTER UPDATE OF content ON messages
    BEGIN
      INSERT INTO messages_fts(
        messages_fts, rowid, content
      )
      VALUES ('delete', old.rowid, old.content);

      INSERT INTO messages_fts(rowid, content)
      VALUES (new.rowid, new.content);
    END;
  `);

  // Rebuild index for existing messages only on first creation
  if (!ftsExists) {
    db.exec(`
      INSERT INTO messages_fts(messages_fts)
      VALUES ('rebuild');
    `);
  }

  console.log("Database schema initialized successfully");
}
