import type { Config } from "./config";
import { scrapeLetterboxdWatchlist } from "./adapters/letterboxd";
import { scrapeMyAnimeListWatchlist } from "./adapters/myanimelist";
import { AnnouncedEntrySchema, type AnnouncedEntry, type MediaEntry } from "./adapters/schemas";
import { httpClient, getDiscordRateLimitInfo } from "./utils";

// Use data directory if specified via env, otherwise default to current directory (for local development)
const DATA_DIR = process.env.DATA_DIR || ".";
const ANNOUNCED_FILE = `${DATA_DIR}/announced.jsonl`;

type AnnouncedSets = { byKey: Set<string>; byMalId: Set<number>; byRootMalId: Set<number> };

let allEntries: MediaEntry[] = [];

export function setAllEntries(entries: MediaEntry[]): void {
  allEntries = entries;
}

// Helper to generate a unique key for an entry
function getEntryKey(entry: { tmdb?: string; tvdb?: string; title: string; year: number; source: string; username: string }): string {
  return entry.tmdb ? `tmdb:${entry.tmdb}` : entry.tvdb ? `tvdb:${entry.tvdb}` : `${entry.title}:${entry.year}:${entry.source}:${entry.username}`;
}

// Helper to convert AnnouncedEntry to MediaEntry (adds runtime-only fields)
function announcedToMedia(entry: AnnouncedEntry): MediaEntry {
  return {
    ...entry,
    imageUrl: undefined, // Runtime-only, not persisted
    episodes: undefined, // Runtime-only, not persisted
  };
}

// Helper to parse NDJSON file
async function parseNdjsonFile<T>(filePath: string, parser: (obj: unknown) => T): Promise<T[]> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return [];
    }

    const content = await file.text();
    const results: T[] = [];

    for (const line of content.trim().split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = parser(JSON.parse(line));
        results.push(parsed);
      } catch (error) {
        console.warn("[ERROR] Failed to parse entry:", line, error);
      }
    }

    return results;
  } catch (error) {
    console.warn("[ERROR] Failed to load file:", filePath, error);
    return [];
  }
}

async function loadAnnouncedEntries(): Promise<AnnouncedSets> {
  const entries = await parseNdjsonFile(ANNOUNCED_FILE, (obj) => AnnouncedEntrySchema.parse(obj));

  const byKey = new Set<string>();
  const byMalId = new Set<number>();
  const byRootMalId = new Set<number>();

  for (const entry of entries) {
    byKey.add(getEntryKey(entry));
    if (entry.source === "letterboxd" && entry.letterboxdSlug) {
      byKey.add(`letterboxd:${entry.letterboxdSlug}:${entry.year}`);
    }
    if (entry.malId) byMalId.add(entry.malId);
    if (entry.rootMalId) byRootMalId.add(entry.rootMalId);
  }

  return { byKey, byMalId, byRootMalId };
}

async function appendAnnouncedEntry(entry: MediaEntry): Promise<void> {
  const announcedEntry: AnnouncedEntry = AnnouncedEntrySchema.parse({
    ...entry,
    timestamp: new Date().toISOString(),
  });

  const line = JSON.stringify(announcedEntry) + "\n";
  const file = Bun.file(ANNOUNCED_FILE);
  const existingContent = (await file.exists()) ? await file.text() : "";
  // Bun.write() automatically creates parent directories if they don't exist
  await Bun.write(ANNOUNCED_FILE, existingContent + line);
}

// Discord webhook constants
const DISCORD_USERNAME = "Listarr";
const DISCORD_AVATAR_URL = "https://raw.githubusercontent.com/kristianvld/listarr/refs/heads/main/assets/logo.png";

