# Click analytics & privacy

![Link detail with the clicks chart](/ui-detail.png)

## What is stored

For every hit shorty writes one raw click row (kept `retentionDays`, default
395) and increments a per-day rollup (kept forever):

| Field | Notes |
|---|---|
| `linkId`, `rev`, `at` | Which link, which destination revision, server receipt time. |
| `visitor` | HMAC, see below. |
| `unique` | First hit for this visitor within `uniqueWindowMinutes`. |
| `bot`, `qr` | Bot flag; arrived with `?qr=1`. |
| `referrerHost`, `referrer` | Host (no `www.`) and origin + path. Query and fragment are never stored. |
| `country`, `region`, `city` | Only what your `geo` adapter (or CDN headers) provides. |
| `browser`, `os`, `device` | From the user agent. |
| `queryKeys` | Keys of the incoming query: at most 20 distinct keys (first seen), each truncated to 64 characters, `qr` excluded. **Values are never stored.** |

Two small side collections also exist:

- `shorty_seen`: one row per (link, visitor hash) for the unique window, with a
  TTL equal to `uniqueWindowMinutes`.
- `shorty_misses`: the path and referrer host of unknown-slug requests, kept
  30 days.

**No IP address is stored**, raw or truncated.

## The visitor hash

```
visitor = HMAC-SHA256(pepper, day | ip | user-agent | linkId)
```

The hash includes the day, so the same person is not linkable across days or
across links. That is the design (the Plausible approach), with two
consequences:

- **Unique counts are visitor-days.** A person who clicks on three different
  days counts three times in a week, month or total.
- The unique window (default 60 minutes, fixed from the first hit) resets at
  midnight in `clicks.timezone`.

Treat the pepper like a secret. Rotating it breaks nothing but splits that
day's uniques.

## Bots

A hit is a bot if it is a `HEAD` request, has a crawler user agent (`isbot`),
or has an **empty or missing** user agent. Bots are recorded and counted
**separately everywhere**: `botClicks` on links, `bots` and `botUniques` in
rollups, a separate series in the stats API. They never count toward
`maxClicks`. Summing is a view decision, which is what the UI's
**Bots: Hide / Show separately / Include** control does (default Hide,
remembered per viewer).

A crawler served a link's custom social card counts as a bot click.

## Reading the numbers

```js
const stats = await shorty.stats({
  linkId,                    // omit for all links
  from: '2026-03-01', to: '2026-03-31',
  interval: 'day',           // 'day' | 'week' | 'month'
  top: 10,                   // breakdown rows, max 50
});
stats.totals.humans;   // { clicks, uniques, qr }
stats.totals.bots;     // { clicks, uniques }
stats.series;          // [{ date, humans, bots }]
stats.breakdowns;      // referrer, country, device, browser, os, source, revision (per-link only)
```

- Date-only `from` / `to` are calendar days in `clicks.timezone`, both
  inclusive. Full timestamps are converted to the day in that zone.
- Ranges over 400 days are `range_too_large`.
- `series` comes from rollups (kept forever). `breakdowns` come from raw
  clicks, so `breakdownsTruncated` is true when the range reaches back past
  retention. Totals stay correct; the breakdown detail just isn't there.
- In the overview (no `linkId`), `topLinks` and `topCampaigns` are included;
  campaigns come from `utm.campaign` across the 5,000 busiest links.

## Counters

`link.clicks`, `uniqueClicks` and `botClicks` are `$inc`ed from one code path
per click. `shorty.recount(id)` rebuilds them from the rollups if you ever
need to.

## Retention and deletion

`deleteLink` removes the link, its history, raw clicks and rollups, and frees
its slugs. Use it for erasure; archiving only hides a link from lists.
