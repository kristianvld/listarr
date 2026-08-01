import { describe, expect, test } from "bun:test";
import { createEntryIndex, indexEntryIdentity, type EntryIndex } from "../entry-state";
import { scrapeLetterboxdWatchlist } from "./letterboxd";

type FixtureFilm = {
  slug: string;
  title: string;
  year: number;
  tmdb: string;
};

const username = "fixture-user";
const watchlistUrl = `https://letterboxd.com/${username}/watchlist/`;

function watchlistPage(total: number, films: FixtureFilm[], nextPage?: number): string {
  const items = films
    .map(
      (film) => `
        <li class="griditem">
          <div class="react-component"
            data-item-name="${film.title} (${film.year})"
            data-item-full-display-name="${film.title} (${film.year})"
            data-item-slug="${film.slug}"></div>
        </li>`,
    )
    .join("");
  const pagination = nextPage
    ? `<div class="pagination"><a class="next" href="/${username}/watchlist/page/${nextPage}/">Older</a></div>`
    : "";

  return `<!doctype html>
    <html>
      <head><title>${username}'s Watchlist • Letterboxd</title></head>
      <body class="screen-member-child-page watchlist wide">
        <div class="js-watchlist-content" data-num-entries="${total}">
          <ul>${items}</ul>
          ${pagination}
        </div>
      </body>
    </html>`;
}

function indexFilms(films: FixtureFilm[]): EntryIndex {
  const index = createEntryIndex();
  for (const film of films) {
    indexEntryIdentity(index, {
      tmdb: film.tmdb,
      title: film.title,
      year: film.year,
      type: "movie",
      source: "letterboxd",
      username,
      anime: false,
      letterboxdSlug: film.slug,
    });
  }
  return index;
}

function fixtureFetchers(pages: Record<string, string>) {
  return {
    fetchHtml: async (url: string) => {
      const html = pages[url];
      if (html === undefined) throw new Error(`Unexpected fixture URL: ${url}`);
      return html;
    },
    fetchJson: async (url: string) => {
      throw new Error(`Unexpected JSON fixture URL: ${url}`);
    },
  };
}

const films: FixtureFilm[] = [
  { slug: "alpha", title: "Alpha", year: 2001, tmdb: "101" },
  { slug: "beta", title: "Beta", year: 2002, tmdb: "102" },
  { slug: "gamma", title: "Gamma", year: 2003, tmdb: "103" },
];

describe("Letterboxd watchlist completeness validation", () => {
  test("accepts a complete multi-page watchlist", async () => {
    const snapshot = await scrapeLetterboxdWatchlist(username, indexFilms(films), {
      fetchers: fixtureFetchers({
        [watchlistUrl]: watchlistPage(3, films.slice(0, 2), 2),
        [`${watchlistUrl}page/2/`]: watchlistPage(3, films.slice(2)),
      }),
    });

    expect(snapshot.keys).toEqual(new Set(["tmdb:101", "tmdb:102", "tmdb:103"]));
  });

  test("accepts an explicitly empty first page", async () => {
    const snapshot = await scrapeLetterboxdWatchlist(username, createEntryIndex(), {
      fetchers: fixtureFetchers({ [watchlistUrl]: watchlistPage(0, []) }),
    });

    expect(snapshot.keys.size).toBe(0);
  });

  test("rejects an opaque empty response on the first page", async () => {
    const scrape = scrapeLetterboxdWatchlist(username, indexFilms(films), {
      fetchers: fixtureFetchers({
        [watchlistUrl]: "<!doctype html><html><head><title>Just a moment...</title></head><body></body></html>",
      }),
    });

    await expect(scrape).rejects.toThrow("missing watchlist structure");
  });

  test("rejects the observed zero-film response during pagination", async () => {
    const scrape = scrapeLetterboxdWatchlist(username, indexFilms(films), {
      fetchers: fixtureFetchers({
        [watchlistUrl]: watchlistPage(3, films.slice(0, 2), 2),
        [`${watchlistUrl}page/2/`]: watchlistPage(3, []),
      }),
    });

    await expect(scrape).rejects.toThrow("declared 3 total films but returned no film items");
  });

  test("rejects a non-empty response that truncates pagination early", async () => {
    const scrape = scrapeLetterboxdWatchlist(username, indexFilms(films), {
      fetchers: fixtureFetchers({
        [watchlistUrl]: watchlistPage(3, films.slice(0, 1), 2),
        [`${watchlistUrl}page/2/`]: watchlistPage(3, films.slice(1, 2)),
      }),
    });

    await expect(scrape).rejects.toThrow("parsed 2 of 3 declared films");
  });

  test("rejects a declared non-empty first page with zero films", async () => {
    const scrape = scrapeLetterboxdWatchlist(username, indexFilms(films), {
      fetchers: fixtureFetchers({ [watchlistUrl]: watchlistPage(3, []) }),
    });

    await expect(scrape).rejects.toThrow("declared 3 total films but returned no film items");
  });
});
