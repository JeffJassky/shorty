# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A **peer range widening** is a minor. A peer range *narrowing* is a major — it
breaks installs for people who were relying on the claim, and the claim is only
real if CI runs the matrix. See standards/traps.md #10.

## [Unreleased]

### Added
- Hot-path hardening: the link lookup is bounded by `redirect.lookupTimeoutMs` (and fails at once on a closed connection); `clicks.maxInFlight` skips and counts (`health().dropped`) pipelines past the cap; malformed escapes in forwarded query parts go through verbatim; `queryKeys` is capped at 20 keys of 64 chars; `Vary: User-Agent` on every redirect and card, `Cache-Control: private, max-age=0` on shorty's own 404 / 410.
- Initial extraction.
- Public redirect router (`shorty.redirect`): slug lookup, expiry, social cards for crawlers, query forwarding, `onMiss` handling.
- Click pipeline after the response: bot/human split, unique window, daily rollups, `onClick` / `track`, `drain()` and `health()`.
- Runtime dependencies `isbot` and `ua-parser-js@1` (pinned below 2: v2 is AGPL).
- Admin JSON API (`shorty.routes`), stats (humans and bots always separate), live param-suggestion catalog.
- Integrity under concurrency: every link carries a write version (`wv`) that `updateLink` pins, so renames and edits planned from a stale read are re-planned; renames never release a claim the link may hold (lost acks included); a case-only slug change just updates the display form; redirect patches write only the fields they name; deletes racing updates or clicks leave no orphan history, click or daily rows.
- Case-mode stamp (`ck`) per link: `ready()` re-keys every link written under the other mode on every boot, checks collisions across all links first, and sweeps stale claims, so rolling deploys across a `caseSensitive` flip converge on the last instance to boot.

### Requirements
- MongoDB 5.2+ (`$firstN` in the param catalog).
