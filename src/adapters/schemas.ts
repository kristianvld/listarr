import { z } from "zod";

export const AnnouncedEntrySchema = z.object({
  tmdb: z.string().optional(),
  tvdb: z.string().optional(),
  title: z.string(),
  year: z.number().int().positive(),
  type: z.enum(["movie", "tv"]),
  source: z.enum(["letterboxd", "myanimelist"]),
  username: z.string(),
  anime: z.boolean(),
  timestamp: z.string(),
  malId: z.number().optional(), // Track MAL ID to prevent reprocessing
  rootMalId: z.number().optional(), // Track root MAL ID for intermediaries
  letterboxdSlug: z.string().optional(), // Track Letterboxd slug for deduplication
});

export type AnnouncedEntry = z.infer<typeof AnnouncedEntrySchema>;

export const IdsMoeResponseSchema = z
  .object({
    mal: z.number().nullable().optional(),
    anilist: z.number().nullable().optional(),
    kitsu: z.number().nullable().optional(),
    tmdb: z.number().nullable().optional(),
    imdb: z.string().nullable().optional(),
    trakt: z.number().nullable().optional(),
    trakt_type: z.string().nullable().optional(),
  })
  .loose(); // Allow additional fields we don't know about

export type IdsMoeResponse = z.infer<typeof IdsMoeResponseSchema>;

export const TraktIdsSchema = z
  .object({
    trakt: z.number().optional(),
    tvdb: z.number().optional(),
    tmdb: z.number().optional(),
    imdb: z.string().optional(),
    slug: z.string().optional(),
  })
  .loose();

export const TraktShowSchema = z
  .object({
    ids: TraktIdsSchema,
    title: z.string(),
    year: z.number().optional(),
  })
  .loose();

export const TraktMovieSchema = z
  .object({
    ids: TraktIdsSchema,
    title: z.string(),
    year: z.number().optional(),
  })
  .loose();

export const JikanAnimeSchema = z
  .object({
    mal_id: z.number(),
    title: z.string(),
    title_english: z.string().nullable(),
    type: z.string(), // "TV", "Movie", "OVA", "Special", etc.
    episodes: z.number().nullable(),
    images: z
      .object({
        jpg: z
          .object({
            image_url: z.string().nullable().optional(),
            small_image_url: z.string().nullable().optional(),
            large_image_url: z.string().nullable().optional(),
          })
          .optional(),
        webp: z
          .object({
            image_url: z.string().nullable().optional(),
            small_image_url: z.string().nullable().optional(),
            large_image_url: z.string().nullable().optional(),
          })
          .optional(),
      })
      .optional(),
    aired: z
      .object({
        from: z.string().nullable().optional(),
        to: z.string().nullable().optional(),
      })
      .optional(),
    synopsis: z.string().nullable().optional(),
    score: z.number().nullable().optional(),
    genres: z
      .array(
        z.object({
          name: z.string(),
        })
      )
      .optional(),
  })
  .loose();

export const JikanRelationSchema = z.object({
  relation: z.string(),
  entry: z.array(
    z.object({
      mal_id: z.number(),
      type: z.string(),
      name: z.string(),
    })
  ),
});

export const JikanRelationsResponseSchema = z.object({
  data: z.array(JikanRelationSchema),
});

export const MyAnimeListEntrySchema = z
  .object({
    status: z.number(),
    anime_id: z.number(),
    anime_title: z.union([z.string(), z.number()]).transform((val) => String(val)), // Convert to string
    anime_title_eng: z
      .union([z.string(), z.number()])
      .nullable()
      .transform((val) => (val === null ? null : String(val))),
    anime_start_date_string: z.string().nullable(),
    anime_end_date_string: z.string().nullable(),
    anime_media_type_string: z.string(),
  })
  .loose(); // Allow additional fields we don't know about

export type MyAnimeListEntry = z.infer<typeof MyAnimeListEntrySchema>;
