import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_PINS, applyPins, holdPinned, keptPins, pinsOf, validPins } from "../src/pins.js";
import { DAY_MS, sync } from "../src/sync.js";

const T0 = Date.UTC(2026, 10, 24, 12, 0, 0);
const RAW_INDEX = "https://raw.githubusercontent.com/kinotvapp/kino-plugins/main/index.json";
const RAW_CATALOG = "https://raw.githubusercontent.com/kinotvapp/kino-plugins/main/catalog.json";
const RAW_PINS = "https://raw.githubusercontent.com/kinotvapp/kino-plugins/main/store-pins.json";
const CDN_PINS = "https://cdn.jsdelivr.net/gh/kinotvapp/kino-plugins@main/store-pins.json";
const SEARCH = "https://api.github.com/search/repositories";

const shipped = { index: { schema: 1, generatedAt: T0, entries: [] }, catalog: { schema: 1, plugins: [] } };
const entry = (id, popularity, extra = {}) => ({ address: `u/${id}`, id, name: id, categories: ["movies"], popularity, ...extra });
const pinDoc = (pins) => ({ schema: 1, pins });
/** Kino's order (popularity, then name): what the person sees. */
const shown = (entries) => [...entries].sort((a, b) => b.popularity - a.popularity || a.name.localeCompare(b.name)).map((e) => e.id);

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

const hourly = (now, extra = {}) => ({ reason: "schedule", since: now - 3600_000, state: { indexGeneratedAt: T0 - DAY_MS, indexReadAt: now - DAY_MS, recommended: [], ...extra } });
const list = ["a", "b", "c", "d", "e", "f"].map((id, i) => entry(id, 60000 - i * 1000));

test("a pinned plugin below its position moves up to it, the others keep their order", () => {
  const out = applyPins(list, pinsOf(pinDoc([{ address: "u/f", maxPosition: 3 }])));
  assert.deepEqual(shown(out), ["a", "b", "f", "c", "d", "e"]);
  assert.equal(out.length, list.length);
});

test("a pin never lowers a plugin that already ranks higher", () => {
  const out = applyPins(list, pinsOf(pinDoc([{ address: "u/a", maxPosition: 3 }])));
  assert.deepEqual(shown(out), ["a", "b", "c", "d", "e", "f"]);
  assert.equal(out[0].popularity, 60000);
});

test("several pins keep their relative order", () => {
  const out = applyPins(list, pinsOf(pinDoc([{ address: "u/f", maxPosition: 2 }, { address: "u/e", maxPosition: 2 }])));
  assert.deepEqual(shown(out), ["a", "e", "f", "b", "c", "d"]);
});

test("a pin holds against ties on the same popularity and on names that sort first", () => {
  const tied = [entry("aa", 5000), entry("ab", 5000), entry("ac", 5000), entry("zz", 4000)];
  assert.deepEqual(shown(applyPins(tied, pinsOf(pinDoc([{ address: "u/zz", maxPosition: 3 }])))).indexOf("zz") < 3, true);
});

test("a pin matches by address (any case) and, when it names one, by id too; a missing plugin is ignored", () => {
  assert.deepEqual(shown(applyPins(list, pinsOf(pinDoc([{ address: "U/F", id: "f", maxPosition: 1 }])))).slice(0, 1), ["f"]);
  assert.deepEqual(shown(applyPins(list, pinsOf(pinDoc([{ address: "u/f", id: "other", maxPosition: 1 }])))), shown(list));
  assert.deepEqual(shown(applyPins(list, pinsOf(pinDoc([{ address: "u/nope", maxPosition: 1 }])))), shown(list));
});

test("positions count within the pinned plugin's own tab (recommended rows apart)", () => {
  const mixed = [entry("r1", 90000, { recommended: true }), entry("r2", 80000, { recommended: true }), ...list];
  const out = applyPins(mixed, pinsOf(pinDoc([{ address: "u/f", maxPosition: 3 }])));
  assert.deepEqual(shown(out.filter((e) => !e.recommended)), ["a", "b", "f", "c", "d", "e"]);
  assert.deepEqual(shown(out.filter((e) => e.recommended)), ["r1", "r2"]);
});

