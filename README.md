# Kino Plugins (the built-in store)

Kino Plugins is Kino's own plugin store, the "plugin of plugins". It is an ordinary JS plugin with a single capability,
`pluginStore` (apiVersion 15, a **local** store), shipped inside the Kino APK and installed on first start. It never draws
anything and never installs anything: it hands Kino a list of plugins (the recommended ones and the community ones on GitHub),
Kino keeps that list in its own local index, paints the store from it, applies the owner's blocklist and the 18+ code, and
installs through its own consent sheet.

It declares four hosts: `api.github.com` (the repository search), `raw.githubusercontent.com` (manifests, `index.json`,
`catalog.json`), `cdn.jsdelivr.net` (the same files when raw is down) and `archive.org` (a copy of `catalog.json`). It never
sends a token.

## How it is built

The code lives in modules under `src/`. Kino installs one file, so `npm run build` (esbuild) bundles them, together with
the shipped `index.json` and `catalog.json`, into the committed `plugin.js`. Never edit `plugin.js` by hand: change `src/` and
build again.

```text
src/
  plugin.js     entry: the storeSync export Kino calls, with kino.fetch, the clock and the shipped lists
  sync.js       storeSync: shipped list, hourly index.json, or a pushed:> delta with its cursor in state
  reliability.js  reliability.json ratings -> popularity (the store's order), freshness and the compact copy kept in state
  entries.js    StoreEntry objects from a kino-plugin.json, from catalog.json and from index.json; categories as Kino derives them
  stremio-names.js  the names of the recommended Stremio addons catalog.json leaves unnamed (as their manifests give them)
index.json      the list shipped with this version: { "schema": 1, "generatedAt": <ms>, "entries": [StoreEntry...] }
catalog.json    Kino's curated catalog (the same file as the app's assets/plugin-catalog-seed.json)
```

## What `storeSync` answers

1. **First call** (no `state` yet): the shipped `index.json` and `catalog.json`, `full: true`, with no network at all, so the
   store is full on a first start offline. Catalog entries are marked `recommended` (Kino honours that only from this store).
2. **Once an hour**: the latest `index.json` from `kinotvapp/kino-plugins` (raw.githubusercontent.com, then jsDelivr), which the
   project rebuilds every few minutes and publishes only when its entries change, plus `catalog.json` and `reliability.json`
   (see "Ordering by reliability"); `full: true`. That re-read drops repos that lost the `kino-plugin` topic or were
   deleted, and refreshes the stars. If it cannot be read, the sync falls back to the delta and tries again next time.
3. **Between index days**: one search,
   `q=topic:kino-plugin fork:false pushed:>{window start}&sort=updated&order=asc&per_page=100`, then each new repo's
   `kino-plugin.json` from raw (at most 30 a sync, oldest push first, `"discoverable": false` dropped), as `full: false`.
   The window lives in `state` (the delta cursor):
   - `deltaFrom`: the end of the last window read; the next one starts there minus a 10-minute overlap, never before the
     index's `generatedAt`. A refused (403/429) or failed search answers an empty delta and keeps the same window.
   - `deltaAfter`: set when a busy day had more new repos than one sync reads; the next sync starts one second before the
     last repo read, so nothing is lost.

`state` also keeps `indexGeneratedAt`, `indexReadAt`, the recommended addresses (a delta never overwrites a recommended
row) and `rel` (the ratings below, compact), well under Kino's 16 KB. GitHub allows 10 unauthenticated searches a minute: this
store makes one per sync.

## Ordering by reliability

Kino lists the store by `popularity`, descending. Until 1.0.8 that was a repository's stars; now the most reliable plugins come
first. `reliability.json` (schema 1, next to `index.json` in `kinotvapp/kino-plugins`) rates each plugin 0 to 100 from how many of
its users hit failures in the last 7 days, and this store turns the rating into `popularity`:

```text
popularity = round(value * 10) * 1000 + min(stars, 999)      value = the file's rank (its score, in an older file)
```

- `score` is the measured health; `rank` is what the store orders by: the score shrunk toward the file's `prior` (the median of
  the plugins with a solid sample) with the weight of `shrinkK` users, so a plugin with 60 users and no failures does not outrank
  one with thousands of users and a few. A plugin with no data has `rank = prior`. The publisher computes it; this store only reads it.
- The value decides the order; the stars only break ties (they are capped, so they can never outweigh a step of the value).
- A plugin the file does not rate counts as the file's `prior` (`NEUTRAL_SCORE`, 55, if the file has none): in the middle, neither
  buried nor above the proven ones. With no ratings at all the order is the stars, as before.
- The ratings are optional and never a reason to fail a sync. If `reliability.json` cannot be read, the ratings kept in `state`
  stay while they are fresh; one older than 14 days (`STALE_MS`) is ignored and the order falls back to the stars.
- A `delta` ranks its new rows with the ratings kept in `state`, so a plugin that was just pushed does not drop to the neutral
  score until the next full read.

```json
{ "schema": 1, "generatedAt": 1794690000000, "windowDays": 7, "minUsers": 5, "prior": 69.8, "shrinkK": 100,
  "plugins": [ { "id": "kino-social", "score": 99.4, "rank": 99.1, "grade": "A", "confidence": "alta", "active_users": 8685,
                 "trend": { "direction": "estable", "delta": 0.3 }, "top_failures": [] },
               { "id": "some-new-one", "score": null, "rank": 69.8, "grade": "sin_datos" } ] }
```

The score is the lower bound of the share of healthy users (Wilson interval), by user and not by event, so a single device in a
loop cannot sink a plugin and a plugin with few users cannot rank high by luck. Only `id`, `rank` (or `score`) and `prior` are
read here (`src/reliability.js`, tested in `test/reliability.test.mjs`).

## Build, validate, try

```bash
npm install
npm run build                          # writes plugin.js from src/ and the shipped lists
npm run check:built                    # fails if plugin.js is not exactly what src/ builds to
npm run validate                       # node ../sdk/validate.mjs .   (what Kino would say about the manifest)
node ../sdk/run.mjs . storeSync        # the first call: the shipped list
node ../sdk/run.mjs --since <ms> --state '{"indexGeneratedAt":<ms>,"indexReadAt":<ms>,"recommended":[]}' . storeSync
npm test                               # each test file runs on its own (node --test <file>)
```

The commands above use the kit in Kino's repository (`../sdk`); outside it, use the kit from `kinotvapp/kino-plugin-sdk`.

## Signed

The committed `plugin.js` is signed with the Kino author key (fingerprint `07DA-B67F-2ACF-B4D3`) for the repository
`kinotvapp/kino-plugin-store`; the signature is the `signature` field of `kino-plugin.json`. Kino pins that key, so **after
any rebuild or version change the plugin must be signed again** with the same key, or Kino refuses the update:

```bash
node sdk/seal.mjs --sign --repo kinotvapp/kino-plugin-store --manifest kino-plugin.json --key <path to the author key>
```

`.gitattributes` keeps `plugin.js` byte for byte (no line-ending conversion), since the signature covers its bytes.

## Working on it outside Kino's repository

`validate` and the signing command use the plugin kit, which is published in [kinotvapp/kino-plugin-sdk](https://github.com/kinotvapp/kino-plugin-sdk): copy its `sdk/` folder next to this README (it is not committed here).
