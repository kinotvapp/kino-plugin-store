import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { categoriesOfManifest, entriesOfCatalog, entryOfManifest } from "../src/entries.js";

const shipped = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));

test("categories mirror Kino's: the manifest's own, else a guess from its capabilities", () => {
  assert.deepEqual(categoriesOfManifest({ categories: ["anime", "nope", "anime", "adult"], capabilities: ["channels"] }), ["anime", "adult"]);
  assert.deepEqual(categoriesOfManifest({ capabilities: ["search", "resolve", "episodes", "channels"] }), ["movies", "series", "live"]);
  assert.deepEqual(categoriesOfManifest({ catalogOnly: true, capabilities: ["meta", "resolve", "search"] }), ["utilities"]);
  assert.deepEqual(categoriesOfManifest({ capabilities: ["tracking"] }), ["utilities"]);
  assert.deepEqual(categoriesOfManifest({ capabilities: ["subtitles"] }), []);
});

test("an 18+ screen makes the entry adult, so the 18+ gate sees it", () => {
  const e = entryOfManifest({ owner: "x", repo: "y", stars: 0, pushedAt: null }, { id: "night", name: "Night", capabilities: ["screen"], screen: { adult: true } });
  assert.deepEqual(e.categories, ["adult"]);
});

test("an icon outside the repository is never sent", () => {
  const e = entryOfManifest({ owner: "x", repo: "y", stars: 0, pushedAt: null }, { id: "abc", name: "Abc", capabilities: [], icon: "../evil.png" });
  assert.equal(e.icon, undefined);
});

test("a manifest without a valid id or name is no entry", () => {
  assert.equal(entryOfManifest({ owner: "x", repo: "y", stars: 0, pushedAt: null }, { id: "A!", name: "n" }), null);
  assert.equal(entryOfManifest({ owner: "x", repo: "y", stars: 0, pushedAt: null }, { id: "abc" }), null);
});

test("catalog entries are recommended, with their hints", () => {
  const out = entriesOfCatalog({ schema: 1, plugins: [
    { id: "own", repo: "kinotvapp/kino-plugin-own-server", name: "Tu servidor", needsSetup: true, signed: true, authorKey: "c".repeat(64), requires: ["x"], legacyDefault: true },
    { id: "bad", repo: "not a repo", name: "Bad" },
  ] });
  assert.deepEqual(out, [{
    address: "kinotvapp/kino-plugin-own-server", id: "own", name: "Tu servidor", recommended: true,
    needsSetup: true, signed: true, authorKey: "c".repeat(64), requires: ["x"],
  }]);
});

test("an unnamed Stremio addon is named, never dropped; an unknown one by its id", () => {
  const out = entriesOfCatalog({ schema: 1, plugins: [
    { id: "subsense", stremio: "https://subsense.nepiraw.com/manifest.json" },
    { id: "brand-new-addon", stremio: "https://x.example/manifest.json" },
  ] });
  assert.deepEqual(out.map((e) => e.name), ["SubSense", "Brand New Addon"]);
});

test("the shipped copies have the shapes the store reads", () => {
  const index = shipped("index.json");
  assert.equal(index.schema, 1);
  assert.ok(Number.isFinite(index.generatedAt) && index.generatedAt > 0);
  assert.ok(Array.isArray(index.entries));
  for (const e of index.entries) assert.ok(e.address && e.id && e.name, JSON.stringify(e));
  const catalog = shipped("catalog.json");
  assert.equal(catalog.schema, 1);
  assert.ok(entriesOfCatalog(catalog).length > 0);
  // Inside Kino's repository the store's catalog is the app's seed: one file, two copies in step (published alone, no app).
  const seed = new URL("../../../app/src/main/assets/plugin-catalog-seed.json", import.meta.url);
  if (existsSync(seed)) assert.deepEqual(catalog, JSON.parse(readFileSync(seed, "utf8")));
});

test("mergeFull keeps one repo per id: the recommended one, else the first by address; never Kino Plugins' own id", async () => {
  const { mergeFull } = await import("../src/entries.js");
  const index = [
    { address: "Ericktz/kino-plugin-sports-live", id: "own-server", name: "Sports" },
    { address: "kinotvapp/kino-plugin-own-server", id: "own-server", name: "Own", popularity: 1 },
    { address: "brNXBT/kino-plugin-frame", id: "framextv", name: "Frame B", popularity: 9 },
    { address: "baskettv23/Framextv", id: "framextv", name: "Frame A", popularity: 1 },
    { address: "evil/store", id: "kino-plugins", name: "Fake store" },
    { address: "ana/fine", id: "fine", name: "Fine" },
  ];
  const recommended = [{ address: "kinotvapp/kino-plugin-own-server", id: "own-server", name: "Own server", recommended: true }];
  const out = mergeFull(index, recommended);
  assert.deepEqual(out.map((e) => e.address).sort(), ["ana/fine", "baskettv23/Framextv", "kinotvapp/kino-plugin-own-server"]);
});

test("the shipped index carries one repo per id and never the store's own id", () => {
  const ids = new Map();
  for (const e of shipped("index.json").entries) {
    assert.notEqual(e.id, "kino-plugins");
    assert.ok(!ids.has(e.id), `${e.id} listed for ${ids.get(e.id)} and ${e.address ?? e.stremio}`);
    ids.set(e.id, e.address ?? e.stremio);
  }
});
