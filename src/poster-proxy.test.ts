import { describe, expect, test } from "bun:test";
import { allowedPosterUrl, proxyPoster } from "./poster-proxy";

describe("poster proxy security", () => {
  test("rejects internal destinations, credentials, nonstandard ports and lookalike hosts", async () => {
    for (const url of ["http://127.0.0.1/", "https://[::1]/", "https://169.254.169.254/", "https://cdn.myanimelist.net.evil.example/a", "https://cdn.myanimelist.net@127.0.0.1/a", "https://user:pass@cdn.myanimelist.net/a", "https://cdn.myanimelist.net:8443/a", "file:///etc/passwd"]) {
      expect(allowedPosterUrl(url)).toBeNull();
      const response = await proxyPoster(url, async () => { throw new Error("Must not fetch"); });
      expect(response.status).toBe(400);
    }
  });

  test("checks redirect targets before making another request", async () => {
    let requests = 0;
    const response = await proxyPoster("https://cdn.myanimelist.net/a.jpg", async () => {
      requests++;
      return Response.redirect("http://127.0.0.1/private", 302);
    });
    expect(response.status).toBe(502);
    expect(requests).toBe(1);
  });

  test("allows known CDN redirects and preserves safe image content", async () => {
    let requests = 0;
    const response = await proxyPoster("https://media.themoviedb.org/a.jpg", async (_url, options) => {
      expect(options.redirect).toBe("manual");
      return ++requests === 1 ? Response.redirect("https://image.tmdb.org/b.jpg", 302) : new Response("image", { headers: { "content-type": "image/jpeg" } });
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("image");
  });

  test("rejects HTML, SVG, oversized streams and redirect loops", async () => {
    for (const contentType of ["text/html", "image/svg+xml"]) {
      expect((await proxyPoster("https://cdn.myanimelist.net/a", async () => new Response("payload", { headers: { "content-type": contentType } }))).status).toBe(502);
    }
    expect((await proxyPoster("https://cdn.myanimelist.net/a", async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1), { headers: { "content-type": "image/png" } }))).status).toBe(502);
    let requests = 0;
    expect((await proxyPoster("https://cdn.myanimelist.net/a", async () => { requests++; return Response.redirect("https://cdn.myanimelist.net/a"); })).status).toBe(502);
    expect(requests).toBe(4);
  });
});
