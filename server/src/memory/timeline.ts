
import db from "../database/database";
import {
  resolveTemporalRange,
  localDateToUtc
} from "./dateResolver";

function addOneDay(date: string): string {
  const result = new Date(`${date}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + 1);
  return result.toISOString().slice(0, 10);
}

export function getConversationTimeline(when: string) {
  const range = resolveTemporalRange(when);

  if (!range) {
    return null;
  }

  const startUtc = localDateToUtc(range.startDate);
  const endUtc = localDateToUtc(addOneDay(range.endDate));

  const messages = db.prepare(`
    SELECT
      m.id AS message_id,
      m.conversation_id,
      m.role,
      m.content,
      m.created_at,
      c.title AS conversation_title

    FROM messages m

    JOIN conversations c
      ON c.id = m.conversation_id

    WHERE m.created_at >= ?
      AND m.created_at < ?

    ORDER BY m.created_at ASC

    LIMIT 100
  `).all(startUtc, endUtc);

  return {
    range,
    count: messages.length,
    messages
  };
}
