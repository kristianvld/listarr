import { z } from "zod";
import type { MediaEntry } from "./types";
import { fetchJson } from "../utils";
import { MyAnimeListEntrySchema, AnnouncedEntrySchema, type MyAnimeListEntry, JikanAnimeSchema } from "./schemas";
import { idLookup } from "../id-lookup";

const JIKAN_BASE = "https://api.jikan.moe/v4";

// Rate limiting: Jikan allows 3 requests/second, 60 requests/minute
let lastJikanRequest = 0;
const JIKAN_MIN_DELAY = 350; // ~3 requests/second

async function jikanRequest<T>(path: string): Promise<T> {
  // Rate limiting
  const now = Date.now();
  const timeSinceLastRequest = now - lastJikanRequest;
  if (timeSinceLastRequest < JIKAN_MIN_DELAY) {
    await new Promise((resolve) => setTimeout(resolve, JIKAN_MIN_DELAY - timeSinceLastRequest));
  }
  lastJikanRequest = Date.now();

  const url = `${JIKAN_BASE}${path}`;
  const rawData = await fetchJson(url);
  return rawData as T;
}

async function traceToRootSeries(malId: number, originalType: string, announced: { byMalId: Set<number>; byRootMalId: Set<number> }, onIntermediaryFound: (malId: number) => void): Promise<number> {
  const visited = new Set<number>();
  let currentId = malId;
  const isOriginalMovie = originalType === "Movie";

  while (true) {
    if (visited.has(currentId)) {
      // Circular reference, return current
      return currentId;
    }
    visited.add(currentId);

    try {
      const relationsData = await jikanRequest<{ data: Array<{ relation: string; entry: Array<{ mal_id: number; type: string }> }> }>(`/anime/${currentId}/relations`);
      const relations = relationsData.data;

      // For movies, we only trace to TV series if they're part of a TV series.
      // We check for: Parent Story (points to TV), Sequel (points to TV), or Prequel (from TV).
      if (isOriginalMovie && currentId === malId) {
        // Check if this movie has a Parent Story pointing to a TV series
        const parentStoryRelation = relations.find((r) => r.relation === "Parent Story");
        let hasTVParentStory = false;
        if (parentStoryRelation && parentStoryRelation.entry.length > 0 && parentStoryRelation.entry[0]) {
          const parentId = parentStoryRelation.entry[0].mal_id;
          const parentAnime = await jikanRequest<{ data: { type: string; episodes: number | null } }>(`/anime/${parentId}`);
          if (parentAnime.data.type === "TV" && parentAnime.data.episodes && parentAnime.data.episodes > 1) {
            hasTVParentStory = true;
          }
        }

        // Check if this movie has a Sequel pointing to a TV series
        const sequelRelation = relations.find((r) => r.relation === "Sequel");
        let hasTVSequel = false;
        if (sequelRelation && sequelRelation.entry.length > 0 && sequelRelation.entry[0]) {
          const sequelId = sequelRelation.entry[0].mal_id;
          const sequelAnime = await jikanRequest<{ data: { type: string; episodes: number | null } }>(`/anime/${sequelId}`);
          if (sequelAnime.data.type === "TV" && sequelAnime.data.episodes && sequelAnime.data.episodes > 1) {
            hasTVSequel = true;
          }
        }

        // Check if this movie has a Prequel from a TV series
        const prequelRelation = relations.find((r) => r.relation === "Prequel");
        let hasTVPrequel = false;
        if (prequelRelation && prequelRelation.entry.length > 0 && prequelRelation.entry[0]) {
          const prequelId = prequelRelation.entry[0].mal_id;
          const prequelAnime = await jikanRequest<{ data: { type: string; episodes: number | null } }>(`/anime/${prequelId}`);
          if (prequelAnime.data.type === "TV" && prequelAnime.data.episodes && prequelAnime.data.episodes > 1) {
            hasTVPrequel = true;
          }
        }

        // Only trace if movie is part of a TV series (has Parent Story, Sequel to TV, or Prequel from TV)
        // Otherwise, it's a standalone movie or movie trilogy, don't trace
        if (!hasTVParentStory && !hasTVSequel && !hasTVPrequel) {
          return currentId;
        }
      }

      // Look for Parent Story, Prequel, Sequel, or Full Story (which points to the main series)
      // For movies that are part of a series, Sequel can point to the TV series
      const parentRelation = relations.find(
        (r) => r.relation === "Parent Story" || r.relation === "Prequel" || r.relation === "Full Story" || (isOriginalMovie && r.relation === "Sequel") // Only use Sequel for movies
      );

      if (!parentRelation || parentRelation.entry.length === 0) {
        // No parent found, this is the root
        return currentId;
      }

      // Get the parent anime details to check if it's a TV series
      const parentEntry = parentRelation.entry[0];
      if (!parentEntry) {
        return currentId;
      }
      const parentId = parentEntry.mal_id;

      // Check if parent is already processed as a root - if so, return it
      if (announced.byRootMalId.has(parentId)) {
        // Parent is already the root, return it
        return parentId;
      }

      // Mark current as intermediary (only if it's not the starting ID)
      if (currentId !== malId) {
        onIntermediaryFound(currentId);
      }

      const parentAnime = await jikanRequest<{ data: { type: string; episodes: number | null } }>(`/anime/${parentId}`);

      // If parent is TV series with multiple episodes, continue tracing to it
      // This handles movies that are part of a TV series (e.g., Re:Zero Memory Snow)
      if (parentAnime.data.type === "TV" && parentAnime.data.episodes && parentAnime.data.episodes > 1) {
        currentId = parentId;
        continue;
      }

      // Parent is not a multi-episode TV series, return current
      return currentId;
    } catch (error) {
      console.warn(`[ERROR] Failed to trace parent for MAL ID ${currentId}:`, error);
      return currentId;
    }
  }
}

