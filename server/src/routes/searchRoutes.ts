
import { Router } from "express";
import { z } from "zod";
import {
  searchWeb,
  SearchProviderError
} from "../services/search/searchService";

const router = Router();

const searchQuerySchema = z.object({
  q: z.string().trim().min(2).max(500),
  location: z.string().trim().length(2).optional(),
  language: z.string().trim().min(2).max(5).optional(),
  recencyMinutes: z.coerce.number().int().min(1).max(5256000).optional(),
  page: z.coerce.number().int().min(0).max(10).optional()
});

router.get("/", async (req, res) => {
  const validation = searchQuerySchema.safeParse(req.query);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Invalid search parameters.",
      errors: validation.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message
      }))
    });
  }

  try {
    const result = await searchWeb({
      query: validation.data.q,
      location: validation.data.location ?? "IN",
      language: validation.data.language ?? "en",
      recencyMinutes: validation.data.recencyMinutes,
      page: validation.data.page
    });

    return res.json({
      success: true,
      data: result
    });
  } catch (error) {
    if (error instanceof SearchProviderError) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message
      });
    }

    console.error("Unexpected search error:", error);

    return res.status(500).json({
      success: false,
      message: "An unexpected error occurred during search."
    });
  }
});

export default router;
