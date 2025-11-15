import { z } from "zod";
import { fetchJson } from "./utils";

const BaseIdEntrySchema = z
  .object({
    title: z.string(),
    themoviedb: z.number().nullable().optional(),
    thetvdb: z.number().nullable().optional(),
  })
  .loose();

const MalIdEntrySchema = BaseIdEntrySchema.extend({
  imdb: z.string().nullable().optional(),
  trakt: z.number().nullable().optional(),
});

const LetterboxdIdEntrySchema = BaseIdEntrySchema.extend({
  myanimelist: z.number().nullable().optional(),
  anidb: z.number().nullable().optional(),
  anilist: z.number().nullable().optional(),
});

type IdLookupResult = {
  tmdb?: string;
  tvdb?: string;
  isAnime?: boolean;
};

class IdLookupService {
  private malLookup = new Map<number, IdLookupResult>();
  private letterboxdLookup = new Map<string, IdLookupResult>();
  private loaded = false;
  private loadErrors: string[] = [];

  private buildResult(entry: { themoviedb?: number | null; thetvdb?: number | null }): IdLookupResult {
    const result: IdLookupResult = {};
    if (entry.themoviedb) result.tmdb = entry.themoviedb.toString();
    if (entry.thetvdb) result.tvdb = entry.thetvdb.toString();
    return result;
  }

  private async loadDatabase<T>(url: string, name: string, schema: z.ZodType<T>, processor: (entries: Record<string, T>) => void): Promise<void> {
    try {
      const data = await fetchJson(url);
      const entries = z.record(z.string(), schema).parse(data);
      processor(entries);
    } catch (error) {
      const errorMsg = `Failed to load ${name} ID lookup database: ${error}`;
      console.error(errorMsg);
      this.loadErrors.push(errorMsg);
    }
  }

  async load(): Promise<void> {
    if (this.loaded) return;

    console.log("Loading ID lookup databases...");

    await Promise.all([
      this.loadDatabase("https://raw.githubusercontent.com/nattadasu/animeApi/refs/heads/v3/database/myanimelist_object.json", "MAL", MalIdEntrySchema, (entries) => {
        for (const [malIdStr, entry] of Object.entries(entries)) {
          const malId = parseInt(malIdStr, 10);
          if (isNaN(malId)) continue;

          const result = this.buildResult(entry);
          if (result.tmdb || result.tvdb) {
            this.malLookup.set(malId, result);
          }
        }
        console.log(`Loaded ${this.malLookup.size} MAL ID mappings`);
      }),
      this.loadDatabase("https://raw.githubusercontent.com/nattadasu/animeApi/refs/heads/v3/database/letterboxd_object.json", "Letterboxd", LetterboxdIdEntrySchema, (entries) => {
        for (const [slug, entry] of Object.entries(entries)) {
          const result = this.buildResult(entry);
          result.isAnime = !!(entry.myanimelist || entry.anidb || entry.anilist);

          if (result.tmdb || result.tvdb || result.isAnime) {
            this.letterboxdLookup.set(slug, result);
          }
        }
        console.log(`Loaded ${this.letterboxdLookup.size} Letterboxd ID mappings`);
      }),
    ]);

    this.loaded = true;
    console.log(this.loadErrors.length > 0 ? `ID lookup service loaded with ${this.loadErrors.length} error(s)` : "ID lookup service loaded successfully");
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

export const idLookup = new IdLookupService();
