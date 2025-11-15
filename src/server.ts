import type { Config } from "./config";
import type { MediaEntry } from "./adapters/types";
import { scrapeLetterboxdWatchlist } from "./adapters/letterboxd";
import { scrapeMyAnimeListWatchlist } from "./adapters/myanimelist";
import { AnnouncedEntrySchema, type AnnouncedEntry } from "./adapters/schemas";
import { httpClient } from "./utils";

// Use data directory if specified via env, otherwise current directory
const DATA_DIR = process.env.DATA_DIR || ".";
const ANNOUNCED_FILE = `${DATA_DIR}/announced.jsonl`;

let allEntries: MediaEntry[] = [];

export function setAllEntries(entries: MediaEntry[]): void {
  allEntries = entries;
}

async function loadAnnouncedEntries(): Promise<{ byKey: Set<string>; byMalId: Set<number>; byRootMalId: Set<number> }> {
  try {
    const file = Bun.file(ANNOUNCED_FILE);
    if (!(await file.exists())) {
      return { byKey: new Set(), byMalId: new Set(), byRootMalId: new Set() };
    }

    const content = await file.text();
    const byKey = new Set<string>();
    const byMalId = new Set<number>();
    const byRootMalId = new Set<number>();

    for (const line of content.trim().split("\n")) {
      if (!line.trim()) continue;
      try {
        const rawEntry = JSON.parse(line);
        const entry = AnnouncedEntrySchema.parse(rawEntry);
        // Create a unique key for deduplication
        const key = entry.tmdb ? `tmdb:${entry.tmdb}` : entry.tvdb ? `tvdb:${entry.tvdb}` : `${entry.title}:${entry.year}:${entry.source}:${entry.username}`;
        byKey.add(key);

        // Also add slug-based key for Letterboxd entries
        if (entry.source === "letterboxd" && entry.letterboxdSlug) {
          const slugKey = `letterboxd:${entry.letterboxdSlug}:${entry.year}`;
          byKey.add(slugKey);
        }

        if (entry.malId) byMalId.add(entry.malId);
        if (entry.rootMalId) byRootMalId.add(entry.rootMalId);
      } catch (error) {
        console.warn("[ERROR] Failed to parse announced entry:", line, error);
      }
    }

    return { byKey, byMalId, byRootMalId };
  } catch (error) {
    console.warn("[ERROR] Failed to load announced entries:", error);
    return { byKey: new Set(), byMalId: new Set(), byRootMalId: new Set() };
  }
}

async function appendAnnouncedEntry(entry: MediaEntry): Promise<void> {
  const announcedEntry: AnnouncedEntry = AnnouncedEntrySchema.parse({
    ...entry,
    timestamp: new Date().toISOString(),
  });

  const line = JSON.stringify(announcedEntry) + "\n";
  const file = Bun.file(ANNOUNCED_FILE);
  const existingContent = (await file.exists()) ? await file.text() : "";
  await Bun.write(ANNOUNCED_FILE, existingContent + line);
}

export async function sendDiscordErrorNotification(config: Config, title: string, description: string, error?: unknown): Promise<void> {
  if (!config.discordWebhook) return;

  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;

  const embed: {
    title: string;
    description: string;
    color: number;
    timestamp: string;
    fields?: Array<{ name: string; value: string; inline: boolean }>;
  } = {
    title: `⚠️ ${title}`,
    description: description,
    color: 0xff0000, // Red for errors
    timestamp: new Date().toISOString(),
  };

  if (errorMessage) {
    embed.fields = [
      {
        name: "Error Details",
        value: `\`\`\`${errorMessage.substring(0, 1000)}\`\`\``,
        inline: false,
      },
    ];
    if (errorStack && errorStack.length > 0) {
      embed.fields.push({
        name: "Stack Trace",
        value: `\`\`\`${errorStack.substring(0, 500)}\`\`\``,
        inline: false,
      });
    }
  }

  const message = {
    username: "Listarr",
    avatar_url: "https://raw.githubusercontent.com/kristianvld/listarr/refs/heads/main/assets/logo.png",
    embeds: [embed],
  };

  try {
    await httpClient.post(config.discordWebhook, {
      json: message,
    });
  } catch (err) {
    // Don't log Discord errors for error notifications to avoid infinite loops
    console.warn("[ERROR] Failed to send Discord error notification:", err);
  }
}

