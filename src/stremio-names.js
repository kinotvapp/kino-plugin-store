// The names of the recommended Stremio addons that catalog.json leaves unnamed. Today's app shows the name the addon's own
// manifest gives; this store cannot read those manifests (each addon is on its own host, which a plugin store does not
// declare), so it carries the names as the manifests gave them on 2026-10-29. Three addons did not answer that day (Marvel,
// DC, Pluto TV): their names are the plain ones. An id not listed here falls back to a name made from the id.
export const STREMIO_NAMES = {
  "opensubtitles-v3": "OpenSubtitles v3",
  "subtis": "Subtis - Beta Pública",
  "subsense": "SubSense",
  "subtitles-website": "Subtitle Search Engine",
  "cinemeta": "Cinemeta",
  "streaming-catalogs": "Streaming Catalogs",
  "imdb-catalogs": "IMDB Catalogs",
  "seenr": "Seenr",
  "stremboxd": "Stremboxd",
  "rotten-tomatoes": "Rotten Tomatoes",
  "film-festivals": "Film Festivals 2 | ElfHosted",
  "mubi": "Mubi Catalog",
  "cinema-time-machine": "Cinema Time Machine",
  "marvel": "Marvel",
  "star-wars": "Star Wars Universe",
  "dc-universe": "DC Universe",
  "james-bond": "James Bond 007 Collection (Official)",
  "anime-kitsu": "Anime Kitsu",
  "anime-catalogs": "Anime Catalogs",
  "animes-season": "Animes' season",
  "dragonball-es": "Dragon Ball ES - Cronología",
  "pluto-tv": "Pluto TV",
  "radios": "Radios",
};

/** The name of the unnamed Stremio entry [id]: the one above, else its id in words ("my-addon" → "My Addon"). */
export function stremioName(id) {
  return STREMIO_NAMES[id] ?? id.split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}
