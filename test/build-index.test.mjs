import assert from "node:assert/strict";
import { test } from "node:test";

import { buildIndex } from "../tools/build-index.mjs";

const json = (body, headers = {}) => new Response(JSON.stringify(body), { status: 200, headers });
const repo = (full, extra = {}) => ({ full_name: full, owner: { login: full.split("/")[0] }, name: full.split("/")[1], stargazers_count: 3, pushed_at: "2026-10-01T00:00:00Z", fork: false, ...extra });
const manifest = (id, extra = {}) => ({ id, name: id.toUpperCase(), version: "1.0.0", capabilities: ["search", "resolve"], ...extra });
const noSleep = async () => {};

/** A fake network: `search(url)` answers the API, `files` maps "owner/repo" to a manifest (or a status number). */
function network({ search, files = {}, stremio = {} }) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = new URL(url);
    if (u.hostname === "api.github.com") return search(u);
    if (u.hostname === "raw.githubusercontent.com") {
      const key = u.pathname.split("/").slice(1, 3).join("/");
      const f = files[key];
      if (typeof f === "number" || f === undefined) return new Response("", { status: f ?? 404 });
      return json(f);
    }
    const s = stremio[String(url)];
    return s ? json(s) : new Response("", { status: 500 });
  };
  return { fetch, calls };
}

const NOW = Date.parse("2026-10-29T12:00:00Z");
const base = { token: "T", now: () => NOW, sleep: noSleep, catalog: { schema: 1, plugins: [] } };

test("walks every page, splits by created: ranges past 1000 results", async () => {
  const searches = [];
  const net = network({
    search: (u) => {
      const q = u.searchParams.get("q");
      const page = Number(u.searchParams.get("page"));
      searches.push({ q, page });
      if (q.includes("created:2008-01-01T00:00:00Z..2026-10-29T12:00:00Z")) return json({ total_count: 1500, items: [] });
      const early = q.includes("created:2008") ;
      // The first half holds 250 repos over three pages, the second 1 repo.
      if (early) {
        const n = page === 3 ? 50 : 100;
        return json({ total_count: 250, items: Array.from({ length: n }, (_, i) => repo(`o/early-${page}-${i}`)) });
      }
      return json({ total_count: 1, items: [repo("o/late")] });
    },
    files: {},
  });
  await buildIndex({ ...base, fetch: net.fetch });
  const withRange = searches.filter((s) => s.q.includes("created:"));
  assert.ok(withRange.length >= 2, "the range was split");
  assert.ok(searches.some((s) => s.page === 3), "later pages were walked");
  assert.ok(searches.every((s) => s.q.includes("topic:kino-plugin") && s.q.includes("fork:false")));
  const apiCalls = net.calls.filter((c) => c.url.startsWith("https://api.github.com/"));
  assert.ok(apiCalls.every((c) => c.init.headers.Authorization === "Bearer T"));
  assert.ok(apiCalls.every((c) => new URL(c.url).searchParams.get("per_page") === "100"));
});

test("reads each manifest, drops discoverable false and forks", async () => {
  const net = network({
    search: () => json({ total_count: 5, items: [repo("a/good"), repo("a/hidden"), repo("a/forked", { fork: true }), repo("a/broken"), repo("a/gone")] }),
    files: { "a/good": manifest("good"), "a/hidden": manifest("hidden", { discoverable: false }), "a/forked": manifest("forked"), "a/broken": { id: "!!" }, "a/gone": 404 },
  });
  const index = await buildIndex({ ...base, fetch: net.fetch });
  assert.deepEqual(index.entries.map((e) => e.address), ["a/good"]);
  assert.equal(index.entries[0].popularity, 3);
  assert.equal(index.entries[0].updatedAt, Date.parse("2026-10-01T00:00:00Z"));
});