async function sendDiscordNotification(entry: MediaEntry, config: Config, imageUrl?: string): Promise<void> {
  if (!config.discordWebhook) return;

  // Type classification: Movie, Anime Movie, Shows, Anime Shows
  let typeLabel: string;
  if (entry.type === "movie") {
    typeLabel = entry.anime ? "Anime Movie" : "Movie";
  } else {
    typeLabel = entry.anime ? "Anime Shows" : "Shows";
  }

  // Source as clickable link to watchlist
  let sourceLink: string;
  if (entry.source === "myanimelist") {
    sourceLink = `[MAL [${entry.username}]](https://myanimelist.net/animelist/${entry.username}?status=6)`;
  } else {
    sourceLink = `[Letterboxd [${entry.username}]](https://letterboxd.com/${entry.username}/watchlist/)`;
  }

  // Build fields array
  const fields: Array<{ name: string; value: string; inline: boolean }> = [];

  fields.push({
    name: "Type",
    value: typeLabel,
    inline: true,
  });

  fields.push({
    name: "Year",
    value: String(entry.year),
    inline: true,
  });

  // Episodes (for TV shows)
  if (entry.type === "tv" && entry.episodes) {
    fields.push({
      name: "Episodes",
      value: String(entry.episodes),
      inline: true,
    });
  }

  fields.push({
    name: "Source",
    value: sourceLink,
    inline: false,
  });

  // Add ID links
  const idLinks: string[] = [];

  // Add Letterboxd link for Letterboxd entries
  if (entry.source === "letterboxd" && entry.letterboxdSlug) {
    idLinks.push(`[Letterboxd](https://letterboxd.com/film/${entry.letterboxdSlug}/)`);
  }

  if (entry.malId || entry.rootMalId) {
    const malId = entry.rootMalId || entry.malId;
    if (malId) {
      idLinks.push(`[MAL](https://myanimelist.net/anime/${malId})`);
    }
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
    fields.push({
      name: "Links",
      value: idLinks.join(" - "),
      inline: false,
    });
  }

  const embed: {
    title: string;
    color: number;
    timestamp: string;
    fields: Array<{ name: string; value: string; inline: boolean }>;
    image?: { url: string };
  } = {
    title: entry.title,
    color: entry.anime ? 0x2e51a2 : 0x00e054, // MAL blue for anime, Letterboxd green for movies
    timestamp: new Date().toISOString(),
    fields: fields,
  };

  // Add image if available (from entry.imageUrl or passed parameter)
  const finalImageUrl = imageUrl || entry.imageUrl;
  if (finalImageUrl) {
    embed.image = { url: finalImageUrl };
    console.log(`Adding image to Discord embed: ${finalImageUrl}`);
  } else {
    console.warn(`No image URL for entry: ${entry.title} (source: ${entry.source})`);
  }

  const message = {
    username: "Listarr",
    avatar_url: "https://raw.githubusercontent.com/kristianvld/listarr/refs/heads/main/assets/logo.png",
    embeds: [embed],
  };

  try {
    await httpClient.post(config.discordWebhook, {
      json: message,
    });
  } catch (error) {
    console.warn("[ERROR] Failed to send Discord notification:", error);
  }
}

export async function loadAllEntries(): Promise<MediaEntry[]> {
  try {
    const file = Bun.file(ANNOUNCED_FILE);
    if (!(await file.exists())) {
      return [];
    }

    const content = await file.text();
    const entries: MediaEntry[] = [];

    for (const line of content.trim().split("\n")) {
      if (!line.trim()) continue;
      try {
        const rawEntry = JSON.parse(line);
        const entry = AnnouncedEntrySchema.parse(rawEntry);

        // Convert AnnouncedEntry to MediaEntry
        const mediaEntry: MediaEntry = {
          tmdb: entry.tmdb,
          tvdb: entry.tvdb,
          title: entry.title,
          year: entry.year,
          type: entry.type,
          source: entry.source,
          username: entry.username,
          anime: entry.anime,
          malId: entry.malId,
          rootMalId: entry.rootMalId,
          letterboxdSlug: entry.letterboxdSlug,
        };

        // Skip intermediary entries
        if (!mediaEntry.title.startsWith("[Intermediary:")) {
          entries.push(mediaEntry);
        }
      } catch (error) {
        console.warn("[ERROR] Failed to parse announced entry:", line, error);
      }
    }

    return entries;
  } catch (error) {
    console.warn("[ERROR] Failed to load all entries:", error);
    return [];
  }
}

