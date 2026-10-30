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
  sync.js       storeSync: shipped list, daily index.json, or a pushed:> delta with its cursor in state
  entries.js    StoreEntry objects from a kino-plugin.json, from catalog.json and from index.json; categories as Kino derives them
  stremio-names.js  the names of the recommended Stremio addons catalog.json leaves unnamed (as their manifests give them)
index.json      the list shipped with this version: { "schema": 1, "generatedAt": <ms>, "entries": [StoreEntry...] }
catalog.json    Kino's curated catalog (the same file as the app's assets/plugin-catalog-seed.json)
```

## What `storeSync` answers

1. **First call** (no `state` yet): the shipped `index.json` and `catalog.json`, `full: true`, with no network at all, so the
   store is full on a first start offline. Catalog entries are marked `recommended` (Kino honours that only from this store).
2. **Once a day**: today's `index.json` from `kinotvapp/kino-plugins` (raw.githubusercontent.com, then jsDelivr), built daily
   by a GitHub Action, plus `catalog.json`; `full: true`. That re-read drops repos that lost the `kino-plugin` topic or were
   deleted, and refreshes the stars. If it cannot be read, the sync falls back to the delta and tries again next time.
3. **Between index days**: one search,
   `q=topic:kino-plugin fork:false pushed:>{window start}&sort=updated&order=asc&per_page=100`, then each new repo's
   `kino-plugin.json` from raw (at most 30 a sync, oldest push first, `"discoverable": false` dropped), as `full: false`.
   The window lives in `state` (the delta cursor):
   - `deltaFrom`: the end of the last window read; the next one starts there minus a 10-minute overlap, never before the
     index's `generatedAt`. A refused (403/429) or failed search answers an empty delta and keeps the same window.
   - `deltaAfter`: set when a busy day had more new repos than one sync reads; the next sync starts one second before the
     last repo read, so nothing is lost.

`state` also keeps `indexGeneratedAt`, `indexReadAt` and the recommended addresses (a delta never overwrites a recommended
row), well under Kino's 16 KB. GitHub allows 10 unauthenticated searches a minute: this store makes one per sync.

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
