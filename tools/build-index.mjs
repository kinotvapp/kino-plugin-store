// Builds index.json: every public repository with topic `kino-plugin`, as the StoreEntry list the Kino Plugins store reads.
// Runs once a day in a GitHub Action (build-index.yml) with the Action's GITHUB_TOKEN; the store reads the result from
// raw.githubusercontent.com. Entries come from the store's own src/entries.js, so the store and the index never disagree.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { entriesOfCatalog, entryOfManifest, keyOf, mergeFull } from "../src/entries.js";

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const TOPIC = "kino-plugin";
const FIRST_MOMENT = Date.parse("2008-01-01T00:00:00Z");
const SEARCH_CAP = 1000;
const PER_PAGE = 100;
const MAX_RETRIES = 5;
const REQUEST_TIMEOUT_MS = 20_000;
const MIN_SPAN_MS = 3_600_000; // a created: range is never split below one hour
const MAX_FAILED_SHARE = 0.1; // more manifests than this failing means the day's list would be short: keep yesterday's index

/**
 * The repos (`owner/repo` lowercased) of the owner's takedown list (`community-blocklist.json`, schema 1, in the same
 * kinotvapp/kino-plugins repository): the index never carries them, so neither the daily list nor the copy shipped inside
 * the store lists a repo Kino retired. Kino filters again on every device.
 */
export function blockedRepos(blocklist) {
  const entries = blocklist && blocklist.schema === 1 && Array.isArray(blocklist.entries) ? blocklist.entries : [];
  return new Set(entries.filter((e) => e && typeof e.repo === "string").map((e) => e.repo.trim().toLowerCase()));
}

const repoOfAddress = (address) => address.split("/").slice(0, 2).join("/").split("@")[0].toLowerCase();

/** [index] without the entries whose repo is on [blocklist]: for an index already built (the shipped copy). */
export function filterBlocked(index, blocklist) {
  const blocked = blockedRepos(blocklist);
  return { ...index, entries: index.entries.filter((e) => !(typeof e.address === "string" && blocked.has(repoOfAddress(e.address)))) };
}

const stamp = (ms) => new Date(ms).toISOString().slice(0, 19) + "Z";

/**
 * A fetch with a per-request timeout that retries what is transient: network errors and timeouts, 5xx, and GitHub's rate limits
 * (429, or 403 with no quota left, waiting Retry-After / X-RateLimit-Reset). The timeout covers reading the body, and a body that
 * fails to read is retried like any network error. Returns `{ status, ok, text }` of the last attempt once retries run out.
 */
function politeFetch({ fetch, token, sleep, now, timeoutMs }) {
  return async function get(url, { api = false, retries = MAX_RETRIES } = {}) {
    const headers = { "User-Agent": "kino-plugin-index" };
    if (api) headers.Accept = "application/vnd.github+json";
    if (token && api) headers.Authorization = `Bearer ${token}`;
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= retries;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      let text;
      try {
        res = await fetch(url, { headers, signal: controller.signal });
        text = await res.text();
      } catch (e) {
        if (last) throw e;
        await sleep(2 ** attempt * 1000);
        continue;
      } finally {
        clearTimeout(timer);
      }
      const retryAfter = res.headers.get("retry-after");
      const limited = res.status === 429 || (res.status === 403 && (retryAfter || res.headers.get("x-ratelimit-remaining") === "0"));
      if (last || !(limited || res.status >= 500)) return { status: res.status, ok: res.ok, text };
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      let wait = 2 ** attempt * 1000;
      if (limited) wait = retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : reset > 0 ? Math.max(0, reset * 1000 - now()) + 1000 : 60_000;
      await sleep(wait);
    }
  };
}

/** One search page; an `incomplete_results` answer (GitHub timed out partway) is asked again, and fails the run if it stays so. */
async function searchPage(get, q, page) {
  const url = `${API}/search/repositories?q=${encodeURIComponent(q)}&per_page=${PER_PAGE}&page=${page}`;
  for (let attempt = 0; attempt <= 2; attempt++) {
    const res = await get(url, { api: true });
    if (!res.ok) throw new Error(`search ${q} page ${page}: HTTP ${res.status}`);
    const body = JSON.parse(res.text);
    if (body.incomplete_results !== true) return body;
  }
  throw new Error(`search ${q} page ${page}: GitHub keeps answering incomplete_results`);
}