export async function scrapeMyAnimeListWatchlist(username: string, announced: { byKey: Set<string>; byMalId: Set<number>; byRootMalId: Set<number> }, onEntryProcessed: (entry: MediaEntry) => Promise<void>): Promise<void> {
  let offset = 0;
  let hasMore = true;

  // Fetch all pages using pagination
  while (hasMore) {
    const url = `https://myanimelist.net/animelist/${username}/load.json?offset=${offset}`;
    const rawData = await fetchJson(url);

    // Parse the array of entries
    const malEntries = z.array(MyAnimeListEntrySchema).parse(rawData);

    if (malEntries.length === 0) {
      hasMore = false;
      break;
    }

    // Process entries with status=6 (Plan to Watch) one at a time
    for (const malEntry of malEntries) {
      if (malEntry.status !== 6) continue; // Only process "Plan to Watch" items

      // Check if this MAL ID is already processed
      if (announced.byMalId.has(malEntry.anime_id)) {
        continue;
      }

      try {
        // Get anime details from Jikan to determine type
        const animeData = await jikanRequest<{ data: z.infer<typeof JikanAnimeSchema> }>(`/anime/${malEntry.anime_id}`);
        const anime = JikanAnimeSchema.parse(animeData.data);

        // Trace to root series for all types (including movies that are part of a series)
        let rootMalId = malEntry.anime_id;
        let rootAnime = anime;
        const intermediaries: number[] = [];

        // Try to trace to parent TV series (movies only trace if sandwiched between TV series)
        rootMalId = await traceToRootSeries(malEntry.anime_id, anime.type, announced, (malId) => {
          intermediaries.push(malId);
        });

        // Check if root is already processed
        if (announced.byRootMalId.has(rootMalId)) {
          // Mark this entry and intermediaries as processed
          announced.byMalId.add(malEntry.anime_id);
          for (const interId of intermediaries) {
            announced.byMalId.add(interId);
          }
          continue;
        }

        // Get root anime details if different from original
        if (rootMalId !== malEntry.anime_id) {
          const rootData = await jikanRequest<{ data: z.infer<typeof JikanAnimeSchema> }>(`/anime/${rootMalId}`);
          rootAnime = JikanAnimeSchema.parse(rootData.data);
        }

        // Extract year from aired date
        let year: number | undefined;
        if (rootAnime.aired?.from) {
          const date = new Date(rootAnime.aired.from);
          if (!isNaN(date.getTime())) {
            year = date.getFullYear();
          }
        }

        // Fallback to anime_start_date_string if no year from Jikan
        if (!year && malEntry.anime_start_date_string) {
          const dateRegex = /^(\d{2})-(\d{2})-(\d{2})$/;
          const match = malEntry.anime_start_date_string.match(dateRegex);
          if (match && match[3]) {
            const yearStr = match[3];
            year = parseInt(yearStr, 10);
            if (!isNaN(year)) {
              year = year < 50 ? 2000 + year : 1900 + year;
            }
          }
        }

        if (!year || isNaN(year)) {
          console.warn(`[ERROR] Skipping ${rootAnime.title} (MAL ID: ${rootMalId}): no valid year`);
          continue;
        }

        const title = rootAnime.title_english || rootAnime.title;

        // Get IDs from lookup service
        const ids = idLookup.getIdsFromMal(rootMalId);
        let tvdbId: string | undefined;
        let tmdbId: string | undefined;

        if (ids) {
          tvdbId = ids.tvdb;
          tmdbId = ids.tmdb;
        } else {
          console.warn(`[ERROR] No ID mapping found for MAL ID ${rootMalId} (${title})`);
        }

        // Determine type based on root anime
        // If we traced to a TV series, it's a TV show (even if original was a movie/OVA)
        // Otherwise, standalone movies and single-episode OVAs/Specials are movies
        const tracedToTV = rootMalId !== malEntry.anime_id && rootAnime.type === "TV";
        const isRootMovie = !tracedToTV && (rootAnime.type === "Movie" || (rootAnime.episodes === 1 && rootAnime.type !== "TV"));
        const mediaType = isRootMovie ? "movie" : "tv";

        // Get image URL from Jikan
        const imageUrl = rootAnime.images?.jpg?.large_image_url || rootAnime.images?.jpg?.image_url || rootAnime.images?.webp?.large_image_url || rootAnime.images?.webp?.image_url || undefined;

        // Get episode count (for TV shows)
        const episodes = mediaType === "tv" ? rootAnime.episodes || undefined : undefined;

        const entry: MediaEntry = {
          tvdb: tvdbId,
          tmdb: tmdbId,
          title,
          year,
          type: mediaType,
          source: "myanimelist",
          username,
          anime: true,
          malId: malEntry.anime_id,
          rootMalId: rootMalId !== malEntry.anime_id ? rootMalId : undefined,
          imageUrl,
          episodes,
        };

        // Process entry immediately (adds to announced.jsonl, sends Discord, adds to entries list)
        await onEntryProcessed(entry);

        // Also mark intermediaries as processed (add to announced sets to prevent reprocessing)
        for (const interId of intermediaries) {
          if (!announced.byMalId.has(interId)) {
            announced.byMalId.add(interId);
            // Add stub entry to announced.jsonl to prevent reprocessing (won't appear in lists)
            const stubEntry: MediaEntry = {
              title: `[Intermediary: MAL ${interId}]`,
              year: 1900, // Dummy year - will be filtered out from lists
              type: "tv",
              source: "myanimelist",
              username,
              anime: true,
              malId: interId,
              rootMalId,
            };
            // Only add to announced.jsonl, don't send Discord or add to entries list
            const announcedEntry = AnnouncedEntrySchema.parse({
              ...stubEntry,
              timestamp: new Date().toISOString(),
            });
            const line = JSON.stringify(announcedEntry) + "\n";
            const file = Bun.file("announced.jsonl");
            const existingContent = (await file.exists()) ? await file.text() : "";
            await Bun.write("announced.jsonl", existingContent + line);
          }
        }
      } catch (error) {
        console.error(`[ERROR] Failed to process MAL entry ${malEntry.anime_id}:`, error);
      }
    }

    // Update offset for next page
    offset += malEntries.length;
  }
}