export async function refreshData(config: Config): Promise<void> {
  console.log("Refreshing data...");
  const entries: MediaEntry[] = [];
  const announced = await loadAnnouncedEntries();

  // Scrape Letterboxd - processes entries incrementally
  for (const username of config.letterboxd) {
    try {
      console.log(`Starting Letterboxd scrape for ${username}...`);
      await scrapeLetterboxdWatchlist(username, announced, async (entry: MediaEntry) => {
        // Add to announced.jsonl immediately
        await appendAnnouncedEntry(entry);
        // Send Discord notification
        await sendDiscordNotification(entry, config);
        // Add to in-memory list
        entries.push(entry);
      });
      console.log(`✓ Completed Letterboxd scrape for ${username}`);
    } catch (error) {
      console.error(`[ERROR] Failed to scrape Letterboxd for ${username}:`, error);
      await sendDiscordErrorNotification(config, "Failed to Scrape Letterboxd", `Failed to scrape Letterboxd watchlist for user **${username}**`, error);
      // Continue with next username even if this one fails
    }
  }

  // Scrape MyAnimeList - processes entries incrementally
  for (const username of config.myanimelist) {
    try {
      console.log(`Starting MyAnimeList scrape for ${username}...`);
      await scrapeMyAnimeListWatchlist(username, announced, async (entry: MediaEntry) => {
        // Add to announced.jsonl immediately
        await appendAnnouncedEntry(entry);
        // Send Discord notification
        await sendDiscordNotification(entry, config);
        // Add to in-memory list
        entries.push(entry);
        // Update announced sets
        const key = entry.tmdb ? `tmdb:${entry.tmdb}` : entry.tvdb ? `tvdb:${entry.tvdb}` : `${entry.title}:${entry.year}:${entry.source}:${entry.username}`;
        announced.byKey.add(key);
        if (entry.malId) announced.byMalId.add(entry.malId);
        if (entry.rootMalId) announced.byRootMalId.add(entry.rootMalId);
      });
      console.log(`✓ Completed MyAnimeList scrape for ${username}`);
    } catch (error) {
      console.error(`[ERROR] Failed to scrape MyAnimeList for ${username}:`, error);
      await sendDiscordErrorNotification(config, "Failed to Scrape MyAnimeList", `Failed to scrape MyAnimeList watchlist for user **${username}**`, error);
      // Continue with next username even if this one fails
    }
  }

  // Merge new entries with existing entries (avoid duplicates)
  const existingKeys = new Set(
    allEntries.map((e) => {
      const key = e.tmdb ? `tmdb:${e.tmdb}` : e.tvdb ? `tvdb:${e.tvdb}` : `${e.title}:${e.year}:${e.source}:${e.username}`;
      return key;
    })
  );

  for (const entry of entries) {
    const key = entry.tmdb ? `tmdb:${entry.tmdb}` : entry.tvdb ? `tvdb:${entry.tvdb}` : `${entry.title}:${entry.year}:${entry.source}:${entry.username}`;
    if (!existingKeys.has(key)) {
      allEntries.push(entry);
      existingKeys.add(key);
    }
  }

  console.log(`Total entries: ${allEntries.length}`);
}

function formatListEntry(entry: MediaEntry): Record<string, unknown> {
  const result: Record<string, unknown> = {
    title: entry.title,
    year: entry.year,
  };

  if (entry.tmdb) {
    result.tmdbId = entry.tmdb;
  }

  if (entry.tvdb) {
    result.tvdbId = entry.tvdb;
  }

  return result;
}

export function createServer(config: Config) {
  const server = Bun.serve({
    port: config.port,
    async fetch(req) {
      const url = new URL(req.url);

      // Radarr endpoints
      if (url.pathname === "/radarr/anime") {
        const animeMovies = allEntries.filter((e) => e.type === "movie" && e.anime && e.tmdb && !e.title.startsWith("[Intermediary:"));
        return new Response(JSON.stringify(animeMovies.map(formatListEntry)), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/radarr/movies") {
        const nonAnimeMovies = allEntries.filter((e) => e.type === "movie" && !e.anime && e.tmdb && !e.title.startsWith("[Intermediary:"));
        return new Response(JSON.stringify(nonAnimeMovies.map(formatListEntry)), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Sonarr endpoints
      if (url.pathname === "/sonarr/anime") {
        const animeShows = allEntries.filter((e) => e.type === "tv" && e.anime && e.tvdb && !e.title.startsWith("[Intermediary:"));
        return new Response(JSON.stringify(animeShows.map(formatListEntry)), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/sonarr/shows") {
        const nonAnimeShows = allEntries.filter((e) => e.type === "tv" && !e.anime && e.tvdb && !e.title.startsWith("[Intermediary:"));
        return new Response(JSON.stringify(nonAnimeShows.map(formatListEntry)), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  console.log(`Server running on http://localhost:${server.port}`);
  return server;
}
