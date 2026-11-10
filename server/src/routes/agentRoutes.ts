
import { Router } from "express";
import { z } from "zod";
import { runAgent } from "../services/agent/agentService";
import { LLMError } from "../services/llm/llmService";

const router = Router();

const chatSchema = z.object({
  message: z.string().trim().min(1).max(10000),
  conversationId: z.string().uuid().optional()
});

router.post("/chat", async (req, res) => {
  const validation = chatSchema.safeParse(req.body);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Invalid chat request.",
      errors: validation.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message
      }))
    });
  }

  try {
    const result = await runAgent({
      message: validation.data.message,
      conversationId: validation.data.conversationId
    });

    return res.json({
      success: true,
      data: result
    });
  } catch (error) {
    if (error instanceof LLMError) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message
      });
    }

    console.error("Agent chat error:", error);

    return res.status(500).json({
      success: false,
      message: "An unexpected error occurred while processing your message."
    });
  }
});

export default router;