test("a malformed pin file or pin is ignored, never trusted", () => {
  assert.equal(validPins({ schema: 2, pins: [] }), false);
  assert.equal(validPins(null), false);
  assert.deepEqual(pinsOf(pinDoc([
    { address: "u/a", maxPosition: 0 }, { address: "u/a", maxPosition: 1.5 }, { address: "no-slash", maxPosition: 1 },
    { address: "u/..", maxPosition: 1 }, { address: "u/a", id: "Bad Id", maxPosition: 1 }, null, { address: "u/ok", maxPosition: 2 },
  ])), [{ a: "u/ok", m: 2 }]);
  const many = Array.from({ length: 40 }, (_, i) => ({ address: `u/p${i}`, maxPosition: 1 }));
  assert.equal(pinsOf(pinDoc(many)).length, MAX_PINS);
  assert.equal(keptPins("x"), null);
  assert.equal(keptPins([{ a: "u/x" }]), null);
});

test("an hourly read applies the published pins and keeps them in state", async () => {
  const index = { schema: 1, generatedAt: T0, entries: list.map((e) => ({ ...e, popularity: 0 })) };
  const { fetch } = fakeFetch({
    [RAW_INDEX]: { body: index },
    [RAW_CATALOG]: { body: { schema: 1, plugins: [] } },
    [RAW_PINS]: { body: pinDoc([{ address: "u/f", id: "f", maxPosition: 1 }]) },
  });
  const r = await sync(hourly(T0), { fetch, now: () => T0, shipped });
  assert.equal(shown(r.entries)[0], "f");
  assert.deepEqual(r.state.pins, [{ a: "u/f", i: "f", m: 1 }]);
  assert.ok(Number.isFinite(r.state.pinned["u/f"]));
});

test("pins come from jsDelivr when raw fails, and from state when both fail; none at all is today's order", async () => {
  const index = { schema: 1, generatedAt: T0, entries: list };
  const base = { [RAW_INDEX]: { body: index }, [RAW_CATALOG]: { body: { schema: 1, plugins: [] } } };
  const cdn = await sync(hourly(T0), { fetch: fakeFetch({ ...base, [RAW_PINS]: { status: 500 }, [CDN_PINS]: { body: pinDoc([{ address: "u/e", maxPosition: 1 }]) } }).fetch, now: () => T0, shipped });
  assert.equal(shown(cdn.entries)[0], "e");
  const kept = await sync(hourly(T0, { pins: [{ a: "u/d", m: 1 }] }), { fetch: fakeFetch(base).fetch, now: () => T0, shipped });
  assert.equal(shown(kept.entries)[0], "d");
  const none = await sync(hourly(T0), { fetch: fakeFetch(base).fetch, now: () => T0, shipped });
  assert.deepEqual(shown(none.entries), shown(list));
  assert.equal(none.state.pins, undefined);
});

test("an empty pin list removes the pins kept in state", async () => {
  const index = { schema: 1, generatedAt: T0, entries: list };
  const { fetch } = fakeFetch({ [RAW_INDEX]: { body: index }, [RAW_CATALOG]: { body: { schema: 1, plugins: [] } }, [RAW_PINS]: { body: pinDoc([]) } });
  const r = await sync(hourly(T0, { pins: [{ a: "u/f", m: 1 }] }), { fetch, now: () => T0, shipped });
  assert.deepEqual(shown(r.entries), shown(list));
});

test("a delta keeps a pinned plugin that was just pushed at its pinned popularity", async () => {
  const now = T0 + 600_000;
  const { fetch } = fakeFetch({
    [SEARCH]: { body: { total_count: 1, items: [{ owner: { login: "u" }, name: "fresh", stargazers_count: 0, pushed_at: new Date(now - 1000).toISOString() }] } },
    "https://raw.githubusercontent.com/u/fresh/HEAD/kino-plugin.json": { body: { id: "fresh", name: "Fresh", version: "1.0.0" } },
  });
  const arg = { reason: "schedule", since: now - 600_000, state: { indexGeneratedAt: T0, indexReadAt: now - 60_000, recommended: [], deltaFrom: now - 600_000, pins: [{ a: "u/fresh", m: 1 }], pinned: { "u/fresh": 600000.5 } } };
  const r = await sync(arg, { fetch, now: () => now, shipped });
  assert.equal(r.full, false);
  assert.equal(r.entries[0].popularity, 600000.5);
  assert.deepEqual(holdPinned([entry("x", 5)], null)[0].popularity, 5);
});
