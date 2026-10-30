// What the store hands Kino: StoreEntry objects (contract.json kinoStore.entryFields) built from a plugin's manifest, from
// Kino's curated catalog.json, and from the daily index.json. Kino re-checks every entry and every hint at install: these
// only describe what to show.
import { stremioName } from "./stremio-names.js";

/** MarketCategory ids, in Kino's order. */
export const CATEGORIES = ["movies", "series", "anime", "live", "radio", "subtitles", "utilities", "adult"];

const ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const KEY_HEX = /^[0-9a-f]{64}$/;
// Kino Social's own handle shape (`_check_handle` on the backend): letters, digits, underscore, 3 to 20 characters.
const KINO_SOCIAL_USER = /^[A-Za-z0-9_]{3,20}$/;
const RAW = "https://raw.githubusercontent.com";

const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === "string") : []);
const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The address key two lists compare by: owner/repo lowercased (GitHub names are case-insensitive). */
export const keyOf = (address) => String(address).toLowerCase();

/**
 * What a plugin offers, as Kino's `categoriesOfManifest` derives it: the manifest's own `categories` when it gives any (known
 * ids, order kept, no repeats), else a guess from its capabilities. An 18+ screen (`screen.adult`) adds `adult`, so Kino's
 * 18+ gate hides the entry while the code is locked.
 */
export function categoriesOfManifest(m) {
  const own = strings(m.categories).map((c) => c.trim()).filter((c) => CATEGORIES.includes(c));
  let out;
  if (own.length > 0) {
    out = [...new Set(own)];
  } else {
    const caps = new Set(strings(m.capabilities));
    const lists = caps.has("search") || caps.has("home") || caps.has("browse");
    out = [];
    if (m.catalogOnly === true && (lists || caps.has("meta"))) out.push("utilities");
    else if (caps.has("resolve") && lists) out.push("movies");
    if (caps.has("episodes")) out.push("series");
    if (caps.has("channels")) out.push("live");
    if ((caps.has("tracking") || caps.has("segments")) && !out.includes("utilities")) out.push("utilities");
  }
  if (m.screen && m.screen.adult === true && !out.includes("adult")) out.push("adult");
  return out;
}

/** A path inside the repository (no scheme, no leading slash, no `.` or `..` segment), or null. */
function repoPath(p) {
  if (typeof p !== "string" || !p || p.startsWith("/") || p.includes("\\") || /^[a-z][a-z0-9+.-]*:/i.test(p)) return null;
  return p.split("/").every((s) => s && s !== "." && s !== "..") ? p : null;
}

/**
 * The entry of the plugin at `owner/repo` whose `kino-plugin.json` is [m]; null when it is no plugin Kino could list (no
 * valid id or name, or `"discoverable": false`). [repo] carries GitHub's facts: `stars` and `pushedAt` (an ISO date or null).
 */
export function entryOfManifest(repo, m) {
  if (!m || typeof m !== "object" || m.discoverable === false) return null;
  const id = typeof m.id === "string" && ID.test(m.id) ? m.id : null;
  const name = text(m.name);
  if (!id || !name) return null;
  const address = `${repo.owner}/${repo.repo}`;
  const icon = repoPath(m.icon);
  const updatedAt = repo.pushedAt ? Date.parse(repo.pushedAt) : NaN;
  const authorKey = m.signature && typeof m.signature.authorKey === "string" && KEY_HEX.test(m.signature.authorKey) ? m.signature.authorKey : undefined;
  const e = { address, id, name, description: text(m.description) ?? "", categories: categoriesOfManifest(m) };
  if (text(m.version)) e.version = text(m.version);
  if (text(m.author)) e.author = text(m.author);
  if (icon) e.icon = `${RAW}/${address}/HEAD/${icon}`;
  e.popularity = Number.isFinite(repo.stars) ? repo.stars : 0;
  if (Number.isFinite(updatedAt)) e.updatedAt = updatedAt;
  if (m.signature) e.signed = true;
  if (authorKey) e.authorKey = authorKey;
  // Kino itself never reads this (not in contract.json's entryFields, so a plugin-run store could never make it stick):
  // it rides along in index.json only for Kino Social to read, attributing the plugin to its author's own profile there
  // (CREATOR-PROFILE-SPEC.md §1a). A malformed value is just left off, never a reason to drop the whole entry.
  const creator = typeof m.creator === "string" && KINO_SOCIAL_USER.test(m.creator.trim()) ? m.creator.trim() : undefined;
  if (creator) e.creator = creator;
  return e;
}

