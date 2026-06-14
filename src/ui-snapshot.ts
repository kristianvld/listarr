import { EntryLogEventSchema, type EntryLogEvent, type MediaEntry } from "./adapters/schemas";
import { buildEntryIndex, getEntryKey } from "./entry-state";

const DATA_DIR = process.env.DATA_DIR || ".";
const ANNOUNCED_FILE = `${DATA_DIR}/announced.jsonl`;
const MAL_META_CACHE_FILE = `${DATA_DIR}/ui-mal-cache.json`;
const POSTER_CACHE_FILE = `${DATA_DIR}/ui-poster-cache.json`;
const POSTER_FETCH_TIMEOUT_MS = Number.parseInt(process.env.LISTARR_POSTER_FETCH_TIMEOUT_MS ?? "2500", 10);
const POSTER_HYDRATE_LIMIT = Number.parseInt(process.env.LISTARR_POSTER_HYDRATE_LIMIT ?? "4", 10);
const POSTER_HYDRATE_CONCURRENCY = 4;
const POSTER_FAILURE_RETRY_MS = 12 * 60 * 60 * 1000;

type ExternalId = {
  href: string;
  service: "letterboxd" | "myanimelist" | "tmdb" | "tvdb";
};

type UiTimelineEvent = {
  at: string;
  code?: string;
  detail?: string;
  href: string;
  kind: "add" | "remove";
  label: string;
  service: "letterboxd" | "listarr" | "myanimelist";
  user: string;
};

type UiRelatedItem = {
  href?: string;
  id: string;
  imageUrl?: string;
  reason: string;
  state: "active" | "linked" | "removed";
  title: string;
  type: string;
  year: number;
};

type UiLineage = {
  reason: string;
  sourceCode: string;
  sourceHref: string;
  sourceTitle: string;
  targetCode: string;
  targetHref: string;
  targetTitle: string;
};

export type UiItem = {
  anime: boolean;
  endpoint: string;
  externalIds: ExternalId[];
  firstAddedAt: string;
  id: string;
  imageUrl?: string;
  kind: string;
  lastSeenAt: string;
  lineage?: UiLineage;
  mediaType: "movie" | "tv";
  related: UiRelatedItem[];
  sourceSummary: string;
  sources: string[];
  status: "active" | "removed";
  statusDetail: string;
  timeline: UiTimelineEvent[];
  title: string;
  year: number;
};

export type UiSnapshot = {
  generatedAt: string;
  items: UiItem[];
  sourceMode: "event-log" | "live-refresh";
  stats: {
    active: number;
    all: number;
    anime: number;
    movies: number;
    multiSource: number;
    removed: number;
  };
};

type ItemAccumulator = {
  entries: MediaEntry[];
  events: UiTimelineEvent[];
  firstAddedAt?: string;
  id: string;
  lastSeenAt?: string;
  removedAt?: string;
};

type PosterCacheEntry = {
  failedAt?: string;
  source?: string;
  url?: string;
};

type PosterCache = Record<string, PosterCacheEntry>;

type MalMetaCacheEntry = {
  failedAt?: string;
  imageUrl?: string;
  title?: string;
  type?: string;
  year?: number;
};

type MalMetaCache = Record<string, MalMetaCacheEntry>;

async function parseEvents(filePath: string): Promise<EntryLogEvent[]> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return [];

  const events: EntryLogEvent[] = [];
  const content = await file.text();

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(EntryLogEventSchema.parse(JSON.parse(line)));
    } catch (error) {
      console.warn("[WARN] Failed to parse UI snapshot event:", error);
    }
  }

  return events;
}

async function readPosterCache(): Promise<PosterCache> {
  try {
    const file = Bun.file(POSTER_CACHE_FILE);
    if (!(await file.exists())) return {};
    const parsed = JSON.parse(await file.text());
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as PosterCache;
  } catch (error) {
    console.warn("[WARN] Failed to read UI poster cache:", error);
    return {};
  }
}

