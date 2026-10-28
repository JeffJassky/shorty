# HTTP API

The admin JSON API is `shorty.routes`. JSON in, JSON out. Dates are ISO
strings. Errors are `{ error: code, ...details }` with the status from
[`ERROR_STATUS`](./factory#errors); an unexpected failure is
`500 { error: 'internal_error' }` (logged).

`:id` is an ObjectId string; anything else is 404 `not_found`. Unknown paths
fall through with `next()`. A missing body (you forgot `express.json()`) is
treated as empty input: a 400, not a crash.

## Admin routes

| Method | Path | In | Out |
|---|---|---|---|
| GET | `/links` | `?q&tag&archived&sort&cursor&limit` | `{ items, nextCursor, limit }` |
| POST | `/links` | `LinkInput` | `{ link }` (201) |
| GET | `/links/:id` | | `{ link }` |
| PATCH | `/links/:id` | `LinkPatch` | `{ link }` |
| POST | `/links/:id/archive` | | `{ link }` |
| POST | `/links/:id/unarchive` | | `{ link }` |
| DELETE | `/links/:id` | | `{ deleted: { clicks, history, keys } }` |
| GET | `/links/:id/history` | | `{ items: HistoryEntry[] }` |
| GET | `/links/:id/stats` | `?from&to&interval&top` | `Stats` |
| GET | `/stats` | `?from&to&interval&top` | `Stats` (overview) |
| GET | `/params` | | `{ items: ParamKeyStat[] }` |
| GET | `/tags` | | `{ items: TagStat[] }` |
| GET | `/slugs/check` | `?slug&linkId` | `SlugCheck` |
| GET | `/slugs/generate` | | `{ slug }` |
| POST | `/inspect` | `{ url }` | `InspectResult` |

Literal routes (`/stats`, `/params`, `/slugs/...`) are declared before `/:id`.

## Public redirect

`shorty.redirect` is not a JSON API. For `GET`/`HEAD <mount>/<slug>`:

| Outcome | Response |
|---|---|
| Known slug (or alias) | Redirect (`302` by default) to the destination, with incoming parameters forwarded, `X-Robots-Tag: noindex`, and `Cache-Control: private, max-age=0` for 302/307 |
| Known slug, crawler, link has a custom social card | `200` HTML with `og:` / `twitter:` tags and a meta refresh |
| Expired link | `expiredUrl`, or `onExpired` (410 page by default) |
| Unknown slug | `onMiss` (`next()` by default) |
| Not a slug, or not GET/HEAD | `next()` |

Every link redirect and card carries `Vary: User-Agent`; shorty's own 404 and 410 carry `Cache-Control: private, max-age=0`. A lookup failure or `lookupTimeoutMs` overrun calls `next(err)`.

`?qr=1` marks a QR scan and is stripped before forwarding.
