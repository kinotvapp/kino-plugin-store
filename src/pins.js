// Pinned positions. `store-pins.json` (schema 1, published next to index.json) lets the owner keep a plugin within the first
// places of its list without a new store version:
//
//   { "schema": 1, "pins": [ { "address": "owner/repo", "id": "plugin-id", "maxPosition": 3 } ] }
//
// After the reliability ranking, each pinned entry that sits lower than its `maxPosition` is moved up to it; one that already
// ranks higher stays where it is (a pin only lifts, never lowers). Kino orders by `popularity`, so the move is a popularity just
// above the entry it passes. A pin matches by `address` (owner/repo, any case), and also by `id` when the pin names one, so a repo
// that merely reuses an id never takes the place. Positions count within the entry's own tab: Kino shows the recommended rows
// ("De Kino") apart from the rest ("De la comunidad"). Hidden rows (blocklist, 18+) ahead of a pin only lift it further, and a
// category or a search shows a subset in the same order, so the pin holds there too; the "recent" sort ignores popularity.
// A pin whose plugin is not in the list is ignored. An empty `pins` removes every pin.

export const PINS_MAX_BYTES = 16 * 1024;
/** At most this many pins are read (the rest of the file is ignored): they live in `state`, which Kino caps at 16 KB. */
export const MAX_PINS = 10;
/** The deepest position a pin can ask for. */
export const MAX_POSITION = 50;

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const validPins = (b) => !!b && b.schema === 1 && Array.isArray(b.pins);

/** The compact `[{ a, i?, m }]` of [doc] (address key, id, max position), as `state` keeps it; malformed pins are dropped. */
export function pinsOf(doc) {
  const out = [];
  const seen = new Set();
  for (const p of doc.pins) {
    if (out.length >= MAX_PINS) break;
    if (!p || typeof p !== "object" || typeof p.address !== "string" || !REPO.test(p.address)) continue;
    if (p.address.split("/").some((s) => s === "." || s === "..")) continue;
    if (!Number.isInteger(p.maxPosition) || p.maxPosition < 1 || p.maxPosition > MAX_POSITION) continue;
    if (p.id !== undefined && (typeof p.id !== "string" || !ID.test(p.id))) continue;
    const a = p.address.toLowerCase();
    if (seen.has(a)) continue;
    seen.add(a);
    out.push({ a, ...(p.id !== undefined ? { i: p.id } : {}), m: p.maxPosition });
  }
  return out;
}

/** [pins] (the compact list kept in state) when it is well-formed, else null. */
export function keptPins(pins) {
  if (!Array.isArray(pins)) return null;
  const ok = pins.every((p) => p && typeof p.a === "string" && Number.isInteger(p.m) && p.m >= 1 && (p.i === undefined || typeof p.i === "string"));
  return ok ? pins : null;
}

const keyOf = (e) => String(e.address ?? e.stremio ?? e.id).toLowerCase();
const nameOf = (e) => String(e.name ?? "").toLowerCase();

/** Kino's order of a list: popularity, highest first, then the name (case ignored), then the key. */
const kinoOrder = (x, y) => y.popularity - x.popularity || (nameOf(x) < nameOf(y) ? -1 : nameOf(x) > nameOf(y) ? 1 : 0) || (keyOf(x) < keyOf(y) ? -1 : keyOf(x) > keyOf(y) ? 1 : 0);

const matches = (pin, e) => typeof e.address === "string" && e.address.toLowerCase() === pin.a && (pin.i === undefined || e.id === pin.i);

/** One tab's [list] (already in Kino's order) with its [pins] applied; changes the popularity of the entries it moves. */
function pinTab(list, pins) {
  const found = [];
  for (const pin of pins) {
    const at = list.findIndex((e) => matches(pin, e));
    if (at >= 0) found.push({ pin, at });
  }
  // The pins in their current order: an earlier pin is placed first and a later one never passes it.
  found.sort((x, y) => x.at - y.at);
  let placed = -1;
  found.forEach(({ pin }, k) => {
    const at = list.findIndex((e) => matches(pin, e));
    const target = Math.min(at, Math.max(pin.m - 1, placed + 1));
    if (target < at) {
      const [moved] = list.splice(at, 1);
      const passed = list[target];
      // Base popularities are whole numbers: a fraction above the passed entry sits below the next whole number, and an
      // earlier pin (which got a larger fraction) stays ahead of a later one on the same number.
      list.splice(target, 0, { ...moved, popularity: Math.floor(passed.popularity) + 0.5 / (k + 1) });
    }
    placed = list.findIndex((e) => matches(pin, e));
  });
  return list;
}

/** [entries] (ranked) with the [pins] applied; with no pins the same entries. */
export function applyPins(entries, pins) {
  if (!pins || pins.length === 0) return entries;
  const featured = pinTab(entries.filter((e) => e.recommended === true).sort(kinoOrder), pins);
  const community = pinTab(entries.filter((e) => e.recommended !== true).sort(kinoOrder), pins);
  const byKey = new Map([...featured, ...community].map((e) => [keyOf(e), e]));
  return entries.map((e) => byKey.get(keyOf(e)) ?? e);
}

/** The `{ addressKey: popularity }` of the pinned entries of a full list: what a delta keeps them at until the next full read. */
export function pinnedPopularity(entries, pins) {
  const out = {};
  if (!pins) return out;
  for (const e of entries) if (pins.some((p) => matches(p, e))) out[e.address.toLowerCase()] = e.popularity;
  return out;
}

/** A delta's [entries] with each pinned one kept at least at the popularity the last full list gave it ([held]). */
export function holdPinned(entries, held) {
  if (!held || typeof held !== "object") return entries;
  return entries.map((e) => {
    const k = typeof e.address === "string" ? e.address.toLowerCase() : null;
    const v = k && Object.hasOwn(held, k) ? held[k] : undefined;
    return Number.isFinite(v) && v > e.popularity ? { ...e, popularity: v } : e;
  });
}
