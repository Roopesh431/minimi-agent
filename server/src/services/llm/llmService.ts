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

export interface GroqRateLimitSnapshot {
  model: string;
  observedAt: string;
  statusCode?: number;
  limitRequests?: string;
  remainingRequests?: string;
  resetRequests?: string;
  limitTokens?: string;
  remainingTokens?: string;
  resetTokens?: string;
  retryAfter?: string;
}

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly retryAfterSeconds?: number,
    public readonly rateLimit?: GroqRateLimitSnapshot
  ) {
    super(message);
    this.name = "LLMError";
  }
}

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// Conservative local safeguards below the organization limits shown in Groq.
// These are per Node.js process, not a replacement for Groq's own enforcement.
const LIMITS = {
  requestsPerMinute: 25,
  requestsPerDay: 900,
  estimatedTokensPerMinute: 6500,
  estimatedTokensPerDay: 180000,
  maxConcurrentRequests: 1,
  windowMs: 60_000,
  dayMs: 24 * 60 * 60 * 1000
} as const;

interface UsageEntry {
  timestamp: number;
  requests: number;
  estimatedTokens: number;
  actualTokens?: number;
}

const usageEntries: UsageEntry[] = [];
let activeRequests = 0;
let queueTail: Promise<void> = Promise.resolve();
let cooldownUntil = 0;
let lastRateLimitSnapshot: GroqRateLimitSnapshot | undefined;

function pruneUsage(now: number): void {
  while (usageEntries.length && now - usageEntries[0].timestamp >= LIMITS.dayMs) {
    usageEntries.shift();
  }
}

function estimateTokens(options: LLMOptions): number {
  // A deliberately conservative approximation; Groq's returned usage is
  // recorded after each successful call and its response headers remain authoritative.
  const input = JSON.stringify({
    messages: options.messages,
    tools: options.tools ?? []
  });
  const estimatedPromptTokens = Math.ceil(input.length / 3);
  return estimatedPromptTokens + (options.maxCompletionTokens ?? 1200);
}

function getUsage(now: number, windowMs: number): {
  requests: number;
  tokens: number;
} {
  const entries = usageEntries.filter((entry) => now - entry.timestamp < windowMs);
  return {
    requests: entries.reduce((total, entry) => total + entry.requests, 0),
    tokens: entries.reduce(
      (total, entry) => total + (entry.actualTokens ?? entry.estimatedTokens),
      0
    )
  };
}

function getResetWait(now: number, windowMs: number): number {
  const oldest = usageEntries.find((entry) => now - entry.timestamp < windowMs);
  return oldest ? Math.max(1, Math.ceil((oldest.timestamp + windowMs - now) / 1000)) : 1;
}

function reserveCapacity(estimatedTokens: number): void {
  const now = Date.now();
  pruneUsage(now);

  if (now < cooldownUntil) {
    const waitSeconds = Math.ceil((cooldownUntil - now) / 1000);
    throw new LLMError(
      `Groq is cooling down after a rate limit. Try again in ${waitSeconds} seconds.`,
      429,
      waitSeconds,
      lastRateLimitSnapshot
    );
  }

  const minute = getUsage(now, LIMITS.windowMs);
  const day = getUsage(now, LIMITS.dayMs);

  if (minute.requests >= LIMITS.requestsPerMinute) {
    const wait = getResetWait(now, LIMITS.windowMs);
    throw new LLMError(
      `Minimi's local Groq request limit is reached. Try again in about ${wait} seconds.`,
      429,
      wait,
      lastRateLimitSnapshot
    );
  }

  if (minute.tokens + estimatedTokens > LIMITS.estimatedTokensPerMinute) {
    const wait = getResetWait(now, LIMITS.windowMs);
    throw new LLMError(
      `Minimi is protecting the Groq token-per-minute limit. Try again in about ${wait} seconds.`,
      429,
      wait,
      lastRateLimitSnapshot
    );
  }

  if (day.requests >= LIMITS.requestsPerDay) {
    throw new LLMError(
      "Minimi's local daily Groq request budget has been reached. It will reset within 24 hours.",
      429,
      3600,
      lastRateLimitSnapshot
    );
  }

  if (day.tokens + estimatedTokens > LIMITS.estimatedTokensPerDay) {
    throw new LLMError(
      "Minimi's local daily Groq token budget has been reached. Please try again later.",
      429,
      3600,
      lastRateLimitSnapshot
    );
  }

  usageEntries.push({
    timestamp: now,
    requests: 1,
    estimatedTokens
  });
}

