import type { Config } from "./config";
import { scrapeLetterboxdWatchlist } from "./adapters/letterboxd";
import { scrapeMyAnimeListWatchlist } from "./adapters/myanimelist";
import { AnnouncedEntrySchema, EntryLogEventSchema, RemovedEntrySchema, type EntryLogEvent, type MediaEntry } from "./adapters/schemas";
import {
  buildEntryIndex,
  createIntermediaryEntry,
  recordActiveAdd,
  recordHistoricalAdd,
  recordRemoval,
  type EntryIndex,
  type ScrapedWatchlist,
} from "./entry-state";
import { httpClient, getDiscordRateLimitInfo } from "./utils";

// Use data directory if specified via env, otherwise default to current directory (for local development)
const DATA_DIR = process.env.DATA_DIR || ".";
const ANNOUNCED_FILE = `${DATA_DIR}/announced.jsonl`;

type FailureState = {
  consecutiveFailures: number;
  firstFailureAt: number;
  lastFailureAt: number;
  lastNotifiedAt?: number;
};

type SourceScrapeResult = ScrapedWatchlist & {
  complete: boolean;
};

// Track which sources/users are currently failing (in-memory only, reset on restart)
const failingScrapes = new Map<string, FailureState>(); // Key: "source:username"

let allEntries: MediaEntry[] = [];

