# shorty — build plan

Stage 3 output. **Greenfield:** no host app has a short-link implementation to
recon, so stages 1–2 are replaced by [research.md](./research.md) — a survey of
Dub, Bitly, Short.io, Rebrandly, Shlink, Kutt and YOURLS. Config keys below cite
that consensus instead of a recon (process/3-build-plan.md, "be suspicious of
keys you invented" — each one names the products that prove it).

Status: **approved** (2026-10-26, via `/scaffold shorty`). Decisions taken from the user:
name `shorty`; built-in click storage + dashboard; admin and public mount paths
are both the host's choice, and shorty is agnostic to route order; editing
allowed "within reason" (defined in §7.3); create form offers auto-generated or
custom slug, and is the showcase of the UI. Follow-up (same day): slug case
sensitivity and slug renaming are **operator config** (the integrating app, not
the end user); bot clicks are tracked separately so views can combine or omit
them; UI is simple and clean, explains only what a lay person can't read at a
glance (tooltips preferred), and reuses the mailery/telemetry visual system (§8).

---

## 1. Name

`@jeffjassky/shorty`, repo slug `shorty`. Verified free on npm 2026-10-26
(`shortie`, `shortlink`, `linkery` also free; not taken).

## 2. Public API (one screen)

```ts
import { createShorty } from '@jeffjassky/shorty'

const shorty = createShorty({
  connection: mongoose.connection,
  publicBaseUrl: 'https://acme.com/go',   // where the host mounts `redirect`, as the browser sees it
  pepper: process.env.SHORTY_PEPPER,      // visitor-hash secret
  onClick: (e) => analytics.capture(e),   // optional hooks, see §3
})

app.use('/go', shorty.redirect)                     // public — or '/', or a vhost; any order
app.use('/admin/links/api', requireAdmin, shorty.routes)
app.use('/admin/links', requireAdmin, shorty.ui())  // SPA; talks to `routes`

// programmatic — writes are verbs, reads are nouns
await shorty.createLink({ url: 'https://acme.com/sale?utm_source=ig', slug: 'spring' })
await shorty.updateLink(id, { utm: { campaign: 'spring-26' } })
await shorty.archiveLink(id)      // hidden from lists, still redirects
await shorty.unarchiveLink(id)
await shorty.deleteLink(id)       // hard delete: link + revisions + clicks + rollups
await shorty.link(idOrSlug)
await shorty.links({ q, tag, archived, sort, cursor, limit })
await shorty.stats({ linkId?, from, to, interval })
await shorty.paramValues()        // the suggestion catalog, §7.4
await shorty.inspect(url)         // OG + destination health, §7.6
shorty.shortUrl(link)             // publicBaseUrl + slug
```

Exports: `createShorty` (default too), `createShortyClient` from
`@jeffjassky/shorty/client` (typed fetch client, featureboard's shape),
`composeUrl` / `parseUrl` (pure, shared by server and SPA), `defaultSpaDir`.

## 3. Config surface

```ts
interface ShortyConfig {
  connection: Connection | Mongoose
  publicBaseUrl: string                  // required; throws at create if missing or not absolute
  collectionPrefix?: string              // 'shorty_'
  modelPrefix?: string                   // traps #2 — two instances on one connection
  pepper?: string                        // falls back to SHORTY_PEPPER; required if clicks enabled

  slug?: {
    length?: number                      // 7
    alphabet?: string                    // '23456789abcdefghjkmnpqrstuvwxyz' (no 0 1 i l o)
    reserved?: (string | RegExp)[]       // EXTENDS the builtin list, never replaces it
    generate?: () => string              // overrides length/alphabet; still collision-checked
    caseSensitive?: boolean              // false — '/Spring' = '/spring'. Set before the first
                                         // link: flipping it later can make existing slugs
                                         // collide, and createShorty throws naming them
    rename?: 'alias' | 'untilClicked' | 'always' | 'never'
                                         // 'alias' — rename freely; every old slug keeps
                                         // redirecting to the link forever. See §7.3
  }

  redirect?: {
    status?: 301 | 302 | 307 | 308       // 302; per-link override
    forwardQuery?: boolean               // true; incoming wins; per-link override
    noindex?: boolean                    // true → X-Robots-Tag: noindex
    onMiss?: 'next' | 'notFound' | string           // 'next' — the route-order-agnostic default
    onExpired?: 'page' | 'notFound' | string        // 'page' (410 + minimal HTML); per-link expiredUrl wins
  }

  destinations?: {
    allowedHosts?: (string | RegExp)[]   // unset = any public http(s) host
    blockedHosts?: (string | RegExp)[]
  }

  clicks?: false | {
    retentionDays?: number               // 395 (13 months) — raw clicks; daily rollups kept forever
    uniqueWindowMinutes?: number         // 60
    timezone?: string                    // 'UTC' — daily rollup bucket, traps #15
    geo?: (req) => { country?: string; region?: string; city?: string } | null
                                         // default reads cf-ipcountry / x-vercel-ip-country /
                                         // cloudfront-viewer-country; no GeoIP database shipped
    ip?: (req) => string | undefined     // default req.ip — host owns trust proxy
  }

  resolveUser?: (req) => { id: string; name?: string } | null   // stamps createdBy/updatedBy
  screenshot?: (url: string) => Promise<{ contentType: string; body: Buffer } | null>
                                         // optional adapter, §4; UI hides the tab when absent

  // hooks — mailery's top-level onX style; all optional, all awaited-and-caught, none can break a redirect
  onClick?:   (e: ClickEvent) => void | Promise<void>   // after the response is sent; bots included, flagged
  onCreate?:  (e: { link: Link; req? }) => void | Promise<void>
  onUpdate?:  (e: { link: Link; prev: Link; revision?: Revision; req? }) => ...
  onArchive?: (e: { link: Link; archived: boolean; req? }) => ...
  onDelete?:  (e: { link: Link; req? }) => ...
  onMiss?:    (e: { path: string; req }) => ...         // Shlink's "orphan visits"
  track?:     (name: string, opts: { attrs?; data?; subjects? }) => void
                                         // structurally a telemetry client's track(); no-op default
  logger?: Logger
  ui?: UiOptions                          // defaults merged into ui()
}
```

| Key | Proven by (research.md) |
|---|---|
| `slug.length` 7, look-alike-free alphabet | Dub nanoid(7); Kutt alphabet; Shlink 5 |
| `slug.caseSensitive` false | Dub lowercases by default, Bitly/Shlink sensitive — products disagree, so it's config (user decision) |
| `slug.rename` 'alias' | Bitly binds on use, Kutt/Dub allow renames — products disagree, so it's config (user decision) |
| `slug.reserved` extends builtin | Dub `key-checks.ts`, Kutt `preservedURLs`, YOURLS reserved |
| `redirect.status` 302 + per-link | Dub, Kutt, Shlink default 302; Short.io per link; YOURLS 301 regret |
| `redirect.forwardQuery` true, incoming wins | Dub, Shlink, Rebrandly |
| `redirect.noindex` true | Dub `doIndex=false`, Shlink non-crawlable |
| `redirect.onMiss` | Shlink invalid-slug redirect; Kutt homepage; Dub not-found. `'next'` default is the user's route-order requirement |
| `redirect.onExpired` + per-link `expiredUrl` | Dub, Short.io, Shlink |
| `destinations.allowed/blockedHosts` | Kutt banned domains, Dub block/allow lists |
| `clicks.retentionDays` | Dub plan retention; Shlink delete-expired |
| `clicks.uniqueWindowMinutes` 60 | Dub 1 h dedupe |
| `clicks.geo` from CDN headers | Kutt `cf-ipcountry` |
| hashed visitor, no raw IP | Shlink anonymize default, Kutt stores none |
| `onClick` / `onCreate` / `onUpdate` / `onDelete` | Dub `link.clicked|created|updated|deleted` webhooks — as hooks, so the host decides transport |
| `onMiss` | Shlink orphan visits |
| `screenshot` | **no product has it** — adapter only, see §4 |

## 4. Adapters — both directions

| Adapter | Inbound (shorty → host) | Outbound (host → shorty) | Default when absent |
|---|---|---|---|
| `resolveUser` | asks who is acting | `{ id, name }` or null | `createdBy` unset |
| `geo` | hands `req` | country/region/city | CDN-header reader; nothing if no header |
| `ip` | hands `req` | client IP string | `req.ip` |
| `screenshot` | a destination URL | image bytes or null | preview tab hidden |
| `track` | event name + attrs/subjects | nothing | no-op |
| `onX` hooks | the event object | nothing; throws are logged, never propagate | no-op |

`screenshot` is an adapter, not a feature, on purpose: rendering a page needs a
headless browser (≈150 MB dependency) or a paid API. A host that already runs
Playwright (complykit does) passes a 5-line function. An iframe preview was
considered and rejected: most real destinations send `X-Frame-Options` /
`frame-ancestors`, so it would show a blank box on exactly the sites people link
to most.

## 5. Package split

One package. The trust boundary is between `redirect` (public, unauthenticated,
high volume) and `routes`/`ui()` (admin, behind the host's guard) — and that is
expressed as separate routers, not separate packages, because nothing on the
public side ships to an untrusted runtime. `./client` is a subpath, not a
package (featureboard precedent).

## 6. Cross-package deps

- `@jeffjassky/telemetry` — **not a peer.** `track` is a callback whose shape
  matches `TelemetryClient.track(name, { attrs, data, subjects })`; host passes
  `telemetry.track` or nothing. Shorty does not reimplement telemetry's
  collections, it just stores its own clicks (house-style "test for whether
  something is a peer").
- Peers: `express ^4 || ^5`, `mongoose ^8`. Deps: `isbot` (MIT),
  `ua-parser-js@^1` (**pinned < 2** — v2 is AGPL), `htmlparser2` (OG parsing).
  SPA-only (bundled, not deps): `qrcode`. No chart library — hand-rolled SVG, as telemetry.

## 7. Data layer

### 7.1 Collections

**`shorty_links`**
```ts
{
  _id, slug: string,             // as entered, display form
  slugKey: string,               // normalized: NFKD, accents stripped, lowercased unless caseSensitive
  keys: string[],                // slugKey + every alias key — multikey index, what redirect looks up
  origin: 'generated' | 'custom',
  baseUrl: string,               // scheme+host+path, NO query, NO fragment
  utm: { source?, medium?, campaign?, term?, content?, id? },
  params: [{ key, value }],      // ordered, non-utm query params; duplicate keys allowed
  hash?: string,                 // fragment, kept separate so it lands after the query
  destination: string,           // composeUrl(baseUrl, utm, params, hash) — denormalized, what redirect reads
  title?, notes?, tags: string[],
  redirect: { status?, forwardQuery? },     // per-link overrides; absent = config default
  expiresAt?, maxClicks?, expiredUrl?,
  social?: { title?, description?, image? },  // custom card served to crawlers only, §7.5
  og?: { title?, description?, image?, favicon?, fetchedAt },  // cached scrape for list thumbnails
  rev: number,                   // increments on destination change
  clicks: number, uniqueClicks: number, lastClickedAt?,       // humans
  botClicks: number,                                          // bots, kept apart — views add them or not
  archived: boolean, createdBy?, updatedBy?, createdAt, updatedAt
}
```
Indexes: `{ keys: 1 }`; `{ archived: 1, createdAt: -1 }`;
`{ archived: 1, clicks: -1 }`; `{ tags: 1 }`; text index on
`slug, title, notes, baseUrl, utm.campaign` (traps #3 — built in background, tests
`await syncIndexes()`).

**`shorty_slugs`** — the uniqueness authority across current slugs *and* aliases
(a unique index on one array field can't stop a new slug colliding with another
link's alias under a race): `{ _id: slugKey, linkId, current: boolean, at }`.
Claiming a slug is an insert; duplicate-key = taken. Deleting a link frees its keys.

**`shorty_link_revisions`** — one doc per destination change (Bitly's history):
`{ linkId, rev, baseUrl, utm, params, hash, destination, by?, at }`.
Index `{ linkId: 1, rev: -1 }` unique. Clicks carry `rev`, so "clicks per
destination period" is a group-by, not a reconstruction.

**`shorty_clicks`** — raw, TTL'd (traps #17: regular collection, not time-series):
`{ linkId, rev, at, visitor: string /* HMAC */, unique: boolean, bot: boolean,
qr: boolean, referrerHost?, referrer?, country?, region?, city?,
browser?, os?, device: 'desktop'|'mobile'|'tablet'|'other', query?: string[] /* incoming param KEYS only */ }`.
Indexes: `{ linkId: 1, at: -1 }`, TTL on `at`.

**`shorty_daily`** — rollups that outlive the TTL:
`{ linkId, day: 'YYYY-MM-DD' /* in clicks.timezone */, clicks, uniques, qr, bots, botUniques }`
— human and bot figures side by side, never pre-summed,
unique `{ linkId: 1, day: 1 }`, upsert `$inc`. Dashboard time series read this;
breakdowns (referrer/country/device) read raw clicks within retention.

**`shorty_seen`** — unique-window dedupe, no Redis:
`{ linkId, visitor, at }`, unique `{ linkId, visitor }`, TTL `uniqueWindowMinutes`.
Insert succeeds → unique; duplicate-key → repeat. One write, no read.

**`shorty_misses`** — orphan visits, capped: `{ path, at, referrerHost? }`, TTL 30 d.

### 7.2 Visitor hash

`visitor = HMAC-SHA256(pepper, dailySalt | ip | ua | linkId)`, `dailySalt`
derived from the date — the Plausible approach. No raw IP stored anywhere. Same
person is not linkable across days or across links, which is the point. Cost:
the 1 h unique window resets at midnight (accepted).

### 7.3 Editing "within reason"

| Field | Rule | Why |
|---|---|---|
| destination (base, utm, params, hash) | always editable; each change writes a revision and bumps `rev` | the core value of a short link; Bitly's history makes it auditable |
| slug | per `slug.rename`: **`alias`** (default) — rename any time, old slug stays a working alias, history lists it; `untilClicked` — rename until the first human click, then `409 slug_locked`; `always` — rename freely, old slug is freed (breaks anything printed; UI says so in the confirm); `never` — fixed at creation | once used, a slug is printed, posted, QR'd. `alias` is the only mode that can't break one, so it's the default; the others exist for operators who want slugs reusable or immutable |
| title / notes / tags / social / redirect / expiry | always editable, no revision | metadata, not where the link goes |
| archive | always; still redirects | Bitly "hide", Dub `archived` |
| delete | allowed, typed-slug confirmation in UI; removes clicks + rollups | hosts need it for erasure; archive is the default action in the UI |

A revision is only written when `destination` actually changes (string compare
after compose) — retyping the same UTM is not a revision.

### 7.4 Param suggestions (`GET /params`) — live, uncached

One aggregation over `shorty_links` (non-archived and archived both — history is
the point):

```
$project { pairs: concat(utm entries as utm_*, params) }
$unwind pairs → $group by (key, value): count, lastUsedAt
$sort count desc → $group by key: values (first 50), totalCount
```
`maxTimeMS: 2000`, values capped per key (traps #18). Response:
`[{ key, count, values: [{ value, count, lastUsedAt }] }]`. Cheap to ~100k links;
a cache is a non-goal until a host proves otherwise. The SPA fetches once per
form open and filters client-side.

The same response drives the form's **lint**: "`Facebook` — 41 links use
`facebook`" (case/whitespace near-duplicates), which is the real reason UTM data
rots.

### 7.5 Redirect pipeline (the hot path)

```
GET|HEAD <mount>/<path>
 1. path → candidate slug. Not slug grammar (has '.', empty, too long) → next(), no DB hit
    (so a root mount never touches /assets/app.js, /favicon.ico, /api/*)
 2. reserved → next()
 3. findOne({ slugKey }) projecting only redirect fields. Miss → onMiss behavior + misses row
 4. expired (date or clicks ≥ maxClicks) → expiredUrl | onExpired
 5. crawler (isbot) AND link.social set → 200 HTML with og:/twitter: tags + meta refresh
    else → status (link override ?? config) to destination (+ forwarded query, minus `qr`)
    headers: Cache-Control: private, max-age=0 (302/307); X-Robots-Tag: noindex
 6. response sent → setImmediate: classify (HEAD | isbot → bot), visitor hash,
    seen insert, clicks insert, daily $inc (human or bot fields), link $inc
    (clicks/uniqueClicks or botClicks), onClick, track.
    Every step try/catch → logger + an in-memory counter; nothing reaches the response.
```
QR codes encode `shortUrl?qr=1`; the flag is recorded and stripped (Dub).
Slashes are allowed in custom slugs (`spring/ig`), so the route is a wildcard;
trailing slash stripped before lookup. Lookup is `findOne({ keys: slugKey })`, so
an alias costs nothing extra. `maxClicks` counts humans only.

### 7.6 `inspect(url)` — OG preview + destination health

Admin-only `POST /inspect { url }`, debounced from the form. **SSRF-safe fetch**
(Dub `safe-fetch.ts` model): http/https only; resolve A/AAAA and reject private /
loopback / link-local / metadata / multicast / reserved; re-check at connect time
(custom `lookup`, defeats rebinding); manual redirects, re-validated each hop,
max 5; 5 s total; read ≤2 MB, stop at `</head>`.

Returns:
```ts
{ og: { title, description, image, siteName, favicon },   // og → twitter → <title> fallback chain
  final: { url, status, ms }, chain: [{ url, status }],
  warnings: Warning[], screenshot?: string /* data URL, only with adapter */ }
```
Warnings — the bit that makes the form better than Bitly's:
- `query_dropped`: destination redirects and the final URL lost the UTMs
  (GA sees direct traffic — the most common silent UTM failure)
- `not_ok`: final status ≥ 400; `redirects`: chain length > 1 (suggest final URL)
- `noindex_destination`, `cloudflare_challenge` (OG unavailable, not broken)
- `utm_incomplete`: some UTMs set but not source+medium+campaign
- `near_duplicate_value` (from §7.4)

## 8. UI shape

**SPA at a mount path** (house default), React, one build, `<base href>` injected
(traps #8). Three screens, simple by default, advanced behind disclosure.

**Principles**
- Simple and clean first. A screen shows what most people need; everything else
  is one disclosure away, never deleted.
- Explain only what a lay person can't read at a glance. "Destination" needs no
  help text; "UTM medium", "redirect type", "forward query", "unique click", "bot
  click", "alias" do. Those get a **tooltip on the label itself** (mailery's
  `Tip`: hover/focus, 250 ms, portal-positioned) — one plain sentence, an example
  where it helps ("Where the traffic comes from, e.g. `instagram`"). Inline help
  text only for consequences people must not miss (renaming under `always`,
  delete, turning `noindex` off).
- Plain words over jargon in visible copy: "Redirect type: Temporary
  (recommended) / Permanent", not bare status codes; the codes live in the tooltip.
- Empty states teach: the first-run list is the create form's pitch, not a blank
  table.

**Visual system** — mailery's tokens, which telemetry already lifted verbatim
(`telemetry/src/ui/styles.css` header): same neutrals, semantic colours, type and
spacing scales, light + dark, same shell. **One swap, as telemetry did: the accent
family** — teal (`#0d9488` / soft `#ccfbf1` / press `#0f766e`), so the three
dashboards read as siblings, not clones. Charts and sparklines hand-rolled SVG
like telemetry's (no chart dependency). Reused by copy (house style — no shared
runtime): mailery `Tip` + `place-tip`, icons, shell; telemetry chart atoms.

**Links list** — search, tag filter, sort (newest / most clicked / last clicked),
archived toggle. Row: favicon + OG thumb, short URL with copy button, destination
host + path (truncated, full on hover), UTM chips, 30-day sparkline, clicks.
Row actions: copy, QR, duplicate, archive. Paste a URL anywhere on the screen →
create form opens prefilled (Dub).

**Create / edit form** (drawer, keyboard-first):
- *Destination* — one input. Pasting a full URL splits it: query → UTM fields +
  custom params, fragment → hash. The URL stays the thing you think about; the
  fields are a view of it (Dub's model, structured storage underneath).
- *Short link* — segmented control **Auto | Custom**. Auto shows the generated
  slug with a regenerate button; Custom validates live (`GET /slugs/check`) with
  the reason when taken/reserved/invalid. Always shows the full short URL.
- *UTM* — five comboboxes (source, medium, campaign, term, content): free text,
  dropdown of previous values with counts, near-duplicate lint inline.
- *Custom params* — key/value rows; both key and value are comboboxes over
  `/params`. Add, reorder, remove.
- **Anatomy panel** (right side, live): the short URL → arrow → the final URL,
  colored by segment (origin · path · utm_* · custom · #hash), each segment
  labelled; incoming-query forwarding shown as a dimmed `+ ?…` tail when on.
  Hover a segment ↔ highlight its field.
- **Preview panel** (tabs): Social card as X / LinkedIn / Facebook / Slack /
  iMessage render it (from `inspect`, or `social` override when set);
  Destination health (final URL, status, chain, warnings with one-click fixes —
  "use final URL"); Screenshot (only with adapter); QR (download PNG/SVG).
- *Notes, tags* — visible.
- **Advanced** (collapsed, remembers state): redirect status, forward query,
  expiry date / max clicks / expired URL, custom social card (title, description,
  image URL with 1200×630 guidance and 120/240 char counters).
- Edit mode adds: revision history (destination diff per rev, clicks per rev,
  slug renames with their aliases), and the slug field behaves per `slug.rename`
  (locked with a tooltip saying why, or a confirm that spells out the effect).

**Link detail / analytics** — clicks + uniques time series (from `shorty_daily`,
range picker). Bots are their own series: a **Bots: Hide / Show separately /
Include** control (default Hide) — "separately" stacks them in a muted band,
"include" sums them into the totals; the choice sticks per viewer. The stats API
always returns human and bot figures apart; combining is a view decision. Then, breakdowns: referrer host, country,
device, browser, OS, QR vs link; revision markers on the chart. **Overview** —
totals, top links, top campaigns (from utm), recent misses.

## 9. Traps answered

| Trap | Answer |
|---|---|
| #2 model registry | `modelPrefix`; models compiled on the given connection |
| #4 route order | admin literals (`/links/stats`, `/slugs/check`, `/params`, `/tags`, `/inspect`) declared before `/:id`; tests named after the shadowing |
| #5 body parser | host's `express.json()`; documented |
| #6 async → HTML | every handler wrapped; redirect router never throws past `next(err)` only for genuine DB outage |
| #8 SPA mount | `<base href>` + escaped config blob; 503 when bundle missing |
| #14 counters | link counters are `$inc` from exactly one code path per click event (a click *is* an event, not set membership); `recount(linkId)` rebuilds `clicks/uniqueClicks` from `shorty_daily`, which never TTLs |
| #15 time | server receipt time only (there is no client clock); rollup day in explicit `clicks.timezone` |
| #16 idempotency | redirects are GETs — browser retries are real hits; the unique window is the dedupe |
| #17 time-series | regular collection + TTL |
| #18 caps | list `limit ≤ 200`, stats range ≤ 400 days, breakdown top-N 50, `maxTimeMS` on every aggregation |
| #19 junk | redirect never 4xx/5xx because of tracking; recording failures counted (`shorty.health()`) |
| #20/#21 types | two tsconfigs; `src/` imports public types from `types/` |

## 10. Non-goals (0.x)

- Password-protected links, cloaking/iframe, A/B splits, device/geo targeting
  (Dub/Shlink have them; schema leaves room — a `rules` field later, not now)
- Webhooks with signing — hooks let the host send them
- Multiple domains / multi-tenant workspaces; folders (tags only)
- Bulk CSV import; UTM templates/macros (duplicate + suggestions cover 90%)
- `slug+` public info page
- Built-in screenshotting, GeoIP database, Safe Browsing / malicious-URL
  classification (`blockedHosts` + the host's own `onCreate` cover it)
- Redirect-lookup cache (one indexed `findOne`; revisit only with numbers)
- Public link creation — creation is admin-only; there is no anonymous shortener

## 11. Size estimate

| Area | Lines |
|---|---|
| types/ (public `.d.ts`) | 350 |
| config + models + indexes | 350 |
| slug gen/normalize/reserved | 120 |
| composeUrl / parseUrl (shared) | 150 |
| link service (CRUD, revisions, lock rule) | 350 |
| redirect router + click pipeline | 300 |
| safe-fetch + OG parse + warnings | 350 |
| stats + params aggregations | 300 |
| admin routes + client | 350 |
| SPA (list, form, anatomy, previews, analytics) | 2,600 |
| **total src** | **~5,200** |
| tests | ~3,000 |

## 12. Sanity checks

- **Degenerate case**: `createShorty({ connection, publicBaseUrl })` + mount
  `redirect` and `routes` — works, stores clicks only once `pepper` is set
  (otherwise `clicks` is forced off with one warning, never a crash). No hooks,
  no adapters, no allowlist cost anything.
- Every key traces to research.md or to an explicit user decision.
- Non-goals non-empty.
- No open questions (§13).

## 13. Resolved review questions

1. **Slug case** → operator config `slug.caseSensitive`, default `false`.
2. **Bots** → recorded and counted separately everywhere (`botClicks`,
   `bots`/`botUniques` in rollups, separate series in the API); the UI chooses
   hide / separate / include.
3. **Renaming** → operator config `slug.rename`, default `'alias'`.

No open questions remain in the plan.

## 14. Work breakdown (Stage 4 preview)

| PR | Who | Contents | Done when |
|---|---|---|---|
| 0 | Frontier | `types/`, model schemas + indexes, `composeUrl`/`parseUrl`, full test suite (red) for every section above; then a cheaper-model untested-surface audit | audit list empty or justified |
| 1 | Sonnet | slug (case modes, claims, all four rename modes), models, link service, revisions | link-service tests green |
| 2 | Sonnet | redirect router + click pipeline + rollups + misses | redirect/click tests green, incl. "tracking failure never changes the response" |
| 3 | Sonnet | safe-fetch, OG parse, warnings, `inspect` | SSRF matrix green (private IPs, rebinding, redirect-to-private, oversize, timeout) |
| 4 | Sonnet | admin routes, stats + params aggregations, `./client` | API tests green |
| 5 | Sonnet | SPA: list + create/edit form + anatomy + previews | Playwright happy paths |
| 6 | Sonnet | SPA: analytics + overview; docs site; examples; CI | `/audit shorty` passes |
| End | Frontier ×3 | (a) redirect hot path — never fails, never leaks, root-mount safety; (b) safe-fetch SSRF; (c) rename modes + slug claims under concurrency, revisions, human/bot counter integrity | — |

Scaffold (`/scaffold shorty`) runs after this plan is approved; plans then move
into the repo's `plans/`.
