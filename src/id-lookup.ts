import { z } from "zod";
import { fetchJson } from "./utils";

const BaseIdEntrySchema = z
  .object({
    title: z.string(),
    themoviedb: z.number().nullable().optional(),
    thetvdb: z.number().nullable().optional(),
  })
  .loose();

const AnimeApiEntrySchema = BaseIdEntrySchema.extend({
  anidb: z.number().nullable().optional(),
  anilist: z.number().nullable().optional(),
  myanimelist: z.number().nullable().optional(),
  letterboxd_slug: z.string().nullable().optional(),
  letterboxd_lid: z.string().nullable().optional(),
  letterboxd_uid: z.number().nullable().optional(),
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

  private async loadDatabaseArray<T>(url: string, name: string, schema: z.ZodType<T>, processor: (entries: T[]) => void): Promise<void> {
    try {
      const data = await fetchJson(url);
      const entries = z.array(schema).parse(data);
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
      this.loadDatabaseArray("https://raw.githubusercontent.com/nattadasu/animeApi/refs/heads/v3/database/animeapi.json", "AnimeAPI master", AnimeApiEntrySchema, (entries) => {
        for (const entry of entries) {
          const result = this.buildResult(entry);

          if (entry.myanimelist !== null && entry.myanimelist !== undefined) {
            if (result.tmdb || result.tvdb) {
              this.malLookup.set(entry.myanimelist, result);
            }
          }

          const letterboxdKeys: string[] = [];
          if (entry.letterboxd_slug) letterboxdKeys.push(entry.letterboxd_slug);
          if (entry.letterboxd_lid) letterboxdKeys.push(entry.letterboxd_lid);
          if (entry.letterboxd_uid !== null && entry.letterboxd_uid !== undefined) {
            letterboxdKeys.push(entry.letterboxd_uid.toString());
          }

          if (letterboxdKeys.length > 0) {
            const letterboxdResult: IdLookupResult = {
              ...result,
              isAnime: !!(entry.myanimelist || entry.anidb || entry.anilist),
            };

            if (letterboxdResult.tmdb || letterboxdResult.tvdb || letterboxdResult.isAnime) {
              for (const key of letterboxdKeys) {
                this.letterboxdLookup.set(key, letterboxdResult);
              }
            }
          }
        }

        console.log(`Loaded ${this.malLookup.size} MAL ID mappings`);
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
