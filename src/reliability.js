// Reliability ordering. Kino lists the store by `popularity` (descending), and until now that was a repo's GitHub stars. A
// `reliability.json` (schema 1, published next to index.json) rates each plugin from 0 to 100 by how many of its users hit
// failures in the last days; this turns that rating into `popularity`, so the plugins that fail least come first.
//
//   popularity = round(score * 10) * 1000 + min(stars, 999)
//
// The score decides the order and the stars only break ties. A plugin with no rating (new, too few users, or a region-locked
// one) gets NEUTRAL_SCORE, so it sits in the middle instead of being buried or placed above the proven ones.

/** What an unrated plugin counts as: the C grade's floor. */
export const NEUTRAL_SCORE = 55;
/** A reliability.json older than this is ignored (the store falls back to stars): a stale rating must not freeze the order. */
export const STALE_MS = 14 * 24 * 3600_000;
/** The compact scores kept in `state` (Kino keeps 16 KB in all): past this the remaining ids simply count as unrated. */
export const STATE_MAX_CHARS = 6000;
export const RELIABILITY_MAX_BYTES = 256 * 1024;

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const validReliability = (b) => !!b && b.schema === 1 && Number.isFinite(b.generatedAt) && Array.isArray(b.plugins);

/** The `{ at, s: { id: score } }` of the rated plugins of [doc] (only finite scores 0 to 100), compact enough for `state`. */
export function scoresOf(doc) {
  const s = {};
  let used = 0;
  const rated = doc.plugins
    .filter((p) => p && typeof p.id === "string" && ID.test(p.id) && Number.isFinite(p.score) && p.score >= 0 && p.score <= 100)
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const p of rated) {
    const cost = p.id.length + 8;
    if (used + cost > STATE_MAX_CHARS) break;
    s[p.id] = Math.round(p.score * 10) / 10;
    used += cost;
  }
  return { at: doc.generatedAt, s };
}

/** [rel] (the `{ at, s }` kept in state or just read) when it is well-formed and not stale at [now], else null. */
export function freshScores(rel, now) {
  if (!rel || typeof rel !== "object" || !Number.isFinite(rel.at) || !rel.s || typeof rel.s !== "object") return null;
  return now - rel.at <= STALE_MS ? rel : null;
}

/** An entry's popularity from its stars and its score (undefined: unrated). */
export function popularityOf(stars, score) {
  const s = Number.isFinite(score) ? Math.min(100, Math.max(0, score)) : NEUTRAL_SCORE;
  const tie = Number.isFinite(stars) ? Math.min(999, Math.max(0, Math.floor(stars))) : 0;
  return Math.round(s * 10) * 1000 + tie;
}

/** [entries] with `popularity` replaced by the reliability ranking ([rel]: `{ s }` or null for "nothing rated"). */
export function rank(entries, rel) {
  const scores = rel && rel.s ? rel.s : {};
  return entries.map((e) => ({ ...e, popularity: popularityOf(e.popularity, Object.hasOwn(scores, e.id) ? scores[e.id] : undefined) }));
}
