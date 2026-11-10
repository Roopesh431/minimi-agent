
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import db from "../database/database";

const router = Router();

// Validation schemas
const createConversationSchema = z.object({
  title: z.string().trim().min(1).max(120).optional()
});

const createMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string().trim().min(1).max(50000)
});

// GET all conversations
router.get("/", (_req, res) => {
  const conversations = db.prepare(`
    SELECT
      c.*,
      COUNT(m.id) AS message_count
    FROM conversations c
    LEFT JOIN messages m ON m.conversation_id = c.id
    GROUP BY c.id
    ORDER BY c.updated_at DESC
  `).all();

  res.json({
    success: true,
    data: conversations
  });
});

// CREATE conversation
router.post("/", (req, res) => {
  const validation = createConversationSchema.safeParse(req.body);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      error: validation.error.flatten()
    });
  }

  const id = randomUUID();
  const title = validation.data.title || "New conversation";

  db.prepare(`
    INSERT INTO conversations (id, title)
    VALUES (?, ?)
  `).run(id, title);

  const conversation = db.prepare(`
    SELECT * FROM conversations WHERE id = ?
  `).get(id);

  return res.status(201).json({
    success: true,
    data: conversation
  });
});

// GET one conversation with messages
router.get("/:id", (req, res) => {
  const conversation = db.prepare(`
    SELECT * FROM conversations WHERE id = ?
  `).get(req.params.id);

  if (!conversation) {
    return res.status(404).json({
      success: false,
      error: "Conversation not found"
    });
  }

  const messages = db.prepare(`
    SELECT * FROM messages
    WHERE conversation_id = ?
    ORDER BY rowid ASC
  `).all(req.params.id);

  return res.json({
    success: true,
    data: {
      conversation,
      messages
    }
  });
});

// ADD message to conversation
router.post("/:id/messages", (req, res) => {
  const validation = createMessageSchema.safeParse(req.body);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      error: validation.error.flatten()
    });
  }

  const conversationId = req.params.id;

  const conversation = db.prepare(`
    SELECT id FROM conversations WHERE id = ?
  `).get(conversationId);

  if (!conversation) {
    return res.status(404).json({
      success: false,
      error: "Conversation not found"
    });
  }

  const messageId = randomUUID();
  const { role, content } = validation.data;

  db.transaction(() => {
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content)
      VALUES (?, ?, ?, ?)
    `).run(messageId, conversationId, role, content);

    db.prepare(`
      UPDATE conversations
      SET updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(conversationId);
  })();

  const message = db.prepare(`
    SELECT * FROM messages WHERE id = ?
  `).get(messageId);

  return res.status(201).json({
    success: true,
    data: message
  });
});

export default router;