export function setAllEntries(entries: MediaEntry[]): void {
  allEntries = entries;
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

async function loadEntryIndex(): Promise<EntryIndex> {
  const events = await parseNdjsonFile(ANNOUNCED_FILE, (obj) => EntryLogEventSchema.parse(obj));
  return buildEntryIndex(events);
}

async function appendEntryLogEvent(event: EntryLogEvent): Promise<void> {
  const line = JSON.stringify(event) + "\n";
  const file = Bun.file(ANNOUNCED_FILE);
  const existingContent = (await file.exists()) ? await file.text() : "";
  // Bun.write() automatically creates parent directories if they don't exist
  await Bun.write(ANNOUNCED_FILE, existingContent + line);
}

async function appendAnnouncedEntry(entry: MediaEntry): Promise<void> {
  const announcedEntry = AnnouncedEntrySchema.parse({
    ...entry,
    event: "add",
    timestamp: new Date().toISOString(),
  });

  await appendEntryLogEvent(announcedEntry);
}

async function appendRemovedEntry(key: string, entry: MediaEntry): Promise<void> {
  const removedEntry = RemovedEntrySchema.parse({
    ...entry,
    event: "remove",
    key,
    reason: "absent_from_all_sources",
    timestamp: new Date().toISOString(),
  });

  await appendEntryLogEvent(removedEntry);
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
      try {
        const rateLimitInfo = getDiscordRateLimitInfo(responseHeaders);
        if (rateLimitInfo?.resetAfter) {
          console.warn(`[RATE LIMIT] Discord webhook rate limited. Reset after: ${rateLimitInfo.resetAfter}s`);
        }
      } catch (err) {
        // Headers might not be accessible
        console.warn(`[RATE LIMIT] Discord webhook rate limited (could not read rate limit headers)`);
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

async function sendDiscordRecoveryNotification(config: Config, sourceName: string, username: string, description?: string): Promise<void> {
  if (!config.discordWebhook) return;

  const embed: Record<string, unknown> = {
    title: `✅ ${sourceName} Scraping Recovered`,
    description: description || `Successfully scraped ${sourceName} watchlist for user **${username}** after previous failures.`,
    color: 0x00ff00, // Green for recovery
    timestamp: new Date().toISOString(),
  };

  await sendDiscordWebhook(config.discordWebhook, embed);
}

function getTypeLabel(entry: MediaEntry): string {
  return entry.type === "movie" ? (entry.anime ? "Anime Movie" : "Movie") : entry.anime ? "Anime Shows" : "Shows";
}

function getSourceLink(entry: MediaEntry): string {
  return entry.source === "myanimelist" ? `[MAL [${entry.username}]](https://myanimelist.net/animelist/${entry.username}?status=6)` : `[Letterboxd [${entry.username}]](https://letterboxd.com/${entry.username}/watchlist/)`;
}

function getIdLinks(entry: MediaEntry): string[] {
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

  return idLinks;
}

function getDiscordFields(entry: MediaEntry): Array<{ name: string; value: string; inline: boolean }> {
  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    { name: "Type", value: getTypeLabel(entry), inline: true },
    { name: "Year", value: String(entry.year), inline: true },
  ];

  if (entry.type === "tv" && entry.episodes) {
    fields.push({ name: "Episodes", value: String(entry.episodes), inline: true });
  }

  fields.push({ name: "Source", value: getSourceLink(entry), inline: false });

  const idLinks = getIdLinks(entry);
  if (idLinks.length > 0) {
    fields.push({ name: "Links", value: idLinks.join(" - "), inline: false });
  }

  return fields;
}

async function sendDiscordNotification(entry: MediaEntry, config: Config): Promise<void> {
  if (!config.discordWebhook) return;

  const embed: Record<string, unknown> = {
    title: entry.title,
    color: entry.anime ? 0x2e51a2 : 0x00e054,
    timestamp: new Date().toISOString(),
    fields: getDiscordFields(entry),
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

async function sendDiscordRemovalNotification(entry: MediaEntry, config: Config): Promise<void> {
  if (!config.discordWebhook) return;

  const embed: Record<string, unknown> = {
    title: `Removed from Listarr: ${entry.title}`,
    description: "No longer present in any monitored source list.",
    color: 0xff6b35,
    timestamp: new Date().toISOString(),
    fields: getDiscordFields(entry),
  };

  await sendDiscordWebhook(config.discordWebhook, embed);
}

export async function loadAllEntries(): Promise<MediaEntry[]> {
  const index = await loadEntryIndex();
  return [...index.activeByKey.values()].filter((e) => !e.title.startsWith("[Intermediary:"));
}

async function appendIntermediaryEntries(entry: MediaEntry, index: EntryIndex): Promise<void> {
  if (!entry.rootMalId || !entry.intermediaryMalIds) return;

  for (const malId of entry.intermediaryMalIds) {
    const stubEntry = createIntermediaryEntry(entry.username, malId, entry.rootMalId);
    await appendAnnouncedEntry(stubEntry);
    recordHistoricalAdd(index, stubEntry);
  }
}

async function processActiveAdd(entry: MediaEntry, config: Config, index: EntryIndex, notify: boolean): Promise<void> {
  await appendAnnouncedEntry(entry);
  recordActiveAdd(index, entry);
  await appendIntermediaryEntries(entry, index);

  if (notify) {
    await sendDiscordNotification(entry, config);
  }
}

async function processActiveRemoval(key: string, entry: MediaEntry, config: Config, index: EntryIndex): Promise<void> {
  await appendRemovedEntry(key, entry);
  recordRemoval(index, key);
  await sendDiscordRemovalNotification(entry, config);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function mergeSnapshot(target: ScrapedWatchlist, source: ScrapedWatchlist): void {
  for (const key of source.keys) {
    target.keys.add(key);
  }

  for (const [key, entry] of source.entriesByKey) {
    if (!target.entriesByKey.has(key)) {
      target.entriesByKey.set(key, entry);
    }
  }
}

// Helper to scrape a source with error handling
async function scrapeSource(
  sourceName: string,
  usernames: string[],
  index: EntryIndex,
  scraper: (username: string, index: EntryIndex) => Promise<ScrapedWatchlist>,
  config: Config,
): Promise<SourceScrapeResult> {
  const result: SourceScrapeResult = {
    keys: new Set(),
    entriesByKey: new Map(),
    complete: true,
  };

  for (const username of usernames) {
    const scrapeKey = `${sourceName.toLowerCase()}:${username}`;
    const failureState = failingScrapes.get(scrapeKey);
    const wasNotified = failureState?.lastNotifiedAt !== undefined;

    try {
      console.log(`Starting ${sourceName} scrape for ${username}...`);
      const snapshot = await scraper(username, index);
      mergeSnapshot(result, snapshot);
      console.log(`✓ Completed ${sourceName} scrape for ${username}`);

      if (failureState) {
        const durationMs = Date.now() - failureState.firstFailureAt;
        const duration = formatDuration(durationMs);
        const attempts = failureState.consecutiveFailures;
        failingScrapes.delete(scrapeKey);

        // If this scrape was previously notified, notify that it's working again
        if (wasNotified) {
          const description = `Successfully scraped ${sourceName} watchlist for user **${username}** after ${attempts} consecutive failure(s) over ${duration}.`;
          await sendDiscordRecoveryNotification(config, sourceName, username, description);
        }
      }
    } catch (error) {
      result.complete = false;
      console.error(`[ERROR] Failed to scrape ${sourceName} for ${username}:`, error);
      const now = Date.now();
      const threshold = config.failureNotificationThreshold;
      const repeatIntervalMs = config.failureNotificationRepeatIntervalSeconds * 1000;
      const nextFailureState: FailureState = failureState
        ? {
            ...failureState,
            consecutiveFailures: failureState.consecutiveFailures + 1,
            lastFailureAt: now,
          }
        : {
            consecutiveFailures: 1,
            firstFailureAt: now,
            lastFailureAt: now,
          };

      failingScrapes.set(scrapeKey, nextFailureState);

      const shouldNotifyInitial = nextFailureState.consecutiveFailures >= threshold && !nextFailureState.lastNotifiedAt;
      const shouldNotifyRepeat =
        nextFailureState.lastNotifiedAt !== undefined &&
        repeatIntervalMs > 0 &&
        now - nextFailureState.lastNotifiedAt >= repeatIntervalMs;

      if (shouldNotifyInitial || shouldNotifyRepeat) {
        const duration = formatDuration(now - nextFailureState.firstFailureAt);
        const attempts = nextFailureState.consecutiveFailures;
        const description = `Failed to scrape ${sourceName} watchlist for user **${username}**. This scraper has failed ${attempts} consecutive time(s) over ${duration}.`;
        await sendDiscordErrorNotification(config, `Failed to Scrape ${sourceName}`, description, error);
        nextFailureState.lastNotifiedAt = now;
        failingScrapes.set(scrapeKey, nextFailureState);
      } else if (nextFailureState.consecutiveFailures >= threshold) {
        console.log(`[WARN] Suppressing duplicate ${sourceName} failure notification for ${username}`);
      }
      // Continue with next username even if this one fails
    }
  }

  return result;
}

export async function refreshData(config: Config): Promise<void> {
  console.log("Refreshing data...");
  const index = await loadEntryIndex();

  // Scrape sources sequentially to avoid overwhelming APIs (especially Jikan)
  // This prevents both scrapers from competing for rate limits
  const letterboxdSnapshot = await scrapeSource(
    "Letterboxd",
    config.letterboxd,
    index,
    (username, entryIndex) => scrapeLetterboxdWatchlist(username, entryIndex, { flareSolverrUrl: config.flareSolverrUrl }),
    config,
  );
  const malSnapshot = await scrapeSource("MyAnimeList", config.myanimelist, index, scrapeMyAnimeListWatchlist, config);

  const currentSnapshot: ScrapedWatchlist = {
    keys: new Set(),
    entriesByKey: new Map(),
  };
  mergeSnapshot(currentSnapshot, letterboxdSnapshot);
  mergeSnapshot(currentSnapshot, malSnapshot);

  const activeByKey = new Map(index.activeByKey);
  let addedCount = 0;
  let restoredCount = 0;
  let removedCount = 0;

  for (const key of currentSnapshot.keys) {
    if (activeByKey.has(key)) {
      continue;
    }

    const entry = currentSnapshot.entriesByKey.get(key) ?? index.entriesByKey.get(key);
    if (!entry) {
      console.warn(`[WARN] Current item ${key} has no stored metadata; skipping add`);
      continue;
    }

    const wasSeenBefore = index.historicalKeys.has(key);
    await processActiveAdd(entry, config, index, !wasSeenBefore);
    activeByKey.set(key, entry);

    if (wasSeenBefore) {
      restoredCount++;
    } else {
      addedCount++;
    }
  }

  const canRemove = letterboxdSnapshot.complete && malSnapshot.complete;
  if (canRemove) {
    for (const [key, entry] of [...activeByKey]) {
      if (currentSnapshot.keys.has(key)) {
        continue;
      }

      await processActiveRemoval(key, entry, config, index);
      activeByKey.delete(key);
      removedCount++;
    }
  } else {
    console.log("[WARN] Skipping removals because one or more monitored source scrapes failed");
  }

  setAllEntries([...activeByKey.values()]);
  console.log(`Total active entries: ${allEntries.length} (${addedCount} added, ${restoredCount} restored, ${removedCount} removed)`);
}

function formatListEntrySonarr(entry: MediaEntry): Record<string, unknown> {
  return { title: entry.title, year: entry.year, tvdbId: entry.tvdb };
}

function formatListEntryRadarr(entry: MediaEntry): Record<string, unknown> {
  return { title: entry.title, year: entry.year, id: entry.tmdb };
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
        return new Response(JSON.stringify(filterEntries("movie", true, "tmdb").map(formatListEntryRadarr)), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (pathname === "/radarr/movies") {
        return new Response(JSON.stringify(filterEntries("movie", false, "tmdb").map(formatListEntryRadarr)), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Sonarr endpoints
      if (pathname === "/sonarr/anime") {
        return new Response(JSON.stringify(filterEntries("tv", true, "tvdb").map(formatListEntrySonarr)), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (pathname === "/sonarr/shows") {
        return new Response(JSON.stringify(filterEntries("tv", false, "tvdb").map(formatListEntrySonarr)), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  console.log(`Server running on http://localhost:${server.port}`);
  return server;
}
