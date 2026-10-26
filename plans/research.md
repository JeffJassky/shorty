# shorty — landscape research (2026-10-26)

Greenfield package: no host implementation to recon, so this replaces stages 1–2.
Sources: Dub (source code, github.com/dubinc/dub), Kutt (thedevs-network/kutt),
YOURLS (source), Shlink (docs), Bitly / Short.io / Rebrandly (support pages).
Where a claim is a third-party figure it says so.

---

## 1. Link creation UX

- **Dub**: default fields are destination, slug (random / AI / custom), link
  preview, tags. Everything else behind buttons + shortcuts: UTM (`U`), cloaking,
  password, expiration, device/geo targeting, search indexing, comments. Pasting
  a URL anywhere in the dashboard opens the builder prefilled. API: `url` is the
  only required field. ([how-to-create-link](https://dub.co/help/article/how-to-create-link.md),
  [create-a-link](https://dub.co/docs/api-reference/endpoint/create-a-link))
- **Kutt**: target, custom URL, password, expire_in, description.
- **Generated slugs**
  - Dub: `nanoid(7)`, base62, `keyLength` 3–190, optional `prefix` (`/c/xxxx`);
    regenerate-and-retry on collision.
  - Shlink: 5 chars default, min 4.
  - Kutt: `LINK_LENGTH=6`, alphabet without look-alikes (o O 0 i I l 1 j).
  - YOURLS: sequential counter in base36/62, skipping taken/reserved.
- **Case**: Bitly case-sensitive (`[A-Za-z0-9_-]`, 255 max, back-half permanently
  bound once used). Dub lowercases unless the domain opts into case-sensitivity.
  Shlink strict by default, `loose` mode since v3.5.
- **Reserved**: Dub blocks `_*`, `.well-known*`, `*.php`, `favicon.ico`,
  `robots.txt`, `sitemap.xml`, `manifest.json`, `apple-app-site-association`, plus
  app routes on shared domains; NFD-normalizes keys to strip accents (homographs).
  Kutt `preservedURLs`, YOURLS `$yourls_reserved_URL`.
- **OG scrape (Dub `app/api/links/metatags/utils.ts`)**: ≤2 MB, stop at `</head>`.
  Title `og:title → twitter:title → <title> → URL`; description
  `description → og:description → twitter:description`; image
  `og:image → twitter:image → image_src → <link rel=icon> → shortcut icon` (never
  guesses `/favicon.ico`). Relative images resolved; non-public image hosts
  dropped; Cloudflare challenge pages detected; on failure falls back to last path
  segment + "Visit host/path". Shlink resolves `<title>` only.
- **Custom OG override (Dub "custom link previews")**: `proxy: true` + title/
  description/image/video. 1200×630 recommended, ≤1.5 MB, title ≤120, description
  ≤240. Crawlers get a proxy page with those tags; humans get redirected. Builder
  previews X / Facebook / LinkedIn cards.
- **Screenshot previews**: none of the products surveyed document one.
- **QR**: Dub appends `?qr=1`, records `trigger="qr"`, strips the param. Shlink's
  `/qr-code` deprecated in v4.5. Bitly counts "engagements" = clicks + scans.

## 2. UTM handling

- **Dub**: source, medium, campaign, term, content (+ `ref`). Workspace UTM
  templates in their own table. **The destination URL is the source of truth** —
  the modal parses UTMs out of it and writes them back
  (`getParamsFromURL` / `constructURLFromUTMParams`), so a pasted URL's UTMs
  appear in the fields. API UTM fields set-or-override. Suggestion dropdowns and
  `{{macro}}` tokens in `packages/ui/src/utm-builder.tsx`.
- **Bitly**: source/medium/campaign required when UTMs are used; saved UTM sets
  are a paid feature. **Rebrandly**: named UTM presets.
- `utm_id` / `utm_source_platform`: no product documents support.

## 3. Redirect behavior

- **Status**: Dub 302 for links (301 only for root-domain redirects) so edits take
  effect and every click is counted. Kutt 302 (`res.redirect`). Shlink 302,
  configurable 301/307/308, cache lifetime only on 301/308. YOURLS hardcodes 301;
  plugins exist to change it and their authors note browsers had already cached
  the old 301s. Bitly + Rebrandly say 301 (SEO argument). Short.io per-link choice.
- **Query forwarding**: Dub always forwards, incoming wins, strips `qr` and
  internals. Shlink forwards by default, per-link opt-out. Rebrandly forwards.
- **Targeting**: Dub `ios` / `android` / `geo` + A/B (2–4 URLs). Shlink
  prioritized rule engine (device, Accept-Language, query param).
- **Expiration**: Dub `expiresAt` + `expiredUrl`, else an "Expired" page; no
  tracking after expiry. Shlink `validSince` / `validUntil` / `maxVisits`.
  Short.io date or click count (counts bots).
- **Password**: Dub form / `?pw=` / per-link cookie, click tracked only after the
  right password. Kutt bcrypt + form + HTTP Basic.
- **Cloaking**: Dub `rewrite` (frame). Short.io Pro.
- **`slug+` info page**: Bitly, Kutt, YOURLS, Dub (skipped when password-protected).
- **Unknown slugs**: Dub per-domain not-found. Kutt → homepage or `/404`. Shlink
  separate invalid-slug / base-URL / 404 redirects, and logs them as
  "orphan visits".
- **Trailing slash**: Shlink opt-in; Dub strips leading/trailing slashes.
- **Indexing**: Dub `doIndex=false` default; Shlink non-crawlable by default.

## 4. Editing

- Dub: destination freely editable, key changeable via API.
- Bitly: destination change = a "redirect", monthly-capped per plan; keeps a
  history of every past destination with its date range and click count; edited
  links can't be deleted.
- Kutt: target, slug, description, expiry, password all editable.
- Only Bitly visibly keeps destination history.

## 5. Click analytics

- **Dub per click**: timestamp, click id, link/domain/key/final url, IP (blanked
  for EU, otherwise raw), geo to city + lat/long, full parsed UA, bot flag, qr
  flag, trigger, referer domain (sans www or "(direct)") + full referer.
- **Dub bots** (not recorded): HEAD, `?bot`, `isBot` UA, UA regex, referer list,
  IP/CIDR list.
- **Dub dedupe**: sha256(IP+UA); same identity + key not re-recorded for 1 h.
- **Kutt**: `isbot`, then only browser, OS, country (geoip-lite or
  `cf-ipcountry`), referrer host, in aggregated rows. No IP stored.
- **Shlink**: anonymizes IP by default (GDPR); toggles to disable IP / referrer /
  UA tracking; `potentialBot` flag rather than exclusion; GeoLite2; `/track` pixel.
- **Bitly**: best-effort bot filtering; one IP clicking excessively treated as bot
  for a while; unique ≈ per device/browser.
- **Retention**: Dub reportedly 30 days free / 1 year Pro (third-party, unverified).
- **Webhooks (Dub)**: `link.created|updated|deleted|clicked`, envelope
  `{id, event, createdAt, data}`, HMAC-SHA256 `Dub-Signature` over raw body.

## 6. Organization

- Dub: tags (many per link, case-insensitive), folders, `archived`, comments,
  `externalId`.
- Bitly: "hide" (still redirects) vs permanent admin-only delete (not allowed once
  edited). CSV/XLSX bulk with only long URL required.
- Kutt: search + admin filters. Shlink: tags, `delete-expired` command.

## 7. Security

- **SSRF (Dub `safe-fetch.ts`)**: http/https only; resolve A/AAAA and reject
  private / loopback / link-local / metadata / multicast / reserved; fail closed
  on DNS failure; manual redirects re-validated each hop, max 5; 5 s timeout;
  Node variant checks IP at connect time (DNS rebinding).
- **Malicious destinations**: Dub domain block/allow lists + banned terms + LLM
  classifier. Kutt banned domains + DNS-resolved banned host IPs. No surveyed code
  uses Google Safe Browsing.
- **Rate limits**: Kutt optional; Dub per plan.

## 8. Consensus defaults

1. Random 6–7 char slugs, base62 or look-alike-free; retry on collision. Custom
   slugs `[A-Za-z0-9_-]`, up to ~190.
2. 302 default; per-link 301/307/308.
3. Forward incoming query by default, incoming wins, per-link opt-out.
4. Destination editable, with history.
5. Reserve `_*`, `.well-known`, `favicon.ico`, `robots.txt`.
6. Expiry by date and/or max clicks, optional fallback URL, else an "expired"
   page. Configurable unknown-slug behavior.
7. Passwords bcrypt; click counted only after the right password.
8. Bots excluded (`isbot` + HEAD). Dedupe IP+UA hash per link for 1 h. Total +
   unique clicks.
9. IP anonymized by default; country, parsed UA, referrer host.
10. `noindex` by default.
11. OG scrape server-side behind SSRF guards, ≤2 MB / `</head>`, ~5 s, og →
    twitter → `<title>` fallback.
12. Archive (hide, keep redirecting) over delete.

## Worth stealing

- Dub: destination URL as single source of truth, UTM UI as a parse/write view.
- Dub: bot-aware OG proxy (crawlers get the custom card, humans get a 302).
- Dub: `?qr=1` attribution.
- Shlink: orphan-visit logging (unknown slugs).
- Bitly: destination history with clicks per period.
- Kutt: look-alike-free alphabet.
- `slug+` inspect page.
- Dub: `link.*` events with HMAC signatures.