async function writePosterCache(cache: PosterCache): Promise<void> {
  await Bun.write(POSTER_CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function readMalMetaCache(): Promise<MalMetaCache> {
  try {
    const file = Bun.file(MAL_META_CACHE_FILE);
    if (!(await file.exists())) return {};
    const parsed = JSON.parse(await file.text());
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as MalMetaCache;
  } catch (error) {
    console.warn("[WARN] Failed to read UI MAL metadata cache:", error);
    return {};
  }
}

async function writeMalMetaCache(cache: MalMetaCache): Promise<void> {
  await Bun.write(MAL_META_CACHE_FILE, JSON.stringify(cache, null, 2));
}

function malHref(malId: number): string {
  return `https://myanimelist.net/anime/${malId}`;
}

function malCode(malId: number): string {
  return `mal:${malId}`;
}

function targetMalId(entry: MediaEntry): number | undefined {
  return entry.rootMalId ?? entry.malId;
}

function malMetaTitle(cache: MalMetaCache, malId: number | undefined, fallback: string): string {
  if (!malId) return fallback;
  return cache[String(malId)]?.title ?? fallback;
}

function lineageFor(entry: MediaEntry, malMeta: MalMetaCache): UiLineage | undefined {
  if (entry.source !== "myanimelist" || !entry.malId || !entry.rootMalId || entry.malId === entry.rootMalId) {
    return undefined;
  }

  return {
    reason: "MAL relation tracing",
    sourceCode: malCode(entry.malId),
    sourceHref: malHref(entry.malId),
    sourceTitle: malMetaTitle(malMeta, entry.malId, `MAL ${entry.malId}`),
    targetCode: malCode(entry.rootMalId),
    targetHref: malHref(entry.rootMalId),
    targetTitle: malMetaTitle(malMeta, entry.rootMalId, entry.title),
  };
}

function malTypeLabel(type: unknown): string {
  return typeof type === "string" && type.trim() ? `MAL ${type.trim()}` : "MAL entry";
}

function readJikanImage(data: Record<string, unknown>): string | undefined {
  const images = data.images as { jpg?: Record<string, string | null | undefined>; webp?: Record<string, string | null | undefined> } | undefined;
  return (
    images?.jpg?.large_image_url ??
    images?.jpg?.image_url ??
    images?.webp?.large_image_url ??
    images?.webp?.image_url ??
    undefined
  );
}

function readJikanYear(data: Record<string, unknown>): number | undefined {
  const aired = data.aired as { from?: string | null } | undefined;
  if (!aired?.from) return undefined;
  const date = new Date(aired.from);
  return Number.isNaN(date.getTime()) ? undefined : date.getFullYear();
}

async function fetchMalMeta(malId: number): Promise<MalMetaCacheEntry | undefined> {
  try {
    const response = await fetch(`https://api.jikan.moe/v4/anime/${malId}`, {
      headers: {
        "User-Agent": "Listarr UI snapshot MAL metadata lookup",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return undefined;
    const json = (await response.json()) as { data?: Record<string, unknown> };
    const data = json.data;
    if (!data) return undefined;

    const titleEnglish = typeof data.title_english === "string" && data.title_english.trim() ? data.title_english.trim() : undefined;
    const title = titleEnglish ?? (typeof data.title === "string" ? data.title : undefined);
    if (!title) return undefined;

    return {
      imageUrl: readJikanImage(data),
      title,
      type: malTypeLabel(data.type),
      year: readJikanYear(data),
    };
  } catch {
    return undefined;
  }
}

async function hydrateMalMeta(events: EntryLogEvent[]): Promise<MalMetaCache> {
  const cache = await readMalMetaCache();
  const requiredIds = new Set<number>();

  for (const event of events) {
    if (event.event !== "add" || event.source !== "myanimelist" || !event.malId || !event.rootMalId || event.malId === event.rootMalId) {
      continue;
    }
    requiredIds.add(event.malId);
    requiredIds.add(event.rootMalId);
  }

  let dirty = false;
  for (const malId of requiredIds) {
    const key = String(malId);
    if (cache[key]?.title) continue;

    const meta = await fetchMalMeta(malId);
    cache[key] = meta ?? { failedAt: new Date().toISOString() };
    dirty = true;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  if (dirty) await writeMalMetaCache(cache);
  return cache;
}

function posterCacheKey(id: string, entry: MediaEntry): string {
  const malId = targetMalId(entry);
  if (malId) return `mal:${malId}`;
  if (entry.tmdb) return `tmdb:${entry.type}:${entry.tmdb}`;
  if (entry.letterboxdSlug) return `letterboxd:${entry.letterboxdSlug}`;
  return id;
}

function posterPageUrl(entry: MediaEntry): string | undefined {
  const malId = targetMalId(entry);
  if (entry.anime && malId) {
    return malHref(malId);
  }

  if (entry.tmdb) {
    return `https://www.themoviedb.org/${entry.type === "movie" ? "movie" : "tv"}/${entry.tmdb}`;
  }

  if (entry.letterboxdSlug) {
    return `https://letterboxd.com/film/${entry.letterboxdSlug}/`;
  }

  if (malId) {
    return malHref(malId);
  }

  return undefined;
}

function extractMetaImage(html: string): string | undefined {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];

  for (const tag of metaTags) {
    const isImageTag = /(?:property|name)=["'](?:og:image|twitter:image(?::src)?)["']/i.test(tag);
    if (!isImageTag) continue;

    const contentMatch = tag.match(/\bcontent=["']([^"']+)["']/i);
    if (contentMatch?.[1]) return contentMatch[1].replace(/&amp;/g, "&");
  }

  return undefined;
}

async function fetchPosterUrl(entry: MediaEntry): Promise<string | undefined> {
  const url = posterPageUrl(entry);
  if (!url) return undefined;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Listarr UI snapshot poster lookup",
      },
      signal: AbortSignal.timeout(POSTER_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    return extractMetaImage(await response.text());
  } catch {
    return undefined;
  }
}

async function mapWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      if (item !== undefined) await worker(item);
    }
  });

  await Promise.all(workers);
}

async function hydratePosterUrls(items: UiItem[], rawById: Map<string, MediaEntry>): Promise<UiItem[]> {
  const cache = await readPosterCache();
  let dirty = false;

  const missing: Array<{ item: UiItem; key: string; raw: MediaEntry }> = [];
  const hydrated = items.map((item) => {
    const raw = rawById.get(item.id);
    if (!raw) return item;
    if (item.imageUrl) return item;

    const key = posterCacheKey(item.id, raw);
    const cached = cache[key];
    if (cached?.url) return { ...item, imageUrl: cached.url };
    const failedAt = cached?.failedAt ? new Date(cached.failedAt).getTime() : undefined;
    const shouldRetryFailure = failedAt === undefined || Number.isNaN(failedAt) || Date.now() - failedAt > POSTER_FAILURE_RETRY_MS;
    if (shouldRetryFailure) missing.push({ item, key, raw });
    return item;
  });

  const limit = Number.isFinite(POSTER_HYDRATE_LIMIT) ? Math.max(0, POSTER_HYDRATE_LIMIT) : 120;
  const nextMissing = missing.slice(0, limit);

  await mapWithConcurrency(nextMissing, POSTER_HYDRATE_CONCURRENCY, async ({ key, raw }) => {
    const url = await fetchPosterUrl(raw);
    cache[key] = url
      ? { source: posterPageUrl(raw), url }
      : {
          failedAt: new Date().toISOString(),
          source: posterPageUrl(raw),
        };
    dirty = true;
  });

  if (dirty) await writePosterCache(cache);

  return hydrated.map((item) => {
    if (item.imageUrl) return item;
    const raw = rawById.get(item.id);
    if (!raw) return item;
    const cached = cache[posterCacheKey(item.id, raw)];
    return cached?.url ? { ...item, imageUrl: cached.url } : item;
  });
}

function endpointFor(entry: MediaEntry): string {
  if (entry.type === "movie") return entry.anime ? "/radarr/anime" : "/radarr/movies";
  return entry.anime ? "/sonarr/anime" : "/sonarr/shows";
}

function kindFor(entry: MediaEntry): string {
  if (entry.type === "movie") return entry.anime ? "Anime movie" : "Movie";
  return entry.anime ? "Anime series" : "Series";
}

function sourceLabel(source: MediaEntry["source"]): "letterboxd" | "myanimelist" {
  return source;
}

function sourceDisplay(source: MediaEntry["source"]): string {
  return source === "myanimelist" ? "MyAnimeList" : "Letterboxd";
}

function sourceHref(entry: MediaEntry): string {
  if (entry.source === "letterboxd") {
    return entry.letterboxdSlug ? `https://letterboxd.com/film/${entry.letterboxdSlug}/` : `https://letterboxd.com/${entry.username}/watchlist/`;
  }

  if (entry.malId) return malHref(entry.malId);
  if (entry.rootMalId) return malHref(entry.rootMalId);

  return `https://myanimelist.net/animelist/${entry.username}?status=6`;
}

function sourceCode(entry: MediaEntry): string | undefined {
  if (entry.source === "letterboxd" && entry.letterboxdSlug) return `letterboxd:${entry.letterboxdSlug}`;
  if (entry.malId && entry.rootMalId && entry.malId !== entry.rootMalId) return `${malCode(entry.malId)} → ${malCode(entry.rootMalId)}`;
  if (entry.malId) return `mal:${entry.malId}`;
  return undefined;
}

function addTimelineEvent(entry: MediaEntry, timestamp: string, malMeta: MalMetaCache): UiTimelineEvent {
  const lineage = lineageFor(entry, malMeta);

  return {
    at: timestamp,
    code: sourceCode(entry),
    detail: lineage ? `Added item: ${lineage.targetTitle}` : undefined,
    href: sourceHref(entry),
    kind: "add",
    label: lineage ? `Watchlist item: ${lineage.sourceTitle}` : entry.source === "myanimelist" ? "Plan to Watch" : "Watchlist",
    service: sourceLabel(entry.source),
    user: entry.username,
  };
}

function removeTimelineEvent(entry: MediaEntry, timestamp: string, reason: string): UiTimelineEvent {
  return {
    at: timestamp,
    detail: reason === "absent_from_all_sources" ? "Missing from all source lists" : undefined,
    href: "#",
    kind: "remove",
    label: "Removed",
    service: "listarr",
    user: "announced.jsonl",
  };
}

function externalIdsFor(entry: MediaEntry): ExternalId[] {
  const ids: ExternalId[] = [];
  const malId = targetMalId(entry);

  if (entry.source === "letterboxd" && entry.letterboxdSlug) {
    ids.push({ service: "letterboxd", href: `https://letterboxd.com/film/${entry.letterboxdSlug}/` });
  }
  if (malId) {
    ids.push({ service: "myanimelist", href: malHref(malId) });
  }
  if (entry.tmdb) {
    ids.push({ service: "tmdb", href: `https://www.themoviedb.org/${entry.type === "movie" ? "movie" : "tv"}/${entry.tmdb}` });
  }
  if (entry.tvdb) {
    ids.push({ service: "tvdb", href: `https://thetvdb.com/${entry.type === "movie" ? "movies" : "series"}/${entry.tvdb}` });
  }

  return ids;
}

function mergeEntry(existing: MediaEntry | undefined, next: MediaEntry): MediaEntry {
  if (!existing) return next;
  return {
    ...existing,
    ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)),
  } as MediaEntry;
}

