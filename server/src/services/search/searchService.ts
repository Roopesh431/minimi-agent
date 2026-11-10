
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

// Domains that are usually poor primary sources for news searches.
// They are not blocked for ordinary searches.
const NEWS_EXCLUDED_DOMAINS = [
  "youtube.com",
  "youtu.be",
  "instagram.com",
  "facebook.com",
  "tiktok.com",
  "pinterest.com",
  "linkedin.com",
  "reddit.com",
  "x.com",
  "twitter.com"
];

function isNewsQuery(query: string): boolean {
  return /\b(news|latest|recent|today|yesterday|developments?|announcements?|launched|launches|released|release|breaking|last\s+\d+\s+(hours?|days?)|past\s+\d+\s+(hours?|days?)|last\s+24\s+hours|past\s+24\s+hours|this\s+week)\b/i.test(
    query
  );
}

function normalizeUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);

    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }

    // Remove tracking parameters so the same article
    // is not returned multiple times.
    const trackingParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "ref",
      "source"
    ];

    trackingParams.forEach((param) => {
      url.searchParams.delete(param);
    });

    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");

    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }

    return url.toString();
  } catch {
    return null;
  }
}

function isExcludedNewsDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname
      .toLowerCase()
      .replace(/^www\./, "");

    return NEWS_EXCLUDED_DOMAINS.some(
      (domain) =>
        hostname === domain || hostname.endsWith(`.${domain}`)
    );
  } catch {
    return true;
  }
}

function cleanResults(
  rawResults: SearchResult[],
  query: string
): SearchResult[] {
  const seenUrls = new Set<string>();
  const newsSearch = isNewsQuery(query);

  return rawResults
    .filter((item) => {
      if (
        !item ||
        typeof item.title !== "string" ||
        typeof item.url !== "string" ||
        typeof item.snippet !== "string"
      ) {
        return false;
      }

      if (!item.title.trim() || !item.snippet.trim()) {
        return false;
      }

      const normalizedUrl = normalizeUrl(item.url);

      if (!normalizedUrl) {
        return false;
      }

      if (newsSearch && isExcludedNewsDomain(normalizedUrl)) {
        return false;
      }

      if (seenUrls.has(normalizedUrl)) {
        return false;
      }

      seenUrls.add(normalizedUrl);
      return true;
    })
    .map((item, index) => {
      const normalizedUrl = normalizeUrl(item.url)!;

      let siteName = item.site_name;

      if (!siteName) {
        siteName = new URL(normalizedUrl).hostname;
      }

      return {
        position: index + 1,
        site_name: siteName,
        title: item.title.trim(),
        url: normalizedUrl,
        snippet: item.snippet.trim()
      };
    });
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

  const query = options.query.trim();

  if (!query) {
    throw new SearchProviderError(
      "Search query cannot be empty.",
      400
    );
  }

  const params = new URLSearchParams({
    query,
    location: options.location ?? "IN",
    language: options.language ?? "en"
  });

  if (options.recencyMinutes !== undefined) {
    params.set(
      "recency_minutes",
      String(options.recencyMinutes)
    );
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
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
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

  const results = cleanResults(data.results, query);

  return {
    query,
    results,
    totalResults: Number(data.total_results) || results.length,
    page: Number(data.page) || options.page || 0
  };
}
