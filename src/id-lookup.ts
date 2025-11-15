import { z } from "zod";
import { fetchJson } from "./utils";

// Schema for myanimelist_object.json entries
const MalIdEntrySchema = z
  .object({
    title: z.string(),
    themoviedb: z.number().nullable().optional(),
    thetvdb: z.number().nullable().optional(),
    imdb: z.string().nullable().optional(),
    trakt: z.number().nullable().optional(),
  })
  .loose();

// Schema for letterboxd_object.json entries
const LetterboxdIdEntrySchema = z
  .object({
    title: z.string(),
    themoviedb: z.number().nullable().optional(),
    thetvdb: z.number().nullable().optional(),
    myanimelist: z.number().nullable().optional(),
    anidb: z.number().nullable().optional(),
    anilist: z.number().nullable().optional(),
  })
  .loose();

type IdLookupResult = {
  tmdb?: string;
  tvdb?: string;
  isAnime?: boolean; // True if entry has MAL/AniDB/AniList ID
};

class IdLookupService {
  private malLookup: Map<number, IdLookupResult> = new Map();
  private letterboxdLookup: Map<string, IdLookupResult> = new Map();
  private loaded = false;
  private loadErrors: string[] = [];

  async load(): Promise<void> {
    if (this.loaded) return;

    console.log("Loading ID lookup databases...");

    // Load MAL lookup
    try {
      const malData = await fetchJson("https://raw.githubusercontent.com/nattadasu/animeApi/refs/heads/v3/database/myanimelist_object.json");
      const malEntries = z.record(z.string(), MalIdEntrySchema).parse(malData);

      for (const [malIdStr, entry] of Object.entries(malEntries)) {
        const malId = parseInt(malIdStr, 10);
        if (isNaN(malId)) continue;

        const result: IdLookupResult = {};
        if (entry.themoviedb) result.tmdb = entry.themoviedb.toString();
        if (entry.thetvdb) result.tvdb = entry.thetvdb.toString();

        if (result.tmdb || result.tvdb) {
          this.malLookup.set(malId, result);
        }
      }

      console.log(`Loaded ${this.malLookup.size} MAL ID mappings`);
    } catch (error) {
      const errorMsg = `Failed to load MAL ID lookup database: ${error}`;
      console.error(errorMsg);
      this.loadErrors.push(errorMsg);
    }

    // Load Letterboxd lookup
    try {
      const letterboxdData = await fetchJson("https://raw.githubusercontent.com/nattadasu/animeApi/refs/heads/v3/database/letterboxd_object.json");
      const letterboxdEntries = z.record(z.string(), LetterboxdIdEntrySchema).parse(letterboxdData);

      for (const [slug, entry] of Object.entries(letterboxdEntries)) {
        const result: IdLookupResult = {};
        if (entry.themoviedb) result.tmdb = entry.themoviedb.toString();
        if (entry.thetvdb) result.tvdb = entry.thetvdb.toString();

        // Check if it's anime (has MAL, AniDB, or AniList ID)
        result.isAnime = !!(entry.myanimelist || entry.anidb || entry.anilist);

        if (result.tmdb || result.tvdb || result.isAnime) {
          this.letterboxdLookup.set(slug, result);
        }
      }

      console.log(`Loaded ${this.letterboxdLookup.size} Letterboxd ID mappings`);
    } catch (error) {
      const errorMsg = `Failed to load Letterboxd ID lookup database: ${error}`;
      console.error(errorMsg);
      this.loadErrors.push(errorMsg);
    }

    this.loaded = true;

    if (this.loadErrors.length > 0) {
      console.warn(`ID lookup service loaded with ${this.loadErrors.length} error(s)`);
    } else {
      console.log("ID lookup service loaded successfully");
    }
  }

  getIdsFromMal(malId: number): IdLookupResult | null {
    return this.malLookup.get(malId) || null;
  }

  getIdsFromLetterboxd(slug: string): IdLookupResult | null {
    return this.letterboxdLookup.get(slug) || null;
  }

  getLoadErrors(): string[] {
    return [...this.loadErrors];
  }
}

// Singleton instance
export const idLookup = new IdLookupService();
