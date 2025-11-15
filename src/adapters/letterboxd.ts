import { fetchHtml, fetchJson } from "../utils";
import { idLookup } from "../id-lookup";
import type { MediaEntry } from "./schemas";
import * as cheerio from "cheerio";

// Rate limiting for Letterboxd requests to avoid overwhelming the server
let lastLetterboxdRequest = 0;
const LETTERBOXD_MIN_DELAY = 200; // 5 requests/second max

async function rateLimitedRequest<T>(fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastLetterboxdRequest;
  if (timeSinceLastRequest < LETTERBOXD_MIN_DELAY) {
    const waitTime = LETTERBOXD_MIN_DELAY - timeSinceLastRequest;
    if (waitTime > 1000) {
      console.log(`[RATE LIMIT] Waiting ${waitTime.toFixed(0)}ms before Letterboxd request`);
    }
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }
  lastLetterboxdRequest = Date.now();
  return fn();
}

export async function scrapeLetterboxdWatchlist(username: string, announced: { byKey: Set<string> }, onEntryProcessed: (entry: MediaEntry) => Promise<void>): Promise<void> {
  // Handle pagination - start with page 1
  let currentPage = 1;
  let hasMorePages = true;

  while (hasMorePages) {
    const url = currentPage === 1 ? `https://letterboxd.com/${username}/watchlist/` : `https://letterboxd.com/${username}/watchlist/page/${currentPage}/`;

    const html = await rateLimitedRequest(() => fetchHtml(url));
    const $ = cheerio.load(html);

    // Letterboxd watchlist uses li.griditem with data attributes
    let pageFilmCount = 0;

    // Process each film immediately as we find it
    for (const element of $("li.griditem").toArray()) {
      const $el = $(element);
      const $reactComponent = $el.find("div.react-component[data-item-slug]");

      if ($reactComponent.length === 0) continue;

      // Get slug from data-item-slug
      const slug = $reactComponent.attr("data-item-slug");
      if (!slug) continue;

      // Get film ID from data-film-id (used for constructing poster URL)
      const filmId = $reactComponent.attr("data-film-id");

      // Get title from data-item-name (format: "Title (Year)" or just "Title")
      const itemName = $reactComponent.attr("data-item-name") || "";
      if (!itemName) continue;

      // Parse title and year from data-item-name
      // Format can be "Title (Year)" or just "Title"
      const yearMatch = itemName.match(/\((\d{4})\)$/);
      let title = itemName;
      let year: number | undefined;

      if (yearMatch && yearMatch[1]) {
        year = parseInt(yearMatch[1], 10);
        title = itemName.replace(/\s*\(\d{4}\)$/, "").trim();
      } else {
        // Try to get year from data-item-full-display-name as fallback
        const fullDisplayName = $reactComponent.attr("data-item-full-display-name") || "";
        const fullYearMatch = fullDisplayName.match(/\((\d{4})\)$/);
        if (fullYearMatch && fullYearMatch[1]) {
          year = parseInt(fullYearMatch[1], 10);
          title = fullDisplayName.replace(/\s*\(\d{4}\)$/, "").trim();
        }
      }

      if (!year || isNaN(year) || !title) {
        // Skip entries without valid year or title
        continue;
      }

      // Check if already processed (using slug + year as key)
      const slugKey = `letterboxd:${slug}:${year}`;
      if (announced.byKey.has(slugKey)) {
        continue;
      }

      // Process this film immediately
      try {
        let tmdbId: string | undefined;
        let tvdbId: string | undefined;
        let isAnime = false;
        let imageUrl: string | undefined;

        // Try lookup service first for IDs
        const ids = idLookup.getIdsFromLetterboxd(slug);
        if (ids) {
          tmdbId = ids.tmdb;
          tvdbId = ids.tvdb;
          isAnime = ids.isAnime || false;
        }

        // Check if entry is already processed using slug key (most reliable check)
        if (announced.byKey.has(slugKey)) {
          continue;
        }

        // Get poster image URL from poster endpoint (most reliable)
        try {
          const posterJsonUrl = `https://letterboxd.com/film/${slug}/poster/std/250/`;
          const posterData = (await rateLimitedRequest(() => fetchJson(posterJsonUrl))) as { url?: string };
          if (posterData?.url) {
            imageUrl = posterData.url;
          }
        } catch (error) {
          // Fallback to constructed URL if poster endpoint fails
        }

        // Fallback: Construct poster image URL from film ID and slug (works for most films)
        if (!imageUrl && filmId) {
          // Poster URL pattern: https://a.ltrbxd.com/resized/film-poster/{digits}/{film_id}-{slug}-0-250-0-375-crop.jpg
          // Where digits are individual digits of film ID separated by slashes
          const filmIdDigits = filmId.split("").join("/");
          imageUrl = `https://a.ltrbxd.com/resized/film-poster/${filmIdDigits}/${filmId}-${slug}-0-250-0-375-crop.jpg`;
        }

        // Only fetch film page if we need fallback ID/anime detection
        if (!tmdbId || !isAnime) {
          try {
            const filmPageUrl = `https://letterboxd.com/film/${slug}/`;
            const filmPageHtml = await rateLimitedRequest(() => fetchHtml(filmPageUrl));
            const $filmPage = cheerio.load(filmPageHtml);

            // Fallback: Look for TMDB link if not found in lookup
            if (!tmdbId) {
              const tmdbLink = $filmPage('a[href*="themoviedb.org/movie"]').attr("href");
              if (tmdbLink) {
                const tmdbMatch = tmdbLink.match(/\/movie\/(\d+)/);
                if (tmdbMatch) {
                  tmdbId = tmdbMatch[1];
                }
              }
            }

            // Fallback: Check if it's anime by looking for MAL/AniDB links if not in lookup
            if (!isAnime) {
              const malLink = $filmPage('a[href*="myanimelist.net"]').attr("href");
              const anidbLink = $filmPage('a[href*="anidb.net"]').attr("href");
              if (malLink || anidbLink) {
                isAnime = true;
              }
            }
          } catch (error) {
            console.warn(`[ERROR] Failed to fetch film page data for ${title} (${year}) from Letterboxd:`, error);
          }
        }

        if (!tmdbId && !tvdbId) {
          console.warn(`[ERROR] No ID mapping found for Letterboxd slug "${slug}" (${title}, ${year})`);
        }

        const entry: MediaEntry = {
          tmdb: tmdbId,
          tvdb: tvdbId,
          title: title.trim(),
          year: year as number,
          type: "movie",
          source: "letterboxd",
          username,
          anime: isAnime,
          imageUrl,
          letterboxdSlug: slug,
        };

        // Compute entryKey AFTER we have all IDs (including from film page)
        const entryKey = tmdbId ? `tmdb:${tmdbId}` : tvdbId ? `tvdb:${tvdbId}` : `${title.trim()}:${year}:letterboxd:${username}`;

        // Double-check using entryKey (in case slug key wasn't loaded)
        if (announced.byKey.has(entryKey)) {
          // Mark slug key as processed too
          announced.byKey.add(slugKey);
          continue;
        }

        // Process entry immediately (adds to announced.jsonl, sends Discord, adds to entries list)
        await onEntryProcessed(entry);

        // Mark as processed using both keys
        announced.byKey.add(entryKey);
        announced.byKey.add(slugKey);

        pageFilmCount++;
      } catch (error) {
        console.error(`[ERROR] Failed to process Letterboxd entry ${slug}:`, error);
      }
    }

    // Check for next page
    const nextPageLink = $("div.pagination a.next").attr("href");
    if (nextPageLink) {
      currentPage++;
      console.log(`Moving to page ${currentPage} for ${username}`);
    } else {
      hasMorePages = false;
      console.log(`No more pages for ${username}. Processed ${pageFilmCount} films on final page.`);
    }
  }

  console.log(`Finished processing Letterboxd watchlist for ${username}`);
}
