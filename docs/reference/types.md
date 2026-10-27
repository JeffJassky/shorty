# Types

shorty's published contract is hand-written TypeScript declarations:
[`types/index.d.ts`](https://github.com/JeffJassky/shorty/blob/main/types/index.d.ts)
for the package and
[`types/client.d.ts`](https://github.com/JeffJassky/shorty/blob/main/types/client.d.ts)
for `@jeffjassky/shorty/client`. Every field is documented there, and the
implementation imports from them, never the reverse.

## Main shapes

| Type | What |
|---|---|
| `CreateShortyConfig` | The factory config. See [Configuration](../guide/configuration). |
| `ShortyInstance` | What `createShorty` returns. See [Factory](./factory). |
| `Link` | A link as the API returns it: `id`, `slug`, `aliases`, `shortUrl`, `baseUrl`, `utm`, `params`, `hash`, `destination`, `rev`, counters (`clicks`, `uniqueClicks`, `botClicks`), expiry, social card, `og`, `archived`, timestamps. |
| `LinkInput`, `LinkPatch` | Create and update payloads. |
| `UrlParts`, `Utm`, `Param` | The structured destination. |
| `HistoryEntry` | `created`, `destination` or `slug`, each with `at`. |
| `Click`, `ClickEvent` | One recorded hit, and the `onClick` payload. No IP field exists. |
| `Stats`, `StatsQuery`, `StatsPoint`, `Breakdown` | Analytics. Humans and bots are always separate. |
| `ParamKeyStat`, `TagStat` | Suggestion catalog and tags. |
| `InspectResult`, `InspectWarning` | Destination preview. |
| `ScreenshotAdapter`, `TrackFn`, `ResolveUser` | Adapter signatures. |
| `ShortyError`, `ShortyErrorCode`, `ERROR_STATUS` | Errors. |
| `UiOptions`, `UiRuntimeConfig` | UI mount options, and the config blob handed to the browser. |
| `LinkDoc`, `ClickDoc`, `DailyDoc`, ... | Storage documents, for hosts that query the collections directly. |

Client-side: `ShortyClient`, `ClientOptions`, `ApiError`, `Json<T>`, `LinkJson`.

## Collections

With the default `collectionPrefix` of `shorty_`: `shorty_links`,
`shorty_slugs` (uniqueness authority across slugs and aliases),
`shorty_history`, `shorty_clicks` (TTL), `shorty_daily` (rollups),
`shorty_seen` (unique window, TTL), `shorty_misses` (TTL 30 days),
`shorty_meta`. They are reachable as `shorty.models`.