/** Every repository of the topic created in [from, to] (epoch ms), halving the range while it holds more than the search cap. */
async function searchRange(get, from, to, out) {
  const q = `topic:${TOPIC} fork:false created:${stamp(from)}..${stamp(to)}`;
  const body = await searchPage(get, q, 1);
  if (body.total_count > SEARCH_CAP) {
    if (to - from < MIN_SPAN_MS) throw new Error(`${q}: ${body.total_count} repositories in under an hour, more than the search can list`);
    const mid = from + Math.floor((to - from) / 2);
    await searchRange(get, from, mid, out);
    await searchRange(get, mid + 1000, to, out);
    return;
  }
  const pages = Math.ceil(body.total_count / PER_PAGE);
  let items = body.items ?? [];
  for (let page = 1; ; page++) {
    for (const r of items) if (r && typeof r.full_name === "string") out.set(keyOf(r.full_name), r);
    if (page >= pages) return;
    items = (await searchPage(get, q, page + 1)).items ?? [];
  }
}

/** The recommended Stremio addons the catalog leaves unnamed get the name their manifest gives today; unreachable ones keep the store's fixed name. */
async function nameStremio(catalog, get, log) {
  const plugins = [];
  for (const p of catalog.plugins ?? []) {
    if (p && typeof p.stremio === "string" && p.stremio.startsWith("https://") && !(typeof p.name === "string" && p.name.trim())) {
      try {
        const res = await get(p.stremio, { retries: 0 });
        const name = res.ok ? JSON.parse(res.text).name : undefined;
        if (typeof name === "string" && name.trim()) {
          plugins.push({ ...p, name: name.trim() });
          continue;
        }
      } catch {
        // Falls through to the fixed name.
      }
      log(`stremio manifest of ${p.id} did not answer; keeping the fixed name`);
    }
    plugins.push(p);
  }
  return { ...catalog, plugins };
}

/**
 * The index: `{ schema: 1, generatedAt, entries }`. [fetch], [sleep], [now] and [token] are injectable so tests need no network;
 * [catalog] is the parsed catalog.json whose recommended entries the index carries too; [blocklist] the parsed
 * community-blocklist.json, whose repos it never carries ([filterBlocked]). One repo per id ([mergeFull]).
 */
export async function buildIndex({ fetch = globalThis.fetch, token, catalog = { schema: 1, plugins: [] }, blocklist = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, log = () => {}, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const get = politeFetch({ fetch, token, sleep, now, timeoutMs });
  const repos = new Map();
  await searchRange(get, FIRST_MOMENT, now(), repos);

  const found = [];
  let failed = 0;
  const sorted = [...repos.values()].filter((r) => r.fork !== true).sort((a, b) => keyOf(a.full_name).localeCompare(keyOf(b.full_name)));
  for (const r of sorted) {
    let text;
    try {
      const res = await get(`${RAW}/${r.full_name}/HEAD/kino-plugin.json`);
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = res.text;
    } catch (e) {
      failed += 1;
      log(`${r.full_name}: manifest unreadable (${e.message})`);
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch {
      continue; // an author's broken manifest: no plugin, and not a transient failure
    }
    const [owner, repo] = r.full_name.split("/");
    const entry = entryOfManifest({ owner, repo, stars: r.stargazers_count, pushedAt: r.pushed_at ?? null }, manifest);
    if (entry) found.push(entry);
  }

  if (failed > sorted.length * MAX_FAILED_SHARE) throw new Error(`${failed} of ${sorted.length} manifests could not be read; keeping the previous index`);

  const recommended = entriesOfCatalog(await nameStremio(catalog, get, log));
  const sortKey = (e) => keyOf(e.address ?? e.stremio ?? e.id);
  const entries = mergeFull(found, recommended).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return filterBlocked({ schema: 1, generatedAt: now(), entries }, blocklist);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2] ?? "index.json";
  const catalogPath = process.argv[3] ?? "catalog.json";
  const blocklistPath = process.argv[4] ?? "community-blocklist.json";
  const blocklist = existsSync(blocklistPath) ? JSON.parse(readFileSync(blocklistPath, "utf8")) : null;
  if (!blocklist) console.warn(`${blocklistPath} not found: no repo is left out by the takedown list`);
  const index = await buildIndex({ token: process.env.GITHUB_TOKEN, catalog: JSON.parse(readFileSync(catalogPath, "utf8")), blocklist, log: (m) => console.warn(m) });
  writeFileSync(out, `${JSON.stringify(index, null, 1)}\n`);
  console.log(`${out}: ${index.entries.length} entries`);
}
