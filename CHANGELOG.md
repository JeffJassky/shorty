# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A **peer range widening** is a minor. A peer range *narrowing* is a major — it
breaks installs for people who were relying on the claim, and the claim is only
real if CI runs the matrix. See standards/traps.md #10.

## [Unreleased]

### Added
- Initial extraction.
- Public redirect router (`shorty.redirect`): slug lookup, expiry, social cards for crawlers, query forwarding, `onMiss` handling.
- Click pipeline after the response: bot/human split, unique window, daily rollups, `onClick` / `track`, `drain()` and `health()`.
- Runtime dependencies `isbot` and `ua-parser-js@1` (pinned below 2: v2 is AGPL).
- Admin JSON API (`shorty.routes`), stats (humans and bots always separate), live param-suggestion catalog.

### Requirements
- MongoDB 5.2+ (`$firstN` in the param catalog).
