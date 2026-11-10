
import { Router } from "express";
import { z } from "zod";
import { searchMessages } from "../memory/retrieval";
import { getConversationTimeline } from "../memory/timeline";
import { extractConversationFacts } from "../memory/extraction";
import db from "../database/database";

const router = Router();

const searchSchema = z.object({
  q: z.string().trim().min(1).max(500),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  role: z.enum(["user", "assistant"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10)
}).refine(
  data => !data.from || !data.to || data.from <= data.to,
  { message: "Start date must not be after end date" }
);


router.get("/timeline", (req, res) => {
  const validation = z.object({
    when: z.string().trim().min(1).max(100)
  }).safeParse(req.query);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      error: "A valid 'when' parameter is required"
    });
  }

  try {
    const result = getConversationTimeline(
      validation.data.when
    );

    if (!result) {
      return res.status(400).json({
        success: false,
        error: "Could not understand the requested date"
      });
    }

    return res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error("Timeline retrieval failed:", error);

    return res.status(500).json({
      success: false,
      error: "Unable to retrieve conversation timeline"
    });
  }
});


router.get("/search", (req, res) => {
  const validation = searchSchema.safeParse(req.query);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      error: validation.error.flatten()
    });
  }

  try {
    const results = searchMessages({
      query: validation.data.q,
      from: validation.data.from,
      to: validation.data.to,
      role: validation.data.role,
      limit: validation.data.limit
    });

    return res.json({
      success: true,
      count: results.length,
      data: results
    });
  } catch (error) {
    console.error("Memory search failed:", error);

    return res.status(500).json({
      success: false,
      error: "Unable to search conversation history"
    });
  }
});

export default router;


// Extract structured facts from a conversation
router.post("/:conversationId/extract", (req, res) => {
  const conversationId = req.params.conversationId;

  const conversation = db.prepare(`
    SELECT id FROM conversations WHERE id = ?
  `).get(conversationId);

  if (!conversation) {
    return res.status(404).json({
      success: false,
      error: "Conversation not found"
    });
  }

  try {
    const result = extractConversationFacts(conversationId);

    return res.json({
      success: true,
      message: "Memory extraction completed",
      data: result
    });
  } catch (error) {
    console.error("Memory extraction failed:", error);

    return res.status(500).json({
      success: false,
      error: "Unable to extract conversation facts"
    });
  }
});

// Retrieve structured facts
router.get("/facts", (req, res) => {
  const validation = z.object({
    q: z.string().trim().max(200).optional(),
    type: z.enum(["shortlist", "decision"]).optional(),
    conversationId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20)
  }).safeParse(req.query);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      error: validation.error.flatten()
    });
  }

  const { q, type, conversationId, limit } = validation.data;

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (q) {
    conditions.push(
      "(f.subject LIKE ? OR f.object LIKE ?)"
    );

    params.push(`%${q}%`, `%${q}%`);
  }

  if (type) {
    conditions.push("f.fact_type = ?");
    params.push(type);
  }

  if (conversationId) {
    conditions.push("f.conversation_id = ?");
    params.push(conversationId);
  }

  const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  const facts = db.prepare(`
    SELECT
      f.*,
      m.content AS source_content,
      m.created_at AS observed_at,
      c.title AS conversation_title

    FROM memory_facts f

    JOIN messages m
      ON m.id = f.source_message_id

    JOIN conversations c
      ON c.id = f.conversation_id

    ${whereClause}

    ORDER BY m.created_at DESC

    LIMIT ?
  `).all(...params, limit);

  return res.json({
    success: true,
    count: facts.length,
    data: facts
  });
});
