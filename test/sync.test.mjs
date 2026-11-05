import assert from "node:assert/strict";
import { test } from "node:test";

import { readFileSync } from "node:fs";

import { BUDGET_MS, DAY_MS, MAX_MANIFESTS, OVERLAP_MS, sync } from "../src/sync.js";

const T0 = Date.UTC(2026, 9, 29, 3, 0, 0);

const shipped = {
  index: {
    schema: 1,
    generatedAt: T0,
    entries: [
      { address: "ana/kino-plugin-pelis", id: "pelis", name: "Pelis", description: "De Ana", categories: ["movies"], popularity: 3 },
      { address: "kinotvapp/kino-plugin-archive", id: "internet-archive", name: "Internet Archive", categories: ["movies"], popularity: 40 },
    ],
  },
  catalog: {
    schema: 1,
    plugins: [
      { id: "internet-archive", repo: "kinotvapp/kino-plugin-archive", name: "Internet Archive", description: "Dominio público.", tags: ["gratis"] },
      { id: "subs-addon", stremio: "https://subs.example.org/manifest.json", name: "Subs", categories: ["subtitles"] },
    ],
  },
};

/** A fake kino.fetch: [routes] maps a URL prefix to a response ({ status, body }) or a function of the URL. */
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    // Kino refuses a maxBytes out of contract.json fetch.maxBytes (1 to 2000000) with invalid_request.
    if (options.maxBytes !== undefined && !(Number.isInteger(options.maxBytes) && options.maxBytes >= 1 && options.maxBytes <= 2_000_000)) {
      throw new Error("invalid_request: maxBytes takes 1 to 2000000");
    }
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return { ok: false, status: 404, headers: {}, text: () => "", json: () => { throw new Error("no body"); } };
    const r = typeof routes[key] === "function" ? routes[key](url) : routes[key];
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, headers: {}, text: () => JSON.stringify(r.body), json: () => r.body };
  };
  return { fetch, calls };
}

const RAW_INDEX = "https://raw.githubusercontent.com/kinotvapp/kino-plugins/main/index.json";
const CDN_INDEX = "https://cdn.jsdelivr.net/gh/kinotvapp/kino-plugins@main/index.json";
const RAW_CATALOG = "https://raw.githubusercontent.com/kinotvapp/kino-plugins/main/catalog.json";
const SEARCH = "https://api.github.com/search/repositories";

const synced = (now) => ({ indexGeneratedAt: T0, indexReadAt: now - 20 * 60_000, recommended: ["kinotvapp/kino-plugin-archive"] });

test("first sync is the shipped list, full", async () => {
  const { fetch, calls } = fakeFetch({});
  const r = await sync({ reason: "schedule" }, { fetch, now: () => T0 + 60_000, shipped });
  assert.equal(r.full, true);
  assert.equal(calls.length, 0, "no network on the first call");
  const byKey = Object.fromEntries(r.entries.map((e) => [e.address ?? e.stremio, e]));
  assert.equal(byKey["kinotvapp/kino-plugin-archive"].recommended, true);
  assert.equal(byKey["kinotvapp/kino-plugin-archive"].description, "Dominio público.", "the catalog's words win for a recommended plugin");
  assert.equal(byKey["kinotvapp/kino-plugin-archive"].popularity, 40, "the index still brings its stars");
  assert.equal(byKey["ana/kino-plugin-pelis"].recommended, undefined);
  assert.equal(byKey["https://subs.example.org/manifest.json"].recommended, true);
  assert.equal(r.entries.length, 3, "the recommended plugin the index also lists is one entry");
  assert.equal(r.state.indexGeneratedAt, T0);
  assert.deepEqual(r.state.recommended, ["kinotvapp/kino-plugin-archive"]);
});

