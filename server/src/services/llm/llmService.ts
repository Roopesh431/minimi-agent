
export type LLMRole = "system" | "user" | "assistant" | "tool";

export interface LLMToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMMessage {
  role: LLMRole;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: LLMToolCall[];
}

export interface LLMOptions {
  messages: LLMMessage[];
  tools?: unknown[];
  toolChoice?: "auto" | "none" | "required";
  temperature?: number;
  maxCompletionTokens?: number;
}

export interface LLMResponse {
  message: LLMMessage;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  finishReason: string;
}

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "LLMError";
  }
}

export async function createChatCompletion(
  options: LLMOptions
): Promise<LLMResponse> {
  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.LLM_MODEL || "openai/gpt-oss-20b";

  if (!apiKey) {
    throw new LLMError("GROQ_API_KEY is not configured.", 503);
  }

  const requestBody: Record<string, unknown> = {
    model,
    messages: options.messages,
    temperature: options.temperature ?? 0.2,
    max_completion_tokens: options.maxCompletionTokens ?? 1200,
    stream: false
  };

  if (options.tools?.length) {
    requestBody.tools = options.tools;
    requestBody.tool_choice = options.toolChoice ?? "auto";
  } else if (options.toolChoice === "none") {
    requestBody.tool_choice = "none";
  }

  let response: Response;

  try {
    response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(45000)
      }
    );
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new LLMError("Groq request timed out.", 504);
    }

    throw new LLMError("Unable to connect to Groq.", 502);
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");

    console.error(
      "Groq API error:",
      response.status,
      errorText.slice(0, 1000)
    );

    if (response.status === 401 || response.status === 403) {
      throw new LLMError("Groq rejected the API key.", 502);
    }

    if (response.status === 429) {
      throw new LLMError(
        "Groq rate limit reached. Please try again later.",
        429
      );
    }

    throw new LLMError(
      `Groq returned HTTP ${response.status}.`,
      502
    );
  }

  let data: {
    model?: string;
    choices?: Array<{
      message?: {
        role?: string;
        content?: string | null;
        tool_calls?: LLMToolCall[];
      };
      finish_reason?: string;
    }>;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  };

  try {
    data = await response.json();
  } catch {
    throw new LLMError("Groq returned invalid JSON.", 502);
  }

  const choice = data.choices?.[0];

  if (!choice?.message) {
    throw new LLMError("Groq returned an empty response.", 502);
  }

  return {
    message: {
      role: "assistant",
      content: choice.message.content ?? null,
      tool_calls: choice.message.tool_calls
    },
    model: data.model ?? model,
    usage: data.usage,
    finishReason: choice.finish_reason ?? "unknown"
  };
}
