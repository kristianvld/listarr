export interface MediaEntry {
  tmdb?: string;
  tvdb?: string;
  title: string;
  year: number;
  type: "movie" | "tv";
  source: "letterboxd" | "myanimelist";
  username: string;
  anime: boolean;
  malId?: number; // Original MAL ID
  rootMalId?: number; // Root MAL ID (for OVAs/seasons)
  imageUrl?: string; // Image URL for Discord embeds (from Jikan)
  episodes?: number; // Number of episodes (for TV shows)
  letterboxdSlug?: string; // Letterboxd slug for constructing links
}
