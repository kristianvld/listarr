import ky from "ky";

// Create a ky instance with default retry and timeout settings
export const httpClient = ky.create({
  retry: {
    limit: 3,
    methods: ["get", "post"],
    statusCodes: [408, 429, 500, 502, 503, 504],
  },
  timeout: 30000, // 30 seconds
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
  },
  hooks: {
    beforeRetry: [
      async ({ error, retryCount, request }) => {
        const url = request.url;
        const statusCode = (error as { response?: { status?: number; headers?: Headers } })?.response?.status;
        const responseHeaders = (error as { response?: { status?: number; headers?: Headers } })?.response?.headers;
        const isRateLimit = statusCode === 429;

        // Check for Retry-After header (preferred over exponential backoff)
        let delay = Math.min(1000 * Math.pow(2, retryCount - 1), 10000); // Default exponential backoff
        let usedRetryAfter = false;
        if (isRateLimit && responseHeaders) {
          try {
            const retryAfter = getRetryAfterSeconds(responseHeaders);
            if (retryAfter !== null && retryAfter > 0) {
              delay = retryAfter * 1000; // Convert seconds to milliseconds
              usedRetryAfter = true;
              console.log(`[RATE LIMIT] Using Retry-After header: ${retryAfter}s (${delay}ms)`);
            }
          } catch (err) {
            // Headers might not be accessible, fall back to exponential backoff
            console.log(`[RATE LIMIT] Could not read Retry-After header, using exponential backoff`);
          }
        }

        console.log(`[RETRY] Retry attempt ${retryCount} for ${url} after ${delay}ms delay${isRateLimit ? " (rate limited)" : ""}`);
        if (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.log(`[RETRY] Error: ${errorMsg}${statusCode ? ` (HTTP ${statusCode})` : ""}`);
        }

        // Log longer delays more prominently
        if (delay >= 2000) {
          console.log(`[RATE LIMIT] Waiting ${delay}ms before retry${usedRetryAfter ? " (from Retry-After header)" : " (exponential backoff)"}`);
        }

        await new Promise((resolve) => setTimeout(resolve, delay));
      },
    ],
  },
});

// Helper to get HTML text
export async function fetchHtml(url: string): Promise<string> {
  console.log(`Fetching HTML from ${url}`);
  const response = await httpClient.get(url);
  return await response.text();
}

// Helper to get JSON (returns response for header access)
export async function fetchJsonResponse(url: string, options?: { headers?: Record<string, string> }): Promise<Response> {
  console.log(`Fetching JSON from ${url}`);
  return await httpClient.get(url, options);
}

// Helper to get JSON (returns parsed data)
export async function fetchJson(url: string, options?: { headers?: Record<string, string> }): Promise<unknown> {
  const response = await fetchJsonResponse(url, options);
  return await response.json();
}

// Helper to extract Retry-After header value (in seconds)
// Accepts Response object or Headers object or object with headers property
export function getRetryAfterSeconds(response: Response | Headers | { headers?: Headers } | null | undefined): number | null {
  if (!response) return null;

  let headers: Headers | null = null;
  if (response instanceof Headers) {
    headers = response;
  } else if (response instanceof Response) {
    headers = response.headers;
  } else if (response && typeof response === "object" && "headers" in response && response.headers instanceof Headers) {
    headers = response.headers;
  }

  if (!headers) return null;

  const retryAfter = headers.get("Retry-After");
  if (!retryAfter) return null;

  // Retry-After can be either seconds (number) or HTTP date
  const seconds = parseInt(retryAfter, 10);
  if (!isNaN(seconds)) {
    return seconds;
  }

  // Try parsing as HTTP date
  const date = new Date(retryAfter);
  if (!isNaN(date.getTime())) {
    const now = Date.now();
    const waitSeconds = Math.ceil((date.getTime() - now) / 1000);
    return Math.max(0, waitSeconds);
  }

  return null;
}

// Helper to extract Discord rate limit headers
// Accepts Response object or Headers object or object with headers property
export function getDiscordRateLimitInfo(response: Response | Headers | { headers?: Headers } | null | undefined): { resetAfter?: number; remaining?: number; limit?: number } | null {
  if (!response) return null;

  let headers: Headers | null = null;
  if (response instanceof Headers) {
    headers = response;
  } else if (response instanceof Response) {
    headers = response.headers;
  } else if (response && typeof response === "object" && "headers" in response && response.headers instanceof Headers) {
    headers = response.headers;
  }

  if (!headers) return null;

  const resetAfter = headers.get("X-RateLimit-Reset-After");
  const remaining = headers.get("X-RateLimit-Remaining");
  const limit = headers.get("X-RateLimit-Limit");

  if (!resetAfter && !remaining && !limit) return null;

  return {
    resetAfter: resetAfter ? parseFloat(resetAfter) : undefined,
    remaining: remaining ? parseInt(remaining, 10) : undefined,
    limit: limit ? parseInt(limit, 10) : undefined,
  };
}
