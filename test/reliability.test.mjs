import assert from "node:assert/strict";
import { test } from "node:test";

import { NEUTRAL_SCORE, STALE_MS, STATE_MAX_CHARS, freshScores, popularityOf, rank, scoresOf, validReliability } from "../src/reliability.js";
import { DAY_MS, sync } from "../src/sync.js";

const T0 = Date.UTC(2026, 10, 14, 12, 0, 0);
const RAW_INDEX = "https://raw.githubusercontent.com/kinotvapp/kino-plugins/main/index.json";
const RAW_CATALOG = "https://raw.githubusercontent.com/kinotvapp/kino-plugins/main/catalog.json";
const RAW_REL = "https://raw.githubusercontent.com/kinotvapp/kino-plugins/main/reliability.json";
const CDN_REL = "https://cdn.jsdelivr.net/gh/kinotvapp/kino-plugins@main/reliability.json";

const shipped = { index: { schema: 1, generatedAt: T0, entries: [] }, catalog: { schema: 1, plugins: [] } };
const entry = (id, stars) => ({ address: `u/${id}`, id, name: id, categories: ["movies"], popularity: stars });

function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return { ok: false, status: 404, headers: {}, text: () => "", json: () => { throw new Error("no body"); } };
    const r = routes[key];
    return { ok: (r.status ?? 200) < 300, status: r.status ?? 200, headers: {}, text: () => JSON.stringify(r.body), json: () => r.body };
  };
  return { fetch, calls };
}

const rel = (plugins, generatedAt = T0) => ({ schema: 1, generatedAt, plugins });
const hourly = (now, extra = {}) => ({ reason: "schedule", since: now - 3600_000, state: { indexGeneratedAt: T0 - DAY_MS, indexReadAt: now - DAY_MS, recommended: [], ...extra } });

test("the score decides the order and the stars only break ties", () => {
  assert.ok(popularityOf(0, 99) > popularityOf(999, 98.9));
  assert.ok(popularityOf(10, 80) > popularityOf(5, 80));
  assert.equal(popularityOf(50000, 50), popularityOf(999, 50), "stars are capped so they can never outweigh a score step");
});

test("an unrated plugin counts as neutral: above the failing ones, below the proven ones", () => {
  const order = rank([entry("bad", 100), entry("new", 0), entry("good", 0)], { s: { bad: 20, good: 95 } }).sort((a, b) => b.popularity - a.popularity).map((e) => e.id);
  assert.deepEqual(order, ["good", "new", "bad"]);
  assert.equal(popularityOf(0, undefined), NEUTRAL_SCORE * 10 * 1000);
});

test("without ratings the order is the stars, as before", () => {
  const order = rank([entry("a", 3), entry("b", 40)], null).sort((x, y) => y.popularity - x.popularity).map((e) => e.id);
  assert.deepEqual(order, ["b", "a"]);
});

test("a malformed or out-of-range score is ignored, never trusted", () => {
  const { s } = scoresOf(rel([{ id: "ok", score: 80 }, { id: "nan", score: NaN }, { id: "big", score: 1000 }, { id: "Bad Id", score: 50 }, { id: "nul", score: null }]));
  assert.deepEqual(s, { ok: 80 });
  assert.equal(validReliability({ schema: 2, generatedAt: 1, plugins: [] }), false);
  assert.equal(validReliability(null), false);
});

test("scores kept in state stay within their budget", () => {
  const many = Array.from({ length: 2000 }, (_, i) => ({ id: `plugin-number-${i}`, score: 50 }));
  assert.ok(JSON.stringify(scoresOf(rel(many)).s).length <= STATE_MAX_CHARS + 200);
});

test("a rating older than 14 days is ignored", () => {
  const r = scoresOf(rel([{ id: "a", score: 90 }], T0));
  assert.ok(freshScores(r, T0 + STALE_MS));
  assert.equal(freshScores(r, T0 + STALE_MS + 1), null);
  assert.equal(freshScores({ at: "x", s: {} }, T0), null);
});

test("the hourly full sync ranks the list by reliability and keeps the scores in state", async () => {
  const now = T0 + 1000;
  const index = { schema: 1, generatedAt: T0, entries: [entry("steady", 1), entry("flaky", 500)] };
  const { fetch } = fakeFetch({ [RAW_INDEX]: { body: index }, [RAW_CATALOG]: { body: shipped.catalog }, [RAW_REL]: { body: rel([{ id: "steady", score: 97.4 }, { id: "flaky", score: 12 }]) } });
  const r = await sync(hourly(now), { fetch, now: () => now, shipped });
  const pop = Object.fromEntries(r.entries.map((e) => [e.id, e.popularity]));
  assert.ok(pop.steady > pop.flaky);
  assert.deepEqual(r.state.rel.s, { flaky: 12, steady: 97.4 });
  assert.ok(JSON.stringify(r.state).length < 16384);
});

test("jsDelivr answers when raw has no ratings", async () => {
  const now = T0 + 1000;
  const index = { schema: 1, generatedAt: T0, entries: [entry("a", 0)] };
  const { fetch, calls } = fakeFetch({ [RAW_INDEX]: { body: index }, [RAW_CATALOG]: { body: shipped.catalog }, [RAW_REL]: { status: 404, body: {} }, [CDN_REL]: { body: rel([{ id: "a", score: 90 }]) } });
  const r = await sync(hourly(now), { fetch, now: () => now, shipped });
  assert.equal(r.entries[0].popularity, 900000);
  assert.ok(calls.indexOf(CDN_REL) > calls.indexOf(RAW_REL));
});