test("a day later it is today's index, full", async () => {
  const today = T0 + DAY_MS;
  const index = { schema: 1, generatedAt: today, entries: [{ address: "bob/kino-plugin-new", id: "new", name: "Nuevo", categories: ["series"] }] };
  const catalog = { schema: 1, plugins: [{ id: "new", repo: "bob/kino-plugin-new", name: "Nuevo recomendado", description: "Ahora sí" }] };
  const { fetch, calls } = fakeFetch({ [RAW_INDEX]: { status: 503, body: {} }, [CDN_INDEX]: { body: index }, [RAW_CATALOG]: { body: catalog } });
  const now = today + 2 * 3600_000;
  const r = await sync({ reason: "schedule", since: now - 2 * 3600_000, state: { indexGeneratedAt: T0, indexReadAt: now - DAY_MS - 1, recommended: [] } }, { fetch, now: () => now, shipped });
  assert.equal(r.full, true);
  assert.deepEqual(r.entries.map((e) => [e.address, e.name, e.recommended]), [["bob/kino-plugin-new", "Nuevo recomendado", true]]);
  assert.equal(r.state.indexGeneratedAt, today);
  assert.equal(r.state.indexReadAt, now);
  assert.ok(calls.indexOf(CDN_INDEX) > calls.indexOf(RAW_INDEX), "jsDelivr only after raw failed");
  assert.ok(!calls.some((u) => u.startsWith(SEARCH)), "no search on an index day");
});

test("after a full read the next search starts at the index's own generatedAt: a repo pushed before the read is not lost", async () => {
  // The index was built at T0 + 1 h and read at T0 + 7 h (the hourly build can lag for hours); a repo pushed at T0 + 3 h is in
  // neither the index nor a search that starts at the read time.
  const built = T0 + 3600_000;
  const readAt = T0 + 7 * 3600_000;
  const { fetch: readFetch } = fakeFetch({
    [RAW_INDEX]: { body: { schema: 1, generatedAt: built, entries: [] } },
    [RAW_CATALOG]: { body: { schema: 1, plugins: [] } },
  });
  const state0 = { indexGeneratedAt: T0, indexReadAt: 0, recommended: [] };
  const first = await sync({ reason: "reload", since: readAt - 60_000, state: state0 }, { fetch: readFetch, now: () => readAt, shipped });
  assert.equal(first.full, true);
  assert.equal(first.state.indexGeneratedAt, built);
  assert.equal(first.state.deltaFrom, built, "the cursor restarts at the index, not at the read time");

  const pushed = new Date(T0 + 3 * 3600_000).toISOString();
  const { fetch, calls } = fakeFetch({
    [SEARCH]: { body: { items: [{ full_name: "kinotvapp/kino-plugin-mega", name: "kino-plugin-mega", owner: { login: "kinotvapp" }, fork: false, stargazers_count: 0, pushed_at: pushed }] } },
    "https://raw.githubusercontent.com/kinotvapp/kino-plugin-mega/HEAD/kino-plugin.json": { body: {
      id: "mega", name: "Mega", version: "0.1.0", description: "Catalog", author: "kinotvapp", icon: "icon.png", capabilities: ["home", "browse"],
    } },
  });
  const later = readAt + 2 * 60_000;
  const second = await sync({ reason: "reload", since: readAt, state: first.state }, { fetch, now: () => later, shipped });
  const q = new URL(calls.find((u) => u.startsWith(SEARCH))).searchParams.get("q");
  assert.equal(q, `topic:kino-plugin fork:false pushed:>${new Date(built - OVERLAP_MS).toISOString().replace(/\.\d{3}Z$/, "Z")}`);
  assert.deepEqual(second.entries.map((e) => e.id), ["mega"]);
});