function readRateLimitSnapshot(
  response: Response,
  model: string
): GroqRateLimitSnapshot {
  return {
    model,
    observedAt: new Date().toISOString(),
    statusCode: response.status,
    limitRequests: response.headers.get("x-ratelimit-limit-requests") ?? undefined,
    remainingRequests: response.headers.get("x-ratelimit-remaining-requests") ?? undefined,
    resetRequests: response.headers.get("x-ratelimit-reset-requests") ?? undefined,
    limitTokens: response.headers.get("x-ratelimit-limit-tokens") ?? undefined,
    remainingTokens: response.headers.get("x-ratelimit-remaining-tokens") ?? undefined,
    resetTokens: response.headers.get("x-ratelimit-reset-tokens") ?? undefined,
    retryAfter: response.headers.get("retry-after") ?? undefined
  };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(1, Math.ceil(seconds));
  }

  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.max(1, Math.ceil((date - Date.now()) / 1000));
  }

  return undefined;
}

async function withRequestSlot<T>(work: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const previous = queueTail;
  queueTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    if (activeRequests >= LIMITS.maxConcurrentRequests) {
      throw new LLMError("Minimi's Groq request queue is busy. Please retry shortly.", 429, 2);
    }
    activeRequests += 1;
    return await work();
  } finally {
    activeRequests = Math.max(0, activeRequests - 1);
    release();
  }
}

export function getGroqRateLimitStatus(): {
  limits: typeof LIMITS;
  minute: { requests: number; tokens: number };
  day: { requests: number; tokens: number };
  cooldownUntil: string | null;
  lastResponse: GroqRateLimitSnapshot | null;
} {
  const now = Date.now();
  pruneUsage(now);
  return {
    limits: LIMITS,
    minute: getUsage(now, LIMITS.windowMs),
    day: getUsage(now, LIMITS.dayMs),
    cooldownUntil: cooldownUntil > now ? new Date(cooldownUntil).toISOString() : null,
    lastResponse: lastRateLimitSnapshot ?? null
  };
}

export async function createChatCompletion(
  options: LLMOptions
): Promise<LLMResponse> {
  return withRequestSlot(async () => {
    const apiKey = process.env.GROQ_API_KEY;
    const model = process.env.LLM_MODEL || "openai/gpt-oss-20b";

    if (!apiKey) {
      throw new LLMError("GROQ_API_KEY is not configured.", 503);
    }

    const estimatedTokens = estimateTokens(options);
    reserveCapacity(estimatedTokens);

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
      response = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(45000)
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new LLMError("Groq request timed out.", 504);
      }
      throw new LLMError("Unable to connect to Groq.", 502);
    }

    const rateLimit = readRateLimitSnapshot(response, model);
    lastRateLimitSnapshot = rateLimit;

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error("Groq API error:", response.status, errorText.slice(0, 1000));

      if (response.status === 401 || response.status === 403) {
        throw new LLMError("Groq rejected the API key.", 502, undefined, rateLimit);
      }

      if (response.status === 429) {
        const retryAfterSeconds =
          parseRetryAfter(response.headers.get("retry-after")) ??
          parseRetryAfter(rateLimit.resetTokens ?? null) ??
          60;
        cooldownUntil = Math.max(cooldownUntil, Date.now() + retryAfterSeconds * 1000);

        throw new LLMError(
          `Groq rate limit reached. Minimi will pause new requests for ${retryAfterSeconds} seconds.`,
          429,
          retryAfterSeconds,
          rateLimit
        );
      }

      throw new LLMError(
        `Groq returned HTTP ${response.status}.`,
        502,
        undefined,
        rateLimit
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
      throw new LLMError("Groq returned invalid JSON.", 502, undefined, rateLimit);
    }

    const choice = data.choices?.[0];

    if (!choice?.message) {
      throw new LLMError("Groq returned an empty response.", 502, undefined, rateLimit);
    }

    const entry = usageEntries[usageEntries.length - 1];
    if (entry && data.usage?.total_tokens !== undefined) {
      entry.actualTokens = data.usage.total_tokens;
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
  });
}