test("when the ratings cannot be read the ones in state are kept: the order does not flip back to stars", async () => {
  const now = T0 + 1000;
  const index = { schema: 1, generatedAt: T0, entries: [entry("a", 0), entry("b", 900)] };
  const { fetch } = fakeFetch({ [RAW_INDEX]: { body: index }, [RAW_CATALOG]: { body: shipped.catalog } });
  const r = await sync(hourly(now, { rel: { at: T0 - DAY_MS, s: { a: 95, b: 10 } } }), { fetch, now: () => now, shipped });
  const pop = Object.fromEntries(r.entries.map((e) => [e.id, e.popularity]));
  assert.ok(pop.a > pop.b);
});

test("a sync with no ratings anywhere still succeeds (the first start, or a repo without reliability.json yet)", async () => {
  const now = T0 + 1000;
  const index = { schema: 1, generatedAt: T0, entries: [entry("a", 7)] };
  const { fetch } = fakeFetch({ [RAW_INDEX]: { body: index }, [RAW_CATALOG]: { body: shipped.catalog } });
  const r = await sync(hourly(now), { fetch, now: () => now, shipped });
  assert.equal(r.full, true);
  assert.equal(r.entries[0].popularity, 550007);
  assert.equal(r.state.rel, undefined);
});

test("a delta ranks the new rows with the ratings kept in state", async () => {
  const now = T0 + 1000;
  const SEARCH = "https://api.github.com/search/repositories";
  const manifest = { id: "fresh", name: "Fresh", description: "x", version: "1.0.0", categories: ["movies"] };
  const { fetch } = fakeFetch({
    [SEARCH]: { body: { total_count: 1, items: [{ name: "kino-plugin-fresh", owner: { login: "u" }, stargazers_count: 4, pushed_at: new Date(T0).toISOString(), fork: false }] } },
    "https://raw.githubusercontent.com/u/kino-plugin-fresh/HEAD/kino-plugin.json": { body: manifest },
  });
  const state = { indexGeneratedAt: T0 - 1000, indexReadAt: now - 10 * 60_000, recommended: [], rel: { at: T0, s: { fresh: 88 } } };
  const r = await sync({ reason: "schedule", since: T0 - 60_000, state }, { fetch, now: () => now, shipped });
  assert.equal(r.full, false);
  assert.equal(r.entries[0].popularity, 880004);
  assert.deepEqual(r.state.rel, state.rel, "the ratings survive the delta");
});

// ---- rank + prior (1.0.9) ----

test("the file's `rank` wins over its `score`, and an older file with only `score` still works", () => {
  const { s } = scoresOf(rel([{ id: "new", score: 99, rank: 80 }, { id: "old", score: 70 }]));
  assert.deepEqual(s, { new: 80, old: 70 });
});

test("an unrated plugin counts as the file's prior, not the built-in neutral", () => {
  const doc = { ...rel([{ id: "a", score: 90, rank: 90 }]), prior: 69.8 };
  const r = scoresOf(doc);
  assert.equal(r.p, 69.8);
  const [a, none] = rank([entry("a", 0), entry("zzz", 0)], r);
  assert.equal(a.popularity, 900000);
  assert.equal(none.popularity, 698000, "no value for it: the prior");
  assert.equal(popularityOf(0, undefined, 69.8), 698000);
});

test("values equal to the prior are not stored: they are the default", () => {
  const { s, p } = scoresOf({ ...rel([{ id: "flat", rank: 69.8 }, { id: "up", rank: 90 }]), prior: 69.8 });
  assert.equal(p, 69.8);
  assert.deepEqual(s, { up: 90 });
});

test("a bad prior is ignored and the built-in neutral applies", () => {
  for (const prior of [-1, 101, NaN, "70", null]) {
    const r = scoresOf({ ...rel([{ id: "a", rank: 90 }]), prior });
    assert.equal(r.p, undefined);
    assert.equal(rank([entry("x", 0)], r)[0].popularity, NEUTRAL_SCORE * 10 * 1000);
  }
});

test("a many-plugin file with a prior fits the state budget", () => {
  const plugins = Array.from({ length: 600 }, (_, i) => ({ id: `some-plugin-${i}`, rank: 40 + (i % 50) }));
  const r = scoresOf({ ...rel(plugins), prior: 69.8 });
  assert.ok(JSON.stringify(r).length <= STATE_MAX_CHARS + 300);
});

test("the sync ranks by `rank` with the prior as neutral for plugins the file leaves out", async () => {
  const now = T0 + 1000;
  const index = { schema: 1, generatedAt: T0, entries: [entry("tiny-clean", 0), entry("big-solid", 0), entry("unlisted", 0)] };
  const doc = { ...rel([{ id: "tiny-clean", score: 94, rank: 70.5 }, { id: "big-solid", score: 93, rank: 92 }]), prior: 69.8 };
  const { fetch } = fakeFetch({ [RAW_INDEX]: { body: index }, [RAW_CATALOG]: { body: shipped.catalog }, [RAW_REL]: { body: doc } });
  const r = await sync(hourly(now), { fetch, now: () => now, shipped });
  const pop = Object.fromEntries(r.entries.map((e) => [e.id, e.popularity]));
  assert.ok(pop["big-solid"] > pop["tiny-clean"]);
  assert.ok(pop["tiny-clean"] > pop.unlisted, "70.5 is above the prior 69.8");
  assert.equal(pop.unlisted, 698000);
  assert.equal(r.state.rel.p, 69.8);
});