test("between days it asks pushed:> with the 10-minute overlap and returns a delta", async () => {
  const now = T0 + 5 * 3600_000;
  const since = T0 + 4 * 3600_000;
  const pushed = new Date(since + 1000).toISOString();
  const { fetch, calls } = fakeFetch({
    [SEARCH]: { body: { items: [
      { full_name: "carla/kino-plugin-anime", name: "kino-plugin-anime", owner: { login: "carla" }, fork: false, stargazers_count: 7, pushed_at: pushed },
      { full_name: "kinotvapp/kino-plugin-archive", name: "kino-plugin-archive", owner: { login: "kinotvapp" }, fork: false, stargazers_count: 41, pushed_at: pushed },
    ] } },
    "https://raw.githubusercontent.com/carla/kino-plugin-anime/HEAD/kino-plugin.json": { body: {
      id: "anime", name: "Anime", version: "1.2.0", description: "Anime", author: "carla", icon: "icon.png",
      capabilities: ["search", "resolve", "episodes"], signature: { authorKey: "a".repeat(64), value: "b".repeat(128) },
    } },
  });
  const r = await sync({ reason: "schedule", since, state: synced(now) }, { fetch, now: () => now, shipped });
  assert.equal(r.full, false);
  const search = calls.filter((u) => u.startsWith(SEARCH));
  assert.equal(search.length, 1, "one search per incremental sync");
  const q = new URL(search[0]).searchParams.get("q");
  assert.equal(q, `topic:kino-plugin fork:false pushed:>${new Date(since - OVERLAP_MS).toISOString().replace(/\.\d{3}Z$/, "Z")}`);
  assert.equal(new URL(search[0]).searchParams.get("sort"), "updated");
  assert.equal(new URL(search[0]).searchParams.get("order"), "asc");
  assert.equal(new URL(search[0]).searchParams.get("per_page"), "100");
  assert.deepEqual(r.entries, [{
    address: "carla/kino-plugin-anime", id: "anime", name: "Anime", description: "Anime", categories: ["movies", "series"],
    version: "1.2.0", author: "carla", icon: "https://raw.githubusercontent.com/carla/kino-plugin-anime/HEAD/icon.png",
    popularity: 7, updatedAt: since + 1000, signed: true, authorKey: "a".repeat(64),
  }], "a recommended repo keeps the row the catalog gave it");
  assert.deepEqual(r.state, { ...synced(now), deltaFrom: now }, "the next window starts where this one ended");
});

test("between days the overlap counts from the index when it is newer than the last sync", async () => {
  const now = T0 + 5 * 3600_000;
  const { fetch, calls } = fakeFetch({ [SEARCH]: { body: { items: [] } } });
  await sync({ reason: "schedule", since: T0 - 3600_000, state: synced(now) }, { fetch, now: () => now, shipped });
  const q = new URL(calls[0]).searchParams.get("q");
  assert.ok(q.endsWith(`pushed:>${new Date(T0 - OVERLAP_MS).toISOString().replace(/\.\d{3}Z$/, "Z")}`), q);
});

test("discoverable false is dropped", async () => {
  const now = T0 + 5 * 3600_000;
  const item = (n) => ({ full_name: `dan/${n}`, name: n, owner: { login: "dan" }, fork: false, stargazers_count: 1, pushed_at: new Date(now).toISOString() });
  const { fetch } = fakeFetch({
    [SEARCH]: { body: { items: [item("hidden"), item("shown")] } },
    "https://raw.githubusercontent.com/dan/hidden/HEAD/kino-plugin.json": { body: { id: "hidden", name: "Hidden", discoverable: false, capabilities: ["subtitles"] } },
    "https://raw.githubusercontent.com/dan/shown/HEAD/kino-plugin.json": { body: { id: "shown", name: "Shown", capabilities: ["subtitles"], categories: ["subtitles", "adult"] } },
  });
  const r = await sync({ reason: "reload", since: now - 3600_000, state: synced(now) }, { fetch, now: () => now, shipped });
  assert.deepEqual(r.entries.map((e) => [e.id, e.categories]), [["shown", ["subtitles", "adult"]]]);
});

test("a 403 from GitHub keeps the last list and returns an empty delta", async () => {
  const now = T0 + 5 * 3600_000;
  const { fetch } = fakeFetch({ [SEARCH]: { status: 403, body: { message: "API rate limit exceeded" } } });
  const state = synced(now);
  const since = now - 3600_000;
  const r = await sync({ reason: "schedule", since, state }, { fetch, now: () => now, shipped });
  assert.deepEqual(r, { full: false, entries: [], state: { ...state, deltaFrom: since } });
});

test("a 403 leaves the window to the next sync", async () => {
  const now = T0 + 5 * 3600_000;
  const since = now - 3600_000;
  const refused = fakeFetch({ [SEARCH]: { status: 403, body: {} } });
  const first = await sync({ reason: "schedule", since, state: synced(now) }, { fetch: refused.fetch, now: () => now, shipped });
  // Kino counts the empty answer as a sync and moves `since` on; the store's cursor still names the refused window.
  const later = now + 30 * 60_000; // within the hour the index stays fresh: still a delta
  const ok = fakeFetch({ [SEARCH]: { body: { items: [] } } });
  const second = await sync({ reason: "schedule", since: now, state: first.state }, { fetch: ok.fetch, now: () => later, shipped });
  const q = new URL(ok.calls[0]).searchParams.get("q");
  assert.ok(q.endsWith(`pushed:>${new Date(since - OVERLAP_MS).toISOString().replace(/\.\d{3}Z$/, "Z")}`), q);
  assert.equal(second.state.deltaFrom, later);
  // A second refusal in a row keeps the same window again.
  const again = await sync({ reason: "schedule", since: later, state: first.state }, { fetch: refused.fetch, now: () => later, shipped });
  assert.equal(again.state.deltaFrom, since);
});