async function sendDiscordWebhook(webhookUrl: string, embed: Record<string, unknown>): Promise<void> {
  try {
    const response = await httpClient.post(webhookUrl, {
      json: {
        username: DISCORD_USERNAME,
        avatar_url: DISCORD_AVATAR_URL,
        embeds: [embed],
      },
    });

    // Log rate limit info if available
    const rateLimitInfo = getDiscordRateLimitInfo(response);
    if (rateLimitInfo) {
      if (rateLimitInfo.remaining !== undefined && rateLimitInfo.limit !== undefined) {
        const percentRemaining = (rateLimitInfo.remaining / rateLimitInfo.limit) * 100;
        if (percentRemaining < 20) {
          console.log(`[RATE LIMIT] Discord webhook: ${rateLimitInfo.remaining}/${rateLimitInfo.limit} requests remaining (${percentRemaining.toFixed(1)}%)`);
        }
      }
    }
  } catch (error) {
    // Check for rate limit info in error response
    const responseHeaders = (error as { response?: { status?: number; headers?: Headers } })?.response?.headers;
    const statusCode = (error as { response?: { status?: number } })?.response?.status;

    if (statusCode === 429 && responseHeaders) {
      const rateLimitInfo = getDiscordRateLimitInfo(responseHeaders as unknown as Response);
      if (rateLimitInfo?.resetAfter) {
        console.warn(`[RATE LIMIT] Discord webhook rate limited. Reset after: ${rateLimitInfo.resetAfter}s`);
      }
    }

    console.warn("[ERROR] Failed to send Discord webhook:", error);
  }
}

export async function sendDiscordErrorNotification(config: Config, title: string, description: string, error?: unknown): Promise<void> {
  if (!config.discordWebhook) return;

  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;

  const embed: Record<string, unknown> = {
    title: `⚠️ ${title}`,
    description,
    color: 0xff0000,
    timestamp: new Date().toISOString(),
  };

  if (errorMessage) {
    const fields: Array<{ name: string; value: string; inline: boolean }> = [
      {
        name: "Error Details",
        value: `\`\`\`${errorMessage.substring(0, 1000)}\`\`\``,
        inline: false,
      },
    ];
    if (errorStack && errorStack.length > 0) {
      fields.push({
        name: "Stack Trace",
        value: `\`\`\`${errorStack.substring(0, 500)}\`\`\``,
        inline: false,
      });
    }
    embed.fields = fields;
  }

  await sendDiscordWebhook(config.discordWebhook, embed);
}

async function sendDiscordNotification(entry: MediaEntry, config: Config): Promise<void> {
  if (!config.discordWebhook) return;

  const typeLabel = entry.type === "movie" ? (entry.anime ? "Anime Movie" : "Movie") : entry.anime ? "Anime Shows" : "Shows";

  const sourceLink = entry.source === "myanimelist" ? `[MAL [${entry.username}]](https://myanimelist.net/animelist/${entry.username}?status=6)` : `[Letterboxd [${entry.username}]](https://letterboxd.com/${entry.username}/watchlist/)`;

  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    { name: "Type", value: typeLabel, inline: true },
    { name: "Year", value: String(entry.year), inline: true },
  ];

  if (entry.type === "tv" && entry.episodes) {
    fields.push({ name: "Episodes", value: String(entry.episodes), inline: true });
  }

  fields.push({ name: "Source", value: sourceLink, inline: false });

  // Build ID links
  const idLinks: string[] = [];
  if (entry.source === "letterboxd" && entry.letterboxdSlug) {
    idLinks.push(`[Letterboxd](https://letterboxd.com/film/${entry.letterboxdSlug}/)`);
  }
  if (entry.malId || entry.rootMalId) {
    const malId = entry.rootMalId || entry.malId;
    if (malId) idLinks.push(`[MAL](https://myanimelist.net/anime/${malId})`);
  }
  if (entry.tvdb) {
    const tvdbType = entry.type === "tv" ? "series" : "movies";
    idLinks.push(`[TVDB](https://www.thetvdb.com/${tvdbType}/${entry.tvdb})`);
  }
  if (entry.tmdb) {
    const tmdbType = entry.type === "movie" ? "movie" : "tv";
    idLinks.push(`[TMDB](https://www.themoviedb.org/${tmdbType}/${entry.tmdb})`);
  }
  if (idLinks.length > 0) {
    fields.push({ name: "Links", value: idLinks.join(" - "), inline: false });
  }

  const embed: Record<string, unknown> = {
    title: entry.title,
    color: entry.anime ? 0x2e51a2 : 0x00e054,
    timestamp: new Date().toISOString(),
    fields,
  };

  const imageUrl = entry.imageUrl;
  if (imageUrl) {
    embed.image = { url: imageUrl };
    console.log(`Adding image to Discord embed: ${imageUrl}`);
  } else {
    console.warn(`No image URL for entry: ${entry.title} (source: ${entry.source})`);
  }

  await sendDiscordWebhook(config.discordWebhook, embed);
}

