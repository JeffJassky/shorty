# Scaling notes

shorty is built to be cheap to run, not clever to run. The honest limits:

- **Redirect lookup** is one indexed `findOne` on a multikey `keys` index per
  hit, projecting only redirect fields. There is no cache; add one only when
  you have numbers that call for it.
- **Tracking is off the hot path.** The response is sent first. Click
  recording is several writes (seen-window insert, raw click, daily rollup,
  link counters). A slow database delays analytics, not redirects; watch
  `health().clickFailures` and `inFlight`.
- **Boot-time claim sweep.** `ready()` reconciles slug claims and case-mode
  keys by scanning every link's slugs, which is a full scan of the `slugs`
  collection and the links' keys. It is fine for tens of thousands of links
  and is time you should budget at boot for hundreds of thousands. It runs on
  every boot, and is safe to repeat after a crash.
- **Write versions.** Every link carries `wv` (bumped on each write to its
  own fields; clicks never touch it) and `ck` (the case mode its keys were
  written under), both on `LinkDoc` for hosts that query collections directly.
  `updateLink` pins `wv`, so a write planned from a stale read re-plans instead
  of overwriting.
- **Rolling deploys across a `caseSensitive` flip** converge on the mode of the
  last instance to boot: every `ready()` re-keys links whose `ck` differs, and
  until then links written by the other mode are unreachable by this mode's
  lookups.
- **Overload.** `clicks.maxInFlight` (default 10000) bounds tracking work;
  past it pipelines are skipped and counted in `health().dropped`.
  `redirect.lookupTimeoutMs` (default 2000) bounds the slug lookup.
- **`maxClicks` is best-effort.** Counting happens after the response, so
  concurrent or very fast sequential hits can overshoot by the number in
  flight. Use `expiresAt` when a limit must be exact.
- **The parameter catalog** is one live aggregation over all links with a
  2-second cap. It is cheap up to about 100k links.
- **Stats** aggregations all have `maxTimeMS` and caps: 400-day ranges, 50
  breakdown rows, 200 rows per list page.
- **Multiple instances** are safe. Link writes are version-pinned, slug claims
  are insert-based, and counters are `$inc`s. Rolling deploys across a
  `caseSensitive` flip converge on the last instance to boot.
- **Raw clicks** are a regular collection with a TTL index (not a time-series
  collection) so erasure can `deleteMany`. Rollups never expire.
