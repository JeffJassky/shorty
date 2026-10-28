# Factory & instance API

```ts
import createShorty, { createShorty, composeUrl, parseUrl, defaultSpaDir,
  ShortyError, ERROR_STATUS } from '@jeffjassky/shorty';
```

`createShorty(config: CreateShortyConfig): ShortyInstance` validates the
config and returns the instance. Nothing touches the database until
`ready()`. See [Configuration](../guide/configuration).

## Routers

| Member | Notes |
|---|---|
| `redirect: Router` | **Public.** GET/HEAD only. Not a slug (malformed escape, empty, `//`, dot, over-long, reserved) calls `next()` with no lookup. Unknown slug follows `onMiss`. A lookup failure calls `next(err)`. |
| `routes: Router` | **Admin.** The [JSON API](./http). You guard it and supply `express.json()`. |
| `ui(opts?: UiOptions): Router` | **Admin.** The SPA. See [Admin UI](../guide/ui). |

## Lifecycle

| Method | Notes |
|---|---|
| `ready(): Promise<void>` | Creates collections and indexes, reconciles click/seen TTLs with config, re-keys links written under the other `caseSensitive` mode (throws `case_collision` before writing anything). Idempotent; await once at boot. |
| `drain(): Promise<void>` | Resolves when all in-flight click and miss pipelines finish. |
| `health(): ShortyHealth` | Counters. See [Hooks & telemetry](../guide/hooks). |

## Writes

Each takes an optional `ctx: { req? }`; hooks receive it.

| Method | Notes |
|---|---|
| `createLink(input: LinkInput)` | `url` **or** `baseUrl`+`utm`+`params`+`hash`. Omitted `slug` is generated. |
| `updateLink(id, patch: LinkPatch)` | `utm` merges field-wise (`''`/`null` removes); `params` and `tags` replace; `null` clears optionals; `{}` is a no-op. Safe under concurrent edits, renames, clicks and deletes. |
| `archiveLink(id)` / `unarchiveLink(id)` | Hidden from default lists; still redirects. |
| `deleteLink(id)` | Hard delete of link, history, clicks and rollups; frees every key. Returns `{ clicks, history, keys }`. |
| `recount(id)` | Rebuild click counters from daily rollups. |

An unknown `id` is `not_found`.

## Reads

| Method | Notes |
|---|---|
| `link(idOrSlug)` | By id, current slug or alias. `null` when unknown; never throws. |
| `links(query?)` | `{ q, tag, archived: boolean \| 'all', sort: 'newest' \| 'clicks' \| 'lastClicked', cursor, limit }` returning `{ items, nextCursor, limit }`. |
| `history(id)` | `HistoryEntry[]`: `created`, `destination` (with `previous`), `slug` (with `mode`). |
| `stats(query)` | See [Click analytics](../guide/analytics). |
| `paramValues()` | The suggestion catalog. |
| `tags()` | `[{ tag, count }]`. |
| `checkSlug(slug, { linkId? })` | `{ slug, available, reason? }`. |
| `generateSlug()` | A currently unclaimed slug. Not reserved: a create may still race it. |
| `inspect(url)` | See [Link previews & SSRF](../guide/inspect). |
| `shortUrl(linkOrSlug)` | `publicBaseUrl/slug`. |
| `models` | The mongoose models (`Link`, `Slug`, `History`, `Click`, `Daily`, `Seen`, `Miss`, `Meta`) for hosts querying collections directly. |

## Helpers

- `composeUrl(parts)` / `parseUrl(url)`: see [UTM & parameters](../guide/utm).
- `defaultSpaDir()`: the directory of the built SPA.

## Errors

The programmatic API throws `ShortyError { code, status, details? }`. The
routes answer `{ error: code, ...details }` with the status from
`ERROR_STATUS`.

| Code | Status | Meaning |
|---|---|---|
| `invalid_url`, `unsupported_scheme`, `invalid_base_url`, `invalid_param`, `ambiguous_destination`, `validation`, `range_too_large` | 400 | Input errors. |
| `slug_invalid`, `slug_too_long`, `slug_reserved` | 400 | Slug grammar and reserved list. |
| `not_found` | 404 | Unknown link id. |
| `slug_taken`, `slug_locked` | 409 | Claimed elsewhere; rename not allowed in this mode. |
| `host_not_allowed`, `host_blocked`, `destination_loop` | 422 | Destination policy. |
| `case_collision`, `slug_generation_exhausted` | 500 | `ready()` merge refused; generator kept colliding. |

Exact statuses are in `ERROR_STATUS`, which is the single table both the routes
and the tests use.
