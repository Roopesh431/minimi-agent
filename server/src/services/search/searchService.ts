
export interface SearchResult {
  position: number;
  site_name: string;
  title: string;
  url: string;
  snippet: string;
}

interface TinyFishResponse {
  query?: string;
  results?: SearchResult[];
  total_results?: number;
  page?: number;
}

export interface SearchOptions {
  query: string;
  location?: string;
  language?: string;
  recencyMinutes?: number;
  page?: number;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  totalResults: number;
  page: number;
}

export class SearchProviderError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "SearchProviderError";
  }
}

export async function searchWeb(
  options: SearchOptions
): Promise<SearchResponse> {
  const apiKey = process.env.TINYFISH_API_KEY;

  if (!apiKey) {
    throw new SearchProviderError(
      "TinyFish API key is not configured.",
      503
    );
  }

  const params = new URLSearchParams({
    query: options.query,
    location: options.location ?? "IN",
    language: options.language ?? "en"
  });

  if (options.recencyMinutes !== undefined) {
    params.set("recency_minutes", String(options.recencyMinutes));
  }

  if (options.page !== undefined) {
    params.set("page", String(options.page));
  }

  let response: Response;

  try {
    response = await fetch(
      `https://api.search.tinyfish.ai/?${params.toString()}`,
      {
        method: "GET",
        headers: {
          "X-API-Key": apiKey,
          Accept: "application/json"
        },
        signal: AbortSignal.timeout(20000)
      }
    );
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new SearchProviderError(
        "The search provider timed out. Please try again.",
        504
      );
    }

    throw new SearchProviderError(
      "Unable to connect to the search provider.",
      502
    );
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new SearchProviderError(
        "The search provider rejected the API key.",
        502
      );
    }

    if (response.status === 429) {
      throw new SearchProviderError(
        "Search rate limit reached. Please wait before trying again.",
        429
      );
    }

    throw new SearchProviderError(
      `Search provider returned HTTP ${response.status}.`,
      502
    );
  }

  let data: TinyFishResponse;

  try {
    data = (await response.json()) as TinyFishResponse;
  } catch {
    throw new SearchProviderError(
      "The search provider returned an invalid response.",
      502
    );
  }

  if (!Array.isArray(data.results)) {
    throw new SearchProviderError(
      "The search provider response did not contain search results.",
      502
    );
  }

  const results = data.results
    .filter(
      (item) =>
        typeof item.title === "string" &&
        typeof item.url === "string" &&
        typeof item.snippet === "string"
    )
    .map((item) => ({
      position: Number(item.position) || 0,
      site_name: item.site_name ?? "",
      title: item.title,
      url: item.url,
      snippet: item.snippet
    }));

  return {
    query: options.query,
    results,
    totalResults: Number(data.total_results) || results.length,
    page: Number(data.page) || options.page || 0
  };
}
