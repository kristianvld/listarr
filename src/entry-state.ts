import type { AnnouncedEntry, EntryLogEvent, MediaEntry } from "./adapters/schemas";

export type EntryIndex = {
  byKey: Set<string>;
  byMalId: Set<number>;
  byRootMalId: Set<number>;
  keyByAlias: Map<string, string>;
  keyByMalId: Map<number, string>;
  keyByRootMalId: Map<number, string>;
  entriesByKey: Map<string, MediaEntry>;
  activeByKey: Map<string, MediaEntry>;
  historicalKeys: Set<string>;
};

export type ScrapedWatchlist = {
  keys: Set<string>;
  entriesByKey: Map<string, MediaEntry>;
};

type EntryIdentity = {
  tmdb?: string;
  tvdb?: string;
  title: string;
  year: number;
  type: "movie" | "tv";
  malId?: number;
  rootMalId?: number;
  letterboxdSlug?: string;
};

export function getLetterboxdSourceKey(slug: string, year: number): string {
  return `letterboxd:${slug}:${year}`;
}

export function getMalSourceKey(malId: number): string {
  return `mal:${malId}`;
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

export function getEntryKey(entry: EntryIdentity): string {
  if (entry.type === "movie" && entry.tmdb) return `tmdb:${entry.tmdb}`;
  if (entry.type === "tv" && entry.tvdb) return `tvdb:${entry.tvdb}`;
  if (entry.tmdb) return `tmdb:${entry.tmdb}`;
  if (entry.tvdb) return `tvdb:${entry.tvdb}`;
  if (entry.rootMalId) return getMalSourceKey(entry.rootMalId);
  if (entry.malId) return getMalSourceKey(entry.malId);
  if (entry.letterboxdSlug) return getLetterboxdSourceKey(entry.letterboxdSlug, entry.year);
  return `title:${normalizeTitle(entry.title)}:${entry.year}:${entry.type}`;
}

function isIntermediaryEntry(entry: { title: string }): boolean {
  return entry.title.startsWith("[Intermediary:");
}

function stripRuntimeFields(entry: MediaEntry): MediaEntry {
  const { imageUrl, episodes, intermediaryMalIds, ...persistedEntry } = entry;
  return persistedEntry;
}

function getEntryAliases(entry: EntryIdentity): string[] {
  const aliases = new Set<string>([getEntryKey(entry)]);

  if (entry.tmdb) aliases.add(`tmdb:${entry.tmdb}`);
  if (entry.tvdb) aliases.add(`tvdb:${entry.tvdb}`);
  if (entry.malId) aliases.add(getMalSourceKey(entry.malId));
  if (entry.rootMalId) aliases.add(getMalSourceKey(entry.rootMalId));
  if (entry.letterboxdSlug) aliases.add(getLetterboxdSourceKey(entry.letterboxdSlug, entry.year));

  return [...aliases];
}

export function createEntryIndex(): EntryIndex {
  return {
    byKey: new Set(),
    byMalId: new Set(),
    byRootMalId: new Set(),
    keyByAlias: new Map(),
    keyByMalId: new Map(),
    keyByRootMalId: new Map(),
    entriesByKey: new Map(),
    activeByKey: new Map(),
    historicalKeys: new Set(),
  };
}

export function createScrapedWatchlist(): ScrapedWatchlist {
  return {
    keys: new Set(),
    entriesByKey: new Map(),
  };
}

export function announcedToMedia(entry: AnnouncedEntry): MediaEntry {
  const { event, timestamp, ...mediaEntry } = entry;
  return mediaEntry;
}

export function indexMalAlias(index: EntryIndex, malId: number, key: string): void {
  index.byMalId.add(malId);
  index.keyByMalId.set(malId, key);
  index.keyByAlias.set(getMalSourceKey(malId), key);
}

export function indexRootMalAlias(index: EntryIndex, rootMalId: number, key: string): void {
  index.byRootMalId.add(rootMalId);
  index.keyByRootMalId.set(rootMalId, key);
  index.keyByAlias.set(getMalSourceKey(rootMalId), key);
}

export function getKnownAliasKey(index: EntryIndex, alias: string): string | undefined {
  return index.keyByAlias.get(alias);
}

export function getKnownMalKey(index: EntryIndex, malId: number): string | undefined {
  return index.keyByMalId.get(malId) ?? index.keyByRootMalId.get(malId) ?? index.keyByAlias.get(getMalSourceKey(malId));
}

export function indexEntryIdentity(index: EntryIndex, entry: MediaEntry): string {
  const key = getEntryKey(entry);

  for (const alias of getEntryAliases(entry)) {
    index.byKey.add(alias);
    index.keyByAlias.set(alias, key);
  }

  if (entry.malId) indexMalAlias(index, entry.malId, key);
  if (entry.rootMalId) indexRootMalAlias(index, entry.rootMalId, key);

  if (!isIntermediaryEntry(entry) && !index.entriesByKey.has(key)) {
    index.entriesByKey.set(key, stripRuntimeFields(entry));
  }

  return key;
}

export function recordHistoricalAdd(index: EntryIndex, entry: MediaEntry): string {
  const key = indexEntryIdentity(index, entry);
  index.historicalKeys.add(key);

  if (!isIntermediaryEntry(entry)) {
    index.entriesByKey.set(key, stripRuntimeFields(entry));
  }

  return key;
}

export function recordActiveAdd(index: EntryIndex, entry: MediaEntry): string {
  const key = recordHistoricalAdd(index, entry);

  if (!isIntermediaryEntry(entry)) {
    index.activeByKey.set(key, stripRuntimeFields(entry));
  }

  return key;
}

export function recordRemoval(index: EntryIndex, key: string): void {
  index.activeByKey.delete(key);
}

export function addCurrentKey(snapshot: ScrapedWatchlist, key: string): void {
  snapshot.keys.add(key);
}

export function addCurrentEntry(snapshot: ScrapedWatchlist, index: EntryIndex, entry: MediaEntry): string {
  const key = indexEntryIdentity(index, entry);
  snapshot.keys.add(key);

  if (!isIntermediaryEntry(entry)) {
    snapshot.entriesByKey.set(key, stripRuntimeFields(entry));
  }

  return key;
}

export function buildEntryIndex(events: EntryLogEvent[]): EntryIndex {
  const index = createEntryIndex();

  for (const event of events) {
    if (event.event === "add") {
      recordActiveAdd(index, announcedToMedia(event));
    } else {
      recordRemoval(index, event.key);
    }
  }

  return index;
}

export function createIntermediaryEntry(username: string, malId: number, rootMalId: number): MediaEntry {
  return {
    title: `[Intermediary: MAL ${malId}]`,
    year: 1900,
    type: "tv",
    source: "myanimelist",
    username,
    anime: true,
    malId,
    rootMalId,
  };
}