test("writes index.json with generatedAt and entries sorted by address", async () => {
  const net = network({
    search: () => json({ total_count: 3, items: [repo("z/last"), repo("b/mid"), repo("a/first")] }),
    files: { "z/last": manifest("last"), "b/mid": manifest("mid", { screen: { adult: true }, signature: { authorKey: "a".repeat(64) } }), "a/first": manifest("first") },
  });
  const index = await buildIndex({ ...base, fetch: net.fetch });
  assert.equal(index.schema, 1);
  assert.equal(index.generatedAt, NOW);
  assert.deepEqual(index.entries.map((e) => e.address), ["a/first", "b/mid", "z/last"]);
  const mid = index.entries[1];
  assert.ok(mid.categories.includes("adult"));
  assert.equal(mid.signed, true);
  assert.equal(mid.authorKey, "a".repeat(64));
});

test("recommended catalog entries are included; unnamed Stremio addons get their live name, else the fixed one", async () => {
  const live = "https://live.example/manifest.json";
  const dead = "https://dead.example/manifest.json";
  const net = network({
    search: () => json({ total_count: 0, items: [] }),
    stremio: { [live]: { name: "Cinemeta Live" } },
  });
  const catalog = { schema: 1, plugins: [{ id: "cinemeta", stremio: live }, { id: "radios", stremio: dead }, { id: "own", stremio: "https://x.example/manifest.json", name: "Kept" }, { id: "internet-archive", repo: "k/archive", name: "Archive" }] };
  const index = await buildIndex({ ...base, catalog, fetch: net.fetch });
  const byId = Object.fromEntries(index.entries.map((e) => [e.id, e]));
  assert.equal(byId.cinemeta.name, "Cinemeta Live");
  assert.equal(byId.radios.name, "Radios");
  assert.equal(byId.own.name, "Kept");
  assert.equal(byId["internet-archive"].recommended, true);
  assert.ok(!net.calls.some((c) => c.url === "https://x.example/manifest.json"), "named addons are not fetched");
});

test("backs off on 429 with Retry-After and on 403 with X-RateLimit-Reset", async () => {
  const sleeps = [];
  let n = 0;
  const net = network({
    search: () => {
      n += 1;
      if (n === 1) return new Response("", { status: 429, headers: { "Retry-After": "7" } });
      if (n === 2) return new Response("", { status: 403, headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(NOW / 1000 + 30) } });
      return json({ total_count: 0, items: [] });
    },
  });
  await buildIndex({ ...base, fetch: net.fetch, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(sleeps[0], 7000);
  assert.ok(sleeps[1] >= 30000 && sleeps[1] <= 32000);
  assert.equal(n, 3);
});

test("a transient manifest failure is retried; a 404 is skipped", async () => {
  let hits = 0;
  const net = network({ search: () => json({ total_count: 2, items: [repo("a/flaky"), repo("a/none")] }), files: { "a/none": 404 } });
  const fetch = async (url, init) => {
    if (String(url).includes("a/flaky")) {
      hits += 1;
      if (hits < 3) return hits === 1 ? new Response("", { status: 503 }) : Promise.reject(new Error("socket hang up"));
      return json(manifest("flaky"));
    }
    return net.fetch(url, init);
  };
  const index = await buildIndex({ ...base, fetch });
  assert.deepEqual(index.entries.map((e) => e.address), ["a/flaky"]);
  assert.equal(hits, 3);
});

test("too many unreadable manifests fail the run instead of writing a short list", async () => {
  const items = Array.from({ length: 10 }, (_, i) => repo(`a/r${i}`));
  const files = Object.fromEntries(items.map((r, i) => [r.full_name, i < 2 ? 500 : manifest(`r${i}`)]));
  const net = network({ search: () => json({ total_count: 10, items }), files });
  await assert.rejects(buildIndex({ ...base, fetch: net.fetch }), /could not be read/);
});

test("incomplete search results are asked again, and fail the run if they stay incomplete", async () => {
  let n = 0;
  const ok = network({ search: () => (++n === 1 ? json({ total_count: 1, incomplete_results: true, items: [] }) : json({ total_count: 1, incomplete_results: false, items: [repo("a/x")] })), files: { "a/x": manifest("xxx") } });
  assert.deepEqual((await buildIndex({ ...base, fetch: ok.fetch })).entries.map((e) => e.address), ["a/x"]);
  const bad = network({ search: () => json({ total_count: 1, incomplete_results: true, items: [] }) });
  await assert.rejects(buildIndex({ ...base, fetch: bad.fetch }), /incomplete_results/);
});

test("a range over 1000 splits down to hours, then fails loudly", async () => {
  const q = [];
  const net = network({ search: (u) => { q.push(u.searchParams.get("q")); return json({ total_count: 5000, items: [] }); } });
  await assert.rejects(buildIndex({ ...base, fetch: net.fetch }), /under an hour/);
  assert.ok(q.some((s) => /T\d\d:\d\d:\d\dZ\.\./.test(s)), "ranges carry times");
});

test("a hung request is aborted by the timeout", async () => {
  const fetch = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  await assert.rejects(buildIndex({ ...base, fetch, timeoutMs: 10 }), /aborted/);
});

const fakeRes = (status, text) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(), text });
const searchOf = (names) => json({ total_count: names.length, items: names.map((n) => repo(n)) });

