
import db from "../database/database";

export interface MemorySearchOptions {
  query: string;
  from?: string;
  to?: string;
  role?: "user" | "assistant";
  limit?: number;
}

export function searchMessages(options: MemorySearchOptions) {
  const { query, from, to, role } = options;
  const limit = options.limit ?? 10;

  // Convert input into safe, quoted FTS5 search terms.
  const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];

  if (tokens.length === 0) {
    return [];
  }

  const searchQuery = tokens
    .map(token => `"${token.replace(/"/g, '""')}"`)
    .join(" ");

  const conditions = ["messages_fts MATCH ?"];
  const params: (string | number)[] = [searchQuery];

  if (from) {
    conditions.push("m.created_at >= ?");
    params.push(`${from} 00:00:00`);
  }

  if (to) {
    conditions.push("m.created_at < datetime(?, '+1 day')");
    params.push(`${to} 00:00:00`);
  }

  if (role) {
    conditions.push("m.role = ?");
    params.push(role);
  }

  params.push(limit);

  return db.prepare(`
    SELECT
      m.id AS message_id,
      m.conversation_id,
      m.role,
      m.content,
      m.created_at,
      c.title AS conversation_title,
      snippet(messages_fts, 0, '[', ']', '...', 20) AS snippet,
      bm25(messages_fts) AS relevance_score

    FROM messages_fts

    JOIN messages m
      ON m.rowid = messages_fts.rowid

    JOIN conversations c
      ON c.id = m.conversation_id

    WHERE ${conditions.join(" AND ")}

    ORDER BY bm25(messages_fts) ASC

    LIMIT ?
  `).all(...params);
}