test("a busy day is read across two syncs with nothing lost", async () => {
  const now = T0 + 6 * 3600_000;
  const base = T0 + 3600_000;
  // 45 new repos, one pushed a minute apart; GitHub answers those pushed after the asked date, by update time ascending.
  const repos = Array.from({ length: 45 }, (_, i) => ({
    full_name: `busy/p${i}`, name: `p${i}`, owner: { login: "busy" }, fork: false, stargazers_count: 0,
    pushed_at: new Date(base + i * 60_000).toISOString(), updated_at: new Date(base + i * 60_000).toISOString(),
  }));
  const search = (url) => {
    const q = new URL(url).searchParams.get("q");
    const after = Date.parse(q.slice(q.indexOf("pushed:>") + 8));
    const items = repos.filter((r) => Date.parse(r.pushed_at) > after);
    return { body: { total_count: items.length, items: items.slice(0, 100) } };
  };
  const routes = { [SEARCH]: search };
  for (const r of repos) routes[`https://raw.githubusercontent.com/busy/${r.name}/HEAD/kino-plugin.json`] = { body: { id: r.name, name: r.name, capabilities: ["search", "resolve"] } };
  const { fetch } = fakeFetch(routes);
  const state0 = { ...synced(now), indexGeneratedAt: base - 3600_000 };
  const first = await sync({ reason: "schedule", since: base - 60_000, state: state0 }, { fetch, now: () => now, shipped });
  assert.equal(first.entries.length, MAX_MANIFESTS);
  assert.deepEqual(first.entries.map((e) => e.id), repos.slice(0, MAX_MANIFESTS).map((r) => r.name), "oldest pushes first");
  assert.equal(first.state.deltaAfter, base + (MAX_MANIFESTS - 1) * 60_000 - 1000);
  const second = await sync({ reason: "schedule", since: now, state: first.state }, { fetch, now: () => now + 3600_000, shipped });
  const seen = new Set([...first.entries, ...second.entries].map((e) => e.id));
  assert.equal(seen.size, 45, "every repo read once or twice, none lost");
  assert.equal(second.state.deltaFrom, now + 3600_000);
  assert.equal(second.state.deltaAfter, undefined);
});

test("the cursor survives in state within MAX_STATE_BYTES", async () => {
  const now = T0 + 5 * 3600_000;
  const recommended = Array.from({ length: 50 }, (_, i) => `kinotvapp/kino-plugin-with-a-rather-long-name-${i}`);
  const state = { ...synced(now), recommended, deltaAfter: now - 3600_000 };
  const { fetch } = fakeFetch({ [SEARCH]: { status: 429, body: {} } });
  const r = await sync({ reason: "schedule", since: now - 60_000, state }, { fetch, now: () => now, shipped });
  assert.equal(r.state.deltaAfter, now - 3600_000);
  assert.ok(Buffer.byteLength(JSON.stringify(r.state)) <= 16384);
});

test("a day whose index cannot be read falls back to the delta and asks for the index again next time", async () => {
  const now = T0 + DAY_MS + 3600_000;
  const state = { ...synced(now), indexReadAt: T0 };
  const { fetch, calls } = fakeFetch({ [SEARCH]: { body: { items: [] } } });
  const r = await sync({ reason: "schedule", since: now - 3600_000, state }, { fetch, now: () => now, shipped });
  assert.equal(r.full, false);
  assert.equal(r.state.indexReadAt, state.indexReadAt, "indexReadAt is not moved: the next sync tries the index again");
  assert.ok(calls.some((u) => u.startsWith(SEARCH)));
});

