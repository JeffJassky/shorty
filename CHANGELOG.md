# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A **peer range widening** is a minor. A peer range *narrowing* is a major — it
breaks installs for people who were relying on the claim, and the claim is only
real if CI runs the matrix. See standards/traps.md #10.

## [Unreleased]

## [0.1.0] - 2026-10-28

First release (0.1.0).

### Added
- `createShorty(config)` returning `redirect`, `routes`, `ui()` and a programmatic API (`createLink`, `updateLink`, `archiveLink`, `unarchiveLink`, `deleteLink`, `link`, `links`, `history`, `stats`, `paramValues`, `tags`, `checkSlug`, `generateSlug`, `inspect`, `shortUrl`, `recount`), plus `ready()`, `drain()` and `health()`.
- Public redirect router: GET/HEAD only, any mount position and route order (`onMiss: 'next'` by default), expiry (date and best-effort `maxClicks`), query forwarding, custom social cards served to crawlers, `X-Robots-Tag: noindex`.
- Structured destinations (`baseUrl`, `utm`, `params`, `hash`), shared `composeUrl` / `parseUrl`, a destination revision history, and a live parameter-suggestion catalog.
- Slugs: generated or custom, case-insensitive by default, four rename modes (`alias`, `untilClicked`, `always`, `never`), claim-based uniqueness across slugs and aliases, and `ready()` re-keying across a `caseSensitive` flip.
- Click analytics: pipeline that runs after the response, daily-rotating HMAC visitor hash (no IP stored), unique window, bot/human split everywhere, daily rollups kept forever, TTL'd raw clicks, `onClick` / `track`.
- Stats API and UI with humans and bots always separate; breakdowns for referrer, country, device, browser, OS and QR vs link; overview with top links and top campaigns.
- Admin JSON API (`shorty.routes`) and typed fetch client (`@jeffjassky/shorty/client`).
- Admin UI: links list, create/edit form with anatomy panel, comboboxes and previews (social cards, destination health, QR), link detail, analytics overview. Hand-rolled SVG charts, light and dark themes, usable at 375px.
- `inspect`: SSRF-hardened destination fetch (DNS resolved once per hop and pinned, address policy allowing public unicast only, `isAllowedAddress` override, linear head parsing).
- Integrity under concurrency: every link carries a write version (`wv`) that `updateLink` pins; claims are released only after confirming the link does not hold them; deletes racing updates or clicks leave no orphan rows; per-link case-mode stamp (`ck`) re-keyed on every boot.
- Hooks (`onClick`, `onCreate`, `onUpdate`, `onArchive`, `onDelete`, `onMiss`), `track`, `geo`, `ip` adapters.
- Hot-path hardening: the slug lookup is bounded by `redirect.lookupTimeoutMs` (default 2000 ms) and fails at once on a closed connection, handing the request to `next(err)`; `clicks.maxInFlight` (default 10000) skips click and miss pipelines past the cap and counts them in `health().dropped`; `onMiss` / `onExpired` are validated at `createShorty`; malformed `%` escapes in forwarded query parts go through verbatim; `Click.queryKeys` is capped at 20 keys of 64 characters (`qr` excluded); `Vary: User-Agent` on every redirect and social card; `Cache-Control: private, max-age=0` on 302/307 redirects and on shorty's own 404 / 410.
- Documentation site, Playwright end-to-end suite (run in CI), runnable example host.

### Dependencies
- Runtime: `isbot`, `ua-parser-js@1` (pinned below 2: v2 is AGPL).

### Requirements
- Node 20+, MongoDB 5.2+ (`$firstN` in the param catalog), mongoose 7 to 9, Express 4.18+ or 5.