/** Kino's curated `catalog.json` (schema 1) as recommended entries: a plugin by its repo, a Stremio addon by its manifest URL. */
export function entriesOfCatalog(catalog) {
  const plugins = catalog && catalog.schema === 1 && Array.isArray(catalog.plugins) ? catalog.plugins : [];
  const out = [];
  for (const p of plugins) {
    if (!p || typeof p !== "object" || typeof p.id !== "string" || !ID.test(p.id)) continue;
    const e = {};
    if (typeof p.stremio === "string" && p.stremio.startsWith("https://")) e.stremio = p.stremio;
    else if (typeof p.repo === "string" && REPO.test(p.repo) && !p.repo.split("/").some((s) => s === "." || s === "..")) e.address = p.repo;
    else continue;
    e.id = p.id;
    // An unnamed Stremio addon gets the name its manifest gives (what today's app shows), never dropped for lack of one.
    const name = text(p.name) ?? (e.stremio ? stremioName(p.id) : undefined);
    if (!name) continue;
    e.name = name;
    if (text(p.description)) e.description = text(p.description);
    const tags = strings(p.tags);
    if (tags.length) e.tags = tags;
    const categories = strings(p.categories).filter((c) => CATEGORIES.includes(c));
    if (categories.length) e.categories = [...new Set(categories)];
    e.recommended = true;
    if (p.needsSetup === true) e.needsSetup = true;
    if (p.signed === true) e.signed = true;
    if (typeof p.authorKey === "string" && KEY_HEX.test(p.authorKey)) e.authorKey = p.authorKey;
    const requires = strings(p.requires);
    if (requires.length) e.requires = requires;
    out.push(e);
  }
  return out;
}

/** The address keys (owner/repo lowercased) of the recommended plugins: what the state keeps between index days. */
export const recommendedKeys = (recommended) => recommended.filter((e) => e.address).map((e) => keyOf(e.address));

/** The ids of the recommended entries: a delta never brings another repo under one of them (see [ownsId]). */
export const recommendedIds = (recommended) => [...new Set(recommended.map((e) => e.id))].sort();

/** Kino Plugins' own id: no entry of its list may carry it (Kino reserves it for this store). */
export const STORE_ID = "kino-plugins";

const entryKey = (e) => keyOf(e.address ?? e.stremio ?? e.id);

/**
 * One repo per id (Kino's impostor rule, as the store applies it to its own list): of the entries sharing an id, the
 * recommended one stays, else the first by address; and none carries [STORE_ID]. Order kept.
 */
export function oneRepoPerId(entries) {
  const owner = new Map();
  for (const e of entries) {
    if (!e || e.id === STORE_ID) continue;
    const best = owner.get(e.id);
    const better = !best || (e.recommended === true && best.recommended !== true) ||
      ((e.recommended === true) === (best.recommended === true) && entryKey(e).localeCompare(entryKey(best)) < 0);
    if (better) owner.set(e.id, e);
  }
  return entries.filter((e) => e && owner.get(e.id) === e);
}

/**
 * The store's whole list: every recommended entry, with what the index knows of the same plugin underneath (its stars, icon,
 * dates; the catalog's words win), then the rest of the index. One entry per address, and one repo per id ([oneRepoPerId]).
 */
export function mergeFull(indexEntries, recommended) {
  const byKey = new Map();
  for (const e of indexEntries) if (e && typeof e.address === "string" && !byKey.has(keyOf(e.address))) byKey.set(keyOf(e.address), e);
  const out = [];
  for (const r of recommended) {
    const under = r.address ? byKey.get(keyOf(r.address)) : undefined;
    if (under) byKey.delete(keyOf(r.address));
    out.push(under ? { ...under, ...r } : r);
  }
  for (const e of byKey.values()) out.push(e);
  return oneRepoPerId(out);
}
