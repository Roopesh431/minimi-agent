
import { Router } from "express";
import { z } from "zod";

import db from "../database/database";
import { searchMessages } from "../memory/retrieval";
import { getConversationTimeline } from "../memory/timeline";
import { extractConversationFacts } from "../memory/extraction";

const router = Router();

// ==========================================
// VALIDATION SCHEMAS
// ==========================================

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

const timelineSchema = z.object({
  when: z.string().trim().min(1).max(100)
});

const factsSchema = z.object({
  q: z.string().trim().max(200).optional(),
  type: z.enum(["shortlist", "decision"]).optional(),
  conversationId: z.string().uuid().optional(),
  status: z.enum(["current", "superseded", "all"]).default("current"),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

const supersedeSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  replacementFactId: z.string().uuid().optional()
});

// ==========================================
// 1. TIMELINE RETRIEVAL
// GET /api/memory/timeline?when=today
// ==========================================

router.get("/timeline", (req, res) => {
  const validation = timelineSchema.safeParse(req.query);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      error: validation.error.flatten()
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

// ==========================================
// 2. HISTORICAL MESSAGE SEARCH
// GET /api/memory/search?q=PostgreSQL
// ==========================================

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

// ==========================================
// 3. EXTRACT STRUCTURED MEMORY
// POST /api/memory/:conversationId/extract
// ==========================================

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

// ==========================================
// 4. RETRIEVE STRUCTURED FACTS
// GET /api/memory/facts
// ==========================================

router.get("/facts", (req, res) => {
  const validation = factsSchema.safeParse(req.query);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      error: validation.error.flatten()
    });
  }

  const {
    q,
    type,
    conversationId,
    status,
    limit
  } = validation.data;

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

  if (status !== "all") {
    conditions.push("f.status = ?");
    params.push(status);
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

// ==========================================
// 5. SUPERSEDE A MEMORY FACT
// POST /api/memory/facts/:factId/supersede
// ==========================================

router.post("/facts/:factId/supersede", (req, res) => {
  const validation = supersedeSchema.safeParse(req.body);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      error: validation.error.flatten()
    });
  }

  const { factId } = req.params;

  const {
    reason,
    replacementFactId
  } = validation.data;

  try {
    const transaction = db.transaction(() => {

      const existing = db.prepare(`
        SELECT id, fact_type, status
        FROM memory_facts
        WHERE id = ?
      `).get(factId) as {
        id: string;
        fact_type: string;
        status: string;
      } | undefined;

      if (!existing) {
        throw new Error("FACT_NOT_FOUND");
      }

      if (existing.status === "superseded") {
        throw new Error("FACT_ALREADY_SUPERSEDED");
      }

      if (replacementFactId) {

        if (replacementFactId === factId) {
          throw new Error("INVALID_REPLACEMENT");
        }

        const replacement = db.prepare(`
          SELECT id, fact_type, status
          FROM memory_facts
          WHERE id = ?
        `).get(replacementFactId) as {
          id: string;
          fact_type: string;
          status: string;
        } | undefined;

        if (!replacement) {
          throw new Error("REPLACEMENT_NOT_FOUND");
        }

        if (replacement.status !== "current") {
          throw new Error("REPLACEMENT_NOT_CURRENT");
        }

        if (replacement.fact_type !== existing.fact_type) {
          throw new Error("INCOMPATIBLE_REPLACEMENT");
        }
      }

      db.prepare(`
        UPDATE memory_facts
        SET
          status = 'superseded',
          superseded_by_fact_id = ?,
          superseded_at = CURRENT_TIMESTAMP,
          supersession_reason = ?
        WHERE id = ?
      `).run(
        replacementFactId ?? null,
        reason,
        factId
      );

      return db.prepare(`
        SELECT * FROM memory_facts WHERE id = ?
      `).get(factId);
    });

    const result = transaction();

    return res.json({
      success: true,
      message: "Memory fact superseded successfully",
      data: result
    });

  } catch (error) {

    const code = error instanceof Error
      ? error.message
      : "";

    const errors: Record<
      string,
      { status: number; message: string }
    > = {
      FACT_NOT_FOUND: {
        status: 404,
        message: "Memory fact not found"
      },
      FACT_ALREADY_SUPERSEDED: {
        status: 409,
        message: "Memory fact is already superseded"
      },
      INVALID_REPLACEMENT: {
        status: 400,
        message: "A fact cannot replace itself"
      },
      REPLACEMENT_NOT_FOUND: {
        status: 404,
        message: "Replacement fact not found"
      },
      REPLACEMENT_NOT_CURRENT: {
        status: 409,
        message: "Replacement fact is not current"
      },
      INCOMPATIBLE_REPLACEMENT: {
        status: 400,
        message: "Replacement must have the same fact type"
      }
    };

    if (errors[code]) {
      return res.status(errors[code].status).json({
        success: false,
        error: errors[code].message
      });
    }

    console.error("Fact supersession failed:", error);

    return res.status(500).json({
      success: false,
      error: "Unable to supersede memory fact"
    });
  }
});

export default router;