test("a 200 whose body read errors is retried", async () => {
  let reads = 0;
  const fetch = async (url) => {
    if (new URL(url).hostname === "api.github.com") return searchOf(["a/trunc"]);
    return fakeRes(200, async () => { if (++reads < 3) throw new Error("terminated"); return JSON.stringify(manifest("trunc")); });
  };
  const index = await buildIndex({ ...base, fetch });
  assert.deepEqual(index.entries.map((e) => e.address), ["a/trunc"]);
  assert.equal(reads, 3);
});

test("a body that keeps failing to read counts toward the guard", async () => {
  const names = Array.from({ length: 5 }, (_, i) => `a/r${i}`);
  const fetch = async (url) => {
    if (new URL(url).hostname === "api.github.com") return searchOf(names);
    return fakeRes(200, async () => { throw new Error("terminated"); });
  };
  await assert.rejects(buildIndex({ ...base, fetch }), /could not be read/);
});

test("a stalled body hits the timeout", async () => {
  const fetch = async (url, init) => {
    if (new URL(url).hostname === "api.github.com") return searchOf(["a/slow"]);
    return fakeRes(200, () => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))));
  };
  await assert.rejects(buildIndex({ ...base, fetch, timeoutMs: 10 }), /could not be read/);
});

test("a 200 with invalid JSON is skipped and not counted", async () => {
  const fetch = async (url) => {
    if (new URL(url).hostname === "api.github.com") return searchOf(["a/bad"]);
    return fakeRes(200, async () => "{ not json");
  };
  const index = await buildIndex({ ...base, fetch });
  assert.deepEqual(index.entries, []);
});

test("a repo that reuses a recommended id, or the store's own id, is not in the index", async () => {
  const net = network({
    search: () => json({ total_count: 3, items: [repo("kinotvapp/kino-plugin-own-server"), repo("Ericktz/kino-plugin-sports-live"), repo("evil/store")] }),
    files: { "kinotvapp/kino-plugin-own-server": manifest("own-server"), "Ericktz/kino-plugin-sports-live": manifest("own-server"), "evil/store": manifest("kino-plugins") },
  });
  const catalog = { schema: 1, plugins: [{ id: "own-server", repo: "kinotvapp/kino-plugin-own-server", name: "Own server" }] };
  const index = await buildIndex({ ...base, catalog, fetch: net.fetch });
  assert.deepEqual(index.entries.map((e) => e.address), ["kinotvapp/kino-plugin-own-server"]);
});

test("repos on the community blocklist are left out of the index", async () => {
  const { filterBlocked } = await import("../tools/build-index.mjs");
  const net = network({
    search: () => json({ total_count: 2, items: [repo("Bad/Repo"), repo("a/good")] }),
    files: { "Bad/Repo": manifest("bad"), "a/good": manifest("good") },
  });
  const blocklist = { schema: 1, entries: [{ repo: "bad/repo", reason: "claim", date: "2026-10-01" }] };
  const index = await buildIndex({ ...base, blocklist, fetch: net.fetch });
  assert.deepEqual(index.entries.map((e) => e.address), ["a/good"]);
  // The same filter, for an index already built (the shipped copy).
  const kept = filterBlocked({ schema: 1, generatedAt: 1, entries: [{ address: "BAD/repo", id: "bad", name: "B" }, { stremio: "https://x/manifest.json", id: "s", name: "S" }] }, blocklist);
  assert.deepEqual(kept.entries.map((e) => e.id), ["s"]);
});