function sortEvents(events: UiTimelineEvent[]): UiTimelineEvent[] {
  return [...events].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

function buildRelatedItems(items: UiItem[], rawById: Map<string, MediaEntry>, malMeta: MalMetaCache): UiItem[] {
  const byRootMal = new Map<number, UiItem[]>();

  for (const item of items) {
    const raw = rawById.get(item.id);
    const rootMalId = raw ? targetMalId(raw) : undefined;
    if (rootMalId) {
      const related = byRootMal.get(rootMalId) ?? [];
      related.push(item);
      byRootMal.set(rootMalId, related);
    }
  }

  return items.map((item) => {
    const raw = rawById.get(item.id);
    const related = new Map<string, UiRelatedItem>();
    const lineage = raw ? lineageFor(raw, malMeta) : undefined;

    if (raw?.malId && lineage) {
      const sourceMeta = malMeta[String(raw.malId)];
      related.set(`mal-source:${raw.malId}`, {
        href: lineage.sourceHref,
        id: `mal-source:${raw.malId}`,
        imageUrl: sourceMeta?.imageUrl,
        reason: `watchlist item linked to ${lineage.targetTitle}`,
        state: "linked",
        title: lineage.sourceTitle,
        type: sourceMeta?.type ?? "MAL entry",
        year: sourceMeta?.year ?? raw.year,
      });
    }

    const rootMalId = raw ? targetMalId(raw) : undefined;
    if (rootMalId) {
      for (const candidate of byRootMal.get(rootMalId) ?? []) {
        if (candidate.id === item.id) continue;
        related.set(candidate.id, {
          id: candidate.id,
          imageUrl: candidate.imageUrl,
          reason: "MAL lineage",
          state: candidate.status,
          title: candidate.title,
          type: candidate.kind,
          year: candidate.year,
        });
      }
    }

    return { ...item, related: [...related.values()].slice(0, 4) };
  });
}

export async function loadUiSnapshot(): Promise<UiSnapshot> {
  const events = await parseEvents(ANNOUNCED_FILE);
  const malMeta = await hydrateMalMeta(events);
  const index = buildEntryIndex(events);
  const accumulators = new Map<string, ItemAccumulator>();
  const rawById = new Map<string, MediaEntry>();

  for (const event of events) {
    if (event.title.startsWith("[Intermediary:")) continue;

    const id = event.event === "add" ? getEntryKey(event) : event.key;
    const accumulator =
      accumulators.get(id) ??
      ({
        entries: [],
        events: [],
        id,
      } satisfies ItemAccumulator);

    if (event.event === "add") {
      const { event: _event, timestamp: _timestamp, ...mediaEntry } = event;
      const merged = mergeEntry(rawById.get(id), mediaEntry);
      rawById.set(id, merged);
      accumulator.entries.push(mediaEntry);
      accumulator.events.push(addTimelineEvent(mediaEntry, event.timestamp, malMeta));
      accumulator.firstAddedAt = accumulator.firstAddedAt ?? event.timestamp;
      accumulator.lastSeenAt = event.timestamp;
    } else {
      const { event: _event, timestamp: _timestamp, key: _key, reason, ...mediaEntry } = event;
      const merged = mergeEntry(rawById.get(id), mediaEntry);
      rawById.set(id, merged);
      accumulator.entries.push(mediaEntry);
      accumulator.events.push(removeTimelineEvent(mediaEntry, event.timestamp, reason));
      accumulator.removedAt = event.timestamp;
      accumulator.lastSeenAt = event.timestamp;
    }

    accumulators.set(id, accumulator);
  }

  const items: UiItem[] = [];
  for (const accumulator of accumulators.values()) {
    const entry = rawById.get(accumulator.id);
    if (!entry) continue;

    const sources = [...new Set(accumulator.entries.map((e) => sourceDisplay(e.source)))];
    const active = index.activeByKey.has(accumulator.id);
    const timeline = sortEvents(accumulator.events);
    const lineage = lineageFor(entry, malMeta);
    const targetId = targetMalId(entry);
    const targetMeta = targetId ? malMeta[String(targetId)] : undefined;
    const imageUrl = lineage ? targetMeta?.imageUrl ?? entry.imageUrl : entry.imageUrl ?? targetMeta?.imageUrl;

    items.push({
      anime: entry.anime,
      endpoint: endpointFor(entry),
      externalIds: externalIdsFor(entry),
      firstAddedAt: accumulator.firstAddedAt ?? timeline[0]?.at ?? "",
      id: accumulator.id,
      imageUrl,
      kind: kindFor(entry),
      lastSeenAt: accumulator.lastSeenAt ?? timeline.at(-1)?.at ?? "",
      lineage,
      mediaType: entry.type,
      related: [],
      sourceSummary: sources.join(" + "),
      sources,
      status: active ? "active" : "removed",
      statusDetail: active ? `Active in ${endpointFor(entry)}` : `Removed from ${endpointFor(entry)}`,
      timeline,
      title: entry.title,
      year: entry.year,
    });
  }

  const sorted = buildRelatedItems(items, rawById, malMeta).sort((a, b) => {
    if (a.status !== b.status) return a.status === "active" ? -1 : 1;
    return new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime();
  });
  const hydrated = await hydratePosterUrls(sorted, rawById);

  return {
    generatedAt: new Date().toISOString(),
    items: hydrated,
    sourceMode: process.env.LISTARR_SKIP_REFRESH === "1" || process.env.LISTARR_SKIP_REFRESH === "true" ? "event-log" : "live-refresh",
    stats: {
      active: hydrated.filter((item) => item.status === "active").length,
      all: hydrated.length,
      anime: hydrated.filter((item) => item.anime).length,
      movies: hydrated.filter((item) => item.mediaType === "movie").length,
      multiSource: hydrated.filter((item) => item.sources.length > 1).length,
      removed: hydrated.filter((item) => item.status === "removed").length,
    },
  };
}
