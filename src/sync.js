// Kino Plugins' storeSync (Plugin stores spec §3). Three ways to answer, cheapest first:
//   1. The very first call: the copies shipped inside the plugin (index.json + catalog.json), full, with no network, so the
//      store is full on a first launch with no connection.
//   2. Every hour: the latest index.json (built hourly by a GitHub Action in kinotvapp/kino-plugins) and catalog.json, full.
//      That re-read is what drops a repo that lost the topic or was deleted, and refreshes the stars.
//   3. Between index days: one GitHub search for repos pushed since the last sync (minus a 10-minute overlap), then each new
//      repo's kino-plugin.json from raw.githubusercontent.com, as a delta. The window lives in `state` (the delta cursor):
//      a refused or failed search keeps it for the next sync, and a busy day (more new repos than one sync reads) resumes
//      right after the last repo read.
// GitHub allows 10 unauthenticated searches a minute: one per sync. Its refusal (403/429) or any failure answers an empty
// delta, so Kino keeps the list it has.
import { STORE_ID, entriesOfCatalog, entryOfManifest, keyOf, mergeFull, recommendedIds, recommendedKeys } from "./entries.js";

export const DAY_MS = 24 * 3600_000;

/** How long the index read stays fresh: the index is built every hour, so a device reads it again after this long. */
export const INDEX_EVERY_MS = 3600_000;
export const OVERLAP_MS = 10 * 60_000;
/** Manifests read in one delta, newest pushes first: with the search and a failed index read, inside the run's 40 requests. */
export const MAX_MANIFESTS = 30;
const PARALLEL = 4;
const TIMEOUT_MS = 15_000;
/**
 * The whole run's time budget, under Kino's 60 s limit for a storeSync call. Without it a network where raw.githubusercontent.com
 * hangs but api.github.com answers waits 15 s for each of the 30 manifests (~160 s) and Kino cuts the call by time, which
 * repeated switches the plugin off ("No responde"). Past the budget no request is started: the run answers what it has.
 */
export const BUDGET_MS = 40_000;
/** A request is not started with less than this left of the budget. */
const MIN_LEFT_MS = 2_000;

const INDEX_URLS = [
  "https://raw.githubusercontent.com/kinotvapp/kino-plugins/main/index.json",
  "https://cdn.jsdelivr.net/gh/kinotvapp/kino-plugins@main/index.json",
];
const CATALOG_URLS = [
  "https://raw.githubusercontent.com/kinotvapp/kino-plugins/main/catalog.json",
  "https://archive.org/download/kino-app/plugin-catalog.json",
  "https://cdn.jsdelivr.net/gh/kinotvapp/kino-plugins@main/catalog.json",
];
const SEARCH_URL = "https://api.github.com/search/repositories";
/** kino.fetch's largest `maxBytes` (contract.json fetch.maxBytes.max): the index and a search page are read up to it. */
const INDEX_MAX_BYTES = 2_000_000;
const CATALOG_MAX_BYTES = 64 * 1024;
const MANIFEST_MAX_BYTES = 16 * 1024;

/** The body of [url] as JSON, or null on any failure (a non-2xx answer, a cut body, a network error, bad JSON). */
async function getJson(fetch, url, maxBytes, headers) {
  try {
    const r = await fetch(url, { timeoutMs: TIMEOUT_MS, maxBytes, ...(headers ? { headers } : {}) });
    if (!r || !r.ok || r.truncated) return { status: r ? r.status : 0, body: null };
    return { status: r.status, body: r.json() };
  } catch {
    return { status: 0, body: null };
  }
}

/** The first of [urls] that answers JSON accepted by [valid], or null. */
async function firstJson(fetch, urls, maxBytes, valid) {
  for (const url of urls) {
    const { body } = await getJson(fetch, url, maxBytes);
    if (body && valid(body)) return body;
  }
  return null;
}

const validIndex = (b) => b && b.schema === 1 && Number.isFinite(b.generatedAt) && Array.isArray(b.entries);
const validCatalog = (b) => b && b.schema === 1 && Array.isArray(b.plugins);

/**
 * A full answer from [index] and [catalog]; [readAt]: when the index was downloaded (0 for the shipped copy). The list is
 * replaced whole, so the delta cursor restarts at the index's own `generatedAt`: a repo pushed after the index was built but
 * before it was read is in neither, and the next searches must find it (a cursor at the read time, or at an older delta, missed it
 * until the next hourly index).
 */
function full(index, catalog, readAt) {
  const recommended = entriesOfCatalog(catalog);
  return {
    full: true,
    entries: mergeFull(index.entries, recommended),
    state: {
      indexGeneratedAt: index.generatedAt,
      indexReadAt: readAt,
      recommended: recommendedKeys(recommended),
      recommendedIds: recommendedIds(recommended),
      deltaFrom: index.generatedAt,
    },
  };
}

/**
 * Where the next search window starts, in ms (the query asks `pushed:>` it):
 * - `deltaAfter` (a busy day was cut): exactly there, one second before the last repo read, so nothing pushed after it is
 *   lost and the next sync always moves on (a few repos of that second are read twice; the upsert drops the repeat);
 * - else `deltaFrom` (the end of the last window read, or the start of one GitHub refused), or Kino's [since] before any
 *   window was read, minus the 10-minute overlap that guards the edge;
 * never before the index the list stands on (its `generatedAt`, minus the overlap).
 */
