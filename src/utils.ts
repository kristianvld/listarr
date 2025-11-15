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
      async ({ error, retryCount }) => {
        // Exponential backoff: 1s, 2s, 4s
        const delay = Math.min(1000 * Math.pow(2, retryCount - 1), 10000);
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

// Helper to get JSON
export async function fetchJson(url: string, options?: { headers?: Record<string, string> }): Promise<unknown> {
  console.log(`Fetching JSON from ${url}`);
  const response = await httpClient.get(url, options);
  return await response.json();
}
