const POSTER_HOSTS = new Set([
  "cdn.myanimelist.net",
  "image.tmdb.org",
  "media.themoviedb.org",
  "a.ltrbxd.com",
  "s.ltrbxd.com",
]);
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
const MAX_BYTES = 8 * 1024 * 1024;
type PosterFetch = (url: URL, options: RequestInit) => Promise<Response>;

export function allowedPosterUrl(raw: string): URL | null {
  if (raw.length > 4096) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && POSTER_HOSTS.has(url.hostname)
      ? url
      : null;
  } catch {
    return null;
  }
}

export async function proxyPoster(raw: string | null, fetchPoster: PosterFetch = (url, options) => fetch(url, options)): Promise<Response> {
  let url = raw ? allowedPosterUrl(raw) : null;
  if (!url) return new Response("Unsupported poster URL", { status: 400 });
  const signal = AbortSignal.timeout(10000);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const upstream = await fetchPoster(url, {
        redirect: "manual",
        signal,
        headers: { "User-Agent": "Mozilla/5.0 Listarr" },
      });
      if ([301, 302, 303, 307, 308].includes(upstream.status)) {
        const location = upstream.headers.get("location");
        await upstream.body?.cancel();
        url = location ? allowedPosterUrl(new URL(location, url).href) : null;
        if (!url) break;
        continue;
      }
      const contentType = upstream.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (!upstream.ok || !upstream.body || !contentType || !IMAGE_TYPES.has(contentType) || Number(upstream.headers.get("content-length")) > MAX_BYTES) {
        await upstream.body?.cancel();
        break;
      }
      const reader = upstream.body.getReader();
      const chunks: ArrayBuffer[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) {
          await reader.cancel();
          return new Response("Poster too large", { status: 502 });
        }
        chunks.push(new Uint8Array(value).buffer);
      }
      return new Response(new Blob(chunks), {
        headers: {
          "Cache-Control": "public, max-age=86400",
          "Content-Type": contentType,
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      });
    }
  } catch {
    // Do not expose upstream URLs, network details, or response bodies.
  }
  return new Response("Poster unavailable", { status: 502 });
}
