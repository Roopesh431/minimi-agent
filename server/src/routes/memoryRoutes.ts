
import { Router } from "express";
import { z } from "zod";
import { searchMessages } from "../memory/retrieval";
import { getConversationTimeline } from "../memory/timeline";

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
