// Tenrai implements the Jikan response shapes used by Listarr.
export const ANIME_API_BASE_URL = (process.env.ANIME_API_BASE_URL || "https://api.tenrai.org/v1").replace(/\/+$/, "");
if (!/^https?:\/\//.test(ANIME_API_BASE_URL)) throw new Error("ANIME_API_BASE_URL must be an HTTP(S) URL");
