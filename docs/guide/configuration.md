# Configuration

`createShorty(config)` takes a `CreateShortyConfig`. Only `connection` and
`publicBaseUrl` are required. Invalid values throw at creation, not at the
first request. The authoritative declarations, with full doc comments, are in
[`types/index.d.ts`](../reference/types).

## Top level

| Key | Default | Notes |
|---|---|---|
| `connection` | required | A mongoose `Connection` or the `mongoose` module. |
| `publicBaseUrl` | required | Where `redirect` is reachable as the browser sees it. Absolute http(s); trailing slash trimmed. Never inferred. |
| `collectionPrefix` | `'shorty_'` | MongoDB collection prefix. |
| `modelPrefix` | `'Shorty'` | Mongoose model-name prefix. Set it when two instances share a connection. |
| `pepper` | `SHORTY_PEPPER` env | Visitor-hash secret. Without one, click recording is off (one warning). |
| `clicks` | on (with a pepper) | `false` disables recording; or a [click config](#clicks). |
| `listLimit` | `200` | Max rows per list page. |
| `now` | `() => new Date()` | Clock, for tests and replays. |
| `logger` | none | `{ debug, info, warn, error }`, each optional. |


| `ui` | `{}` | Defaults merged into every `ui()` call. |
| hooks | none | `onClick`, `onCreate`, `onUpdate`, `onArchive`, `onDelete`, `onMiss`, `track`. See [Hooks & telemetry](./hooks). |

## `slug`

| Key | Default | Notes |
|---|---|---|
| `length` | `7` | Generated length, integer 3 to 190. |
| `alphabet` | `'23456789abcdefghjkmnpqrstuvwxyz'` | At least 2 distinct characters. |
| `generate` | none | Overrides length and alphabet. Validated and collision-checked. |
| `reserved` | `[]` | Strings (whole slug) or RegExps. **Extends** the built-in list. |
| `caseSensitive` | `false` | Set before your first link. See [Slugs & renaming](./slugs). |
| `rename` | `'alias'` | `'alias' \| 'untilClicked' \| 'always' \| 'never'`. |

## `redirect`

| Key | Default | Notes |
|---|---|---|
| `status` | `302` | `301 \| 302 \| 307 \| 308`. Per-link override wins. |
| `forwardQuery` | `true` | Append incoming params to the destination. Per-link override. |
| `noindex` | `true` | Send `X-Robots-Tag: noindex` on every redirect. |
| `onMiss` | `'next'` | `'next'`, `'notFound'`, or an absolute http(s) URL (302). |
| `onExpired` | `'page'` | `'page'` (410 + HTML), `'notFound'`, or an absolute http(s) URL. A link's `expiredUrl` wins. |
| `lookupTimeoutMs` | `2000` | Budget in ms for the slug lookup; must be > 0. If the Mongo connection is not open the request is handed off immediately; if the budget runs out it goes to `next(err)` with a plain `Error` and your error handler answers. Redirects never stall your own routes at a root mount. |

`onMiss` and `onExpired` are validated at `createShorty`: anything other than a
mode or an absolute http(s) URL throws a `TypeError` naming the key.

## `destinations`

| Key | Default | Notes |
|---|---|---|
| `allowedHosts` | unset (any http(s) host) | Strings match the hostname exactly; RegExps test it. |
| `blockedHosts` | `[]` | Same matching. Refused with `host_blocked`. |

Destinations are **not** checked for public addresses when you save them; only
`inspect`'s fetch is (see [Link previews & SSRF](./inspect)).

A destination that points at `publicBaseUrl` itself (or anything under it) is
refused with `destination_loop`.

## `clicks`

Pass `false` to disable recording, or an object:

| Key | Default | Notes |
|---|---|---|
| `retentionDays` | `395` | Raw click TTL; must be > 0. Daily rollups are kept forever. |
| `uniqueWindowMinutes` | `60` | Unique-visitor window; must be > 0. |
| `timezone` | `'UTC'` | IANA zone that defines a "day" for rollups and stats ranges. |
| `geo` | CDN headers | `(req) => { country?, region?, city? }`. Default reads `cf-ipcountry`, `x-vercel-ip-country`, `cloudfront-viewer-country` (country only). No GeoIP database ships. |
| `ip` | `req.ip` | `(req) => string`. You own `trust proxy`. |
| `maxInFlight` | `10000` | Positive integer. Click and miss pipelines above it are skipped (no rows, no hooks, no `track`) and counted in `health().dropped`. The redirect itself is unaffected. |

## `inspect`

| Key | Default | Notes |
|---|---|---|
| `timeoutMs` | `5000` | Whole-inspect budget: DNS and every hop. |
| `maxBytes` | `2_000_000` | Body read cap. Reading also stops at `</head>`. |
| `maxRedirects` | `5` | Hops followed. |
| `lookup` | `dns.promises.lookup` | `(host) => Promise<string[]>`. Every address is checked. |
| `isAllowedAddress` | public unicast only | `(ip) => boolean`. See [Link previews & SSRF](./inspect). |
| `userAgent` | `'shorty-inspect (+link preview)'` | |

## `ui()` options

| Key | Default | Notes |
|---|---|---|
| `mountPath` | `'/shorty'` | Where `ui()` is mounted, as the browser sees it. |
| `apiBase` | `'/api/shorty'` | Where `routes` is mounted, as the browser sees it. |
| `title` | `'Links'` | Brand name in the top bar. |
| `spaDir` | bundled | Override the built SPA directory. |
| `loginUrl` | `null` | Where to send someone whose session expires mid-page. `null` shows an inline error. |
| `returnParam` | `'next'` | Query parameter carrying the return URL to `loginUrl`. |