test("a network error on a manifest skips that repo only", async () => {
  const now = T0 + 5 * 3600_000;
  const item = (n) => ({ full_name: `eva/${n}`, name: n, owner: { login: "eva" }, fork: false, stargazers_count: 0, pushed_at: new Date(now).toISOString() });
  const { fetch } = fakeFetch({
    [SEARCH]: { body: { items: [item("down"), item("up")] } },
    "https://raw.githubusercontent.com/eva/down/HEAD/kino-plugin.json": new Error("timeout"),
    "https://raw.githubusercontent.com/eva/up/HEAD/kino-plugin.json": { body: { id: "up", name: "Up", capabilities: ["search", "resolve"] } },
  });
  const r = await sync({ reason: "schedule", since: now - 3600_000, state: synced(now) }, { fetch, now: () => now, shipped });
  assert.deepEqual(r.entries.map((e) => e.id), ["up"]);
});

test("the shipped first sync keeps every recommended Stremio entry, named", async () => {
  const real = {
    index: JSON.parse(readFileSync(new URL("../index.json", import.meta.url), "utf8")),
    catalog: JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf8")),
  };
  const addons = real.catalog.plugins.filter((p) => p.stremio);
  const r = await sync({ reason: "schedule" }, { fetch: fakeFetch({}).fetch, now: () => T0, shipped: real });
  const stremio = r.entries.filter((e) => e.stremio);
  assert.deepEqual(stremio.map((e) => e.id), addons.map((p) => p.id));
  for (const e of stremio) assert.ok(typeof e.name === "string" && e.name.trim() && e.recommended, JSON.stringify(e));
  assert.equal(stremio.find((e) => e.id === "opensubtitles-v3").name, "OpenSubtitles v3");
});

test("a delta never brings a repo that reuses a recommended id, or the store's own id", async () => {
  const now = T0 + 5 * 3600_000;
  const item = (o, n) => ({ full_name: `${o}/${n}`, name: n, owner: { login: o }, fork: false, stargazers_count: 1, pushed_at: new Date(now).toISOString() });
  const { fetch } = fakeFetch({
    [SEARCH]: { body: { items: [item("evil", "archive-copy"), item("evil", "store"), item("dan", "fine")] } },
    "https://raw.githubusercontent.com/evil/archive-copy/HEAD/kino-plugin.json": { body: { id: "internet-archive", name: "Fake archive", capabilities: ["subtitles"] } },
    "https://raw.githubusercontent.com/evil/store/HEAD/kino-plugin.json": { body: { id: "kino-plugins", name: "Fake store", capabilities: ["subtitles"] } },
    "https://raw.githubusercontent.com/dan/fine/HEAD/kino-plugin.json": { body: { id: "fine", name: "Fine", capabilities: ["subtitles"] } },
  });
  const first = await sync({ reason: "schedule" }, { fetch: fakeFetch({}).fetch, now: () => T0, shipped });
  assert.deepEqual(first.state.recommendedIds, ["internet-archive", "subs-addon"]);
  const r = await sync({ reason: "reload", since: now - 3600_000, state: { ...synced(now), recommendedIds: first.state.recommendedIds } }, { fetch, now: () => now, shipped });
  assert.deepEqual(r.entries.map((e) => e.id), ["fine"]);
});

test("a network where raw hangs but the search answers stops inside the time budget and keeps the window", async () => {
  const now0 = T0 + 3 * DAY_MS;
  let clock = now0;
  const items = Array.from({ length: 30 }, (_, i) => ({ name: `r${i}`, fork: false, owner: { login: `u${i}` }, stargazers_count: 1, pushed_at: new Date(now0 - 60_000).toISOString() }));
  let manifestCalls = 0;
  const fetch = async (url, options = {}) => {
    if (url.startsWith(SEARCH)) return { ok: true, status: 200, headers: {}, json: () => ({ total_count: 30, items }) };
    // raw and the CDN hang until the request's own timeout, then fail.
    if (url.includes("/kino-plugin.json")) manifestCalls++;
    clock += options.timeoutMs;
    throw new Error("timeout");
  };
  const state = { indexGeneratedAt: T0, indexReadAt: now0 - 2 * 3600_000, recommended: [], deltaFrom: now0 - 3600_000 };
  const r = await sync({ reason: "schedule", since: now0 - 3600_000, state }, { fetch, now: () => clock, shipped });
  assert.ok(clock - now0 <= BUDGET_MS + 1000, `took ${(clock - now0) / 1000} s of the ${BUDGET_MS / 1000} s budget`);
  assert.ok(manifestCalls < MAX_MANIFESTS, "not every manifest was tried");
  assert.equal(r.full, false);
  assert.equal(r.state.deltaFrom, now0 - 3600_000, "the window did not move past repos that were not read");
});
