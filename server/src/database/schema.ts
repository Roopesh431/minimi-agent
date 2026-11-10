
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


  // Structured memory facts with source provenance
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_facts (
      id TEXT PRIMARY KEY,

      conversation_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,

      fact_type TEXT NOT NULL,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL DEFAULT '',

      confidence REAL NOT NULL DEFAULT 1.0
        CHECK (confidence >= 0 AND confidence <= 1),

      extraction_method TEXT NOT NULL DEFAULT 'rule-based',

      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (conversation_id)
        REFERENCES conversations(id)
        ON DELETE CASCADE,

      FOREIGN KEY (source_message_id)
        REFERENCES messages(id)
        ON DELETE CASCADE,

      UNIQUE (
        source_message_id,
        fact_type,
        subject,
        predicate,
        object
      )
    );

    CREATE INDEX IF NOT EXISTS idx_memory_facts_subject
    ON memory_facts(subject);

    CREATE INDEX IF NOT EXISTS idx_memory_facts_type
    ON memory_facts(fact_type);

    CREATE INDEX IF NOT EXISTS idx_memory_facts_conversation
    ON memory_facts(conversation_id);

    CREATE INDEX IF NOT EXISTS idx_memory_facts_source
    ON memory_facts(source_message_id);
  `);


  // Backward-compatible memory fact migration
  const factColumns = db.prepare(`
    PRAGMA table_info(memory_facts)
  `).all() as { name: string }[];

  const existingColumns = new Set(
    factColumns.map(column => column.name)
  );

  if (!existingColumns.has("status")) {
    db.exec(`
      ALTER TABLE memory_facts
      ADD COLUMN status TEXT NOT NULL DEFAULT 'current'
      CHECK (status IN ('current', 'superseded'));
    `);
  }

  if (!existingColumns.has("superseded_by_fact_id")) {
    db.exec(`
      ALTER TABLE memory_facts
      ADD COLUMN superseded_by_fact_id TEXT;
    `);
  }

  if (!existingColumns.has("superseded_at")) {
    db.exec(`
      ALTER TABLE memory_facts
      ADD COLUMN superseded_at TEXT;
    `);
  }

  if (!existingColumns.has("supersession_reason")) {
    db.exec(`
      ALTER TABLE memory_facts
      ADD COLUMN supersession_reason TEXT;
    `);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_facts_status
    ON memory_facts(status);
  `);

}