export async function loadAllEntries(): Promise<MediaEntry[]> {
  const entries = await parseNdjsonFile(ANNOUNCED_FILE, (obj) => AnnouncedEntrySchema.parse(obj));
  return entries.map(announcedToMedia).filter((e) => !e.title.startsWith("[Intermediary:"));
}

// Helper to process a single entry (save, notify, track)
async function processEntry(entry: MediaEntry, config: Config, announced: AnnouncedSets): Promise<void> {
  await appendAnnouncedEntry(entry);
  await sendDiscordNotification(entry, config);

  // Update announced sets for deduplication
  announced.byKey.add(getEntryKey(entry));
  if (entry.malId) announced.byMalId.add(entry.malId);
  if (entry.rootMalId) announced.byRootMalId.add(entry.rootMalId);
}

// Helper to scrape a source with error handling
async function scrapeSource(sourceName: string, usernames: string[], announced: AnnouncedSets, scraper: (username: string, announced: AnnouncedSets, onEntry: (entry: MediaEntry) => Promise<void>) => Promise<void>, config: Config, onEntryProcessed: (entry: MediaEntry) => Promise<void>): Promise<MediaEntry[]> {
  const entries: MediaEntry[] = [];

  for (const username of usernames) {
    try {
      console.log(`Starting ${sourceName} scrape for ${username}...`);
      await scraper(username, announced, async (entry) => {
        await processEntry(entry, config, announced);
        await onEntryProcessed(entry);
        entries.push(entry);
      });
      console.log(`✓ Completed ${sourceName} scrape for ${username}`);
    } catch (error) {
      console.error(`[ERROR] Failed to scrape ${sourceName} for ${username}:`, error);
      await sendDiscordErrorNotification(config, `Failed to Scrape ${sourceName}`, `Failed to scrape ${sourceName} watchlist for user **${username}**`, error);
    }
  }

  return entries;
}

export async function refreshData(config: Config): Promise<void> {
  console.log("Refreshing data...");
  const announced = await loadAnnouncedEntries();

  // Scrape sources sequentially to avoid overwhelming APIs (especially Jikan)
  // This prevents both scrapers from competing for rate limits
  const letterboxdEntries = await scrapeSource("Letterboxd", config.letterboxd, announced, scrapeLetterboxdWatchlist, config, async () => {});
  const malEntries = await scrapeSource("MyAnimeList", config.myanimelist, announced, scrapeMyAnimeListWatchlist, config, async () => {});

  // Merge new entries with existing entries (avoid duplicates)
  const newEntries = [...letterboxdEntries, ...malEntries];
  const existingKeys = new Set(allEntries.map(getEntryKey));

  for (const entry of newEntries) {
    const key = getEntryKey(entry);
    if (!existingKeys.has(key)) {
      allEntries.push(entry);
      existingKeys.add(key);
    }
  }

  console.log(`Total entries: ${allEntries.length}`);
}

function formatListEntry(entry: MediaEntry): Record<string, unknown> {
  const result: Record<string, unknown> = { title: entry.title, year: entry.year };
  if (entry.tmdb) result.tmdbId = entry.tmdb;
  if (entry.tvdb) result.tvdbId = entry.tvdb;
  return result;
}

// Helper to filter entries for endpoints
function filterEntries(type: "movie" | "tv", anime: boolean, requireId: "tmdb" | "tvdb"): MediaEntry[] {
  return allEntries.filter((e) => e.type === type && e.anime === anime && e[requireId] !== undefined && !e.title.startsWith("[Intermediary:"));
}

export function createServer(config: Config) {
  const server = Bun.serve({
    port: config.port,
    async fetch(req) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      // Radarr endpoints
      if (pathname === "/radarr/anime") {
        return new Response(JSON.stringify(filterEntries("movie", true, "tmdb").map(formatListEntry)), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (pathname === "/radarr/movies") {
        return new Response(JSON.stringify(filterEntries("movie", false, "tmdb").map(formatListEntry)), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Sonarr endpoints
      if (pathname === "/sonarr/anime") {
        return new Response(JSON.stringify(filterEntries("tv", true, "tvdb").map(formatListEntry)), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (pathname === "/sonarr/shows") {
        return new Response(JSON.stringify(filterEntries("tv", false, "tvdb").map(formatListEntry)), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  console.log(`Server running on http://localhost:${server.port}`);
  return server;
}
