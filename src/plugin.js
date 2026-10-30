// Kino Plugins: the built-in plugin store (apiVersion 15, `pluginStore`, a local store). It only syncs: Kino paints the
// store from its own index and installs through its own consent sheet. The shipped index.json and catalog.json are bundled
// here so the first sync needs no network.
import catalog from "../catalog.json";
import index from "../index.json";
import { sync } from "./sync.js";

export async function storeSync(arg) {
  return sync(arg, { fetch: (url, options) => kino.fetch(url, options), now: () => Date.now(), shipped: { index, catalog } });
}