function windowStart(state, since) {
  const floor = state.indexGeneratedAt - OVERLAP_MS;
  if (Number.isFinite(state.deltaAfter)) return Math.max(floor, state.deltaAfter);
  return Math.max(floor, (Number.isFinite(state.deltaFrom) ? state.deltaFrom : since) - OVERLAP_MS);
}

/** `2026-10-29T03:00:00Z`: GitHub's search takes ISO 8601 with time, without milliseconds. */
const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Runs [task] over [items] with at most [n] at a time; the answers in [items]' order. */
async function pool(items, n, task) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await task(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

const pushedMs = (r) => {
  const t = r.pushedAt ? Date.parse(r.pushedAt) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/**
 * The repos pushed after the window of [state] as a delta, oldest push first, at most [MAX_MANIFESTS] manifests. [since]: Kino's
 * last successful sync, [at]: now. A refused or failed search answers an empty delta whose state still names that window.
 */
async function delta(fetch, state, since, at, outOfBudget) {
  const { deltaFrom, deltaAfter, ...rest } = state;
  const from = windowStart(state, since);
  // Refused (403/429) or failed: the same window next time. Before any window was kept, Kino's `since` is pinned now, because
  // Kino moves it forward on this (successful) empty answer.
  const kept = { ...rest, ...(Number.isFinite(deltaAfter) ? { deltaAfter } : { deltaFrom: Number.isFinite(deltaFrom) ? deltaFrom : since }) };
  const q = `topic:kino-plugin fork:false pushed:>${isoSeconds(from)}`;
  // sort=updated orders by updated_at, not pushed_at: the page is sorted by push here.
  const url = `${SEARCH_URL}?q=${encodeURIComponent(q)}&sort=updated&order=asc&per_page=100`;
  const { body } = await getJson(fetch, url, INDEX_MAX_BYTES, { Accept: "application/vnd.github+json" });
  if (!body || !Array.isArray(body.items)) return { full: false, entries: [], state: kept };
  // A recommended repo keeps the row the catalog gave it (its words, its "recommended"): the hourly index refreshes it.
  const recommended = new Set(Array.isArray(state.recommended) ? state.recommended : []);
  const found = body.items
    .filter((it) => it && it.fork !== true && it.owner && typeof it.owner.login === "string" && typeof it.name === "string")
    .map((it) => ({ owner: it.owner.login, repo: it.name, stars: it.stargazers_count, pushedAt: it.pushed_at ?? null }))
    .sort((a, b) => pushedMs(a) - pushedMs(b));
  const candidates = found.filter((r) => !recommended.has(keyOf(`${r.owner}/${r.repo}`)));
  const repos = candidates.slice(0, MAX_MANIFESTS);
  const entries = await pool(repos, PARALLEL, async (r) => {
    const { body: m } = await getJson(fetch, `https://raw.githubusercontent.com/${r.owner}/${r.repo}/HEAD/kino-plugin.json`, MANIFEST_MAX_BYTES);
    return m ? entryOfManifest(r, m) : null;
  });
  // Cut: more candidates than one sync reads, or more results than the page holds. The next sync starts after the last read.
  const readCut = candidates.length > repos.length;
  const pageCut = Number.isFinite(body.total_count) && body.total_count > body.items.length;
  const last = (readCut ? repos : found).reduce((max, r) => Math.max(max, pushedMs(r)), 0);
  const cursor = (readCut || pageCut) && last - 1000 > from ? { deltaAfter: last - 1000 } : { deltaFrom: at };
  // The budget ran out while reading manifests: some repos were not read, so the window stays where it was (the repeats
  // that were read are dropped by Kino's upsert) instead of moving past them.
  const stateOut = outOfBudget() ? kept : { ...rest, ...cursor };
  // A repo that reuses a recommended id (or the store's own) is an impostor: never in the list, whatever the next index says.
  const taken = new Set([STORE_ID, ...(Array.isArray(state.recommendedIds) ? state.recommendedIds : [])]);
  return { full: false, entries: entries.filter((e) => e && !taken.has(e.id)), state: stateOut };
}

/**
 * The `storeSync` answer for [arg] (`{ reason, since?, state? }`). [deps]: `fetch` (kino.fetch), `now()` in ms, and `shipped`,
 * the `{ index, catalog }` copies bundled into the plugin.
 */
export async function sync(arg, deps) {
  const { now, shipped } = deps;
  const state = arg && arg.state && typeof arg.state === "object" ? arg.state : null;
  if (!state || !Number.isFinite(state.indexGeneratedAt)) return full(shipped.index, shipped.catalog, 0);
  const at = now();
  const deadline = at + BUDGET_MS;
  const fetch = (url, options) => {
    const left = deadline - now();
    // Out of budget: no request, which getJson reads as a failed one.
    if (left < MIN_LEFT_MS) return Promise.resolve(null);
    return deps.fetch(url, { ...options, timeoutMs: Math.min(options.timeoutMs ?? TIMEOUT_MS, left) });
  };
  const outOfBudget = () => deadline - now() < MIN_LEFT_MS;
  if (!(at - (state.indexReadAt || 0) < INDEX_EVERY_MS)) {
    const index = await firstJson(fetch, INDEX_URLS, INDEX_MAX_BYTES, validIndex);
    if (index) {
      const catalog = (await firstJson(fetch, CATALOG_URLS, CATALOG_MAX_BYTES, validCatalog)) ?? shipped.catalog;
      return full(index, catalog, at);
    }
  }
  return delta(fetch, state, Number.isFinite(arg.since) ? arg.since : 0, at, outOfBudget);
}
