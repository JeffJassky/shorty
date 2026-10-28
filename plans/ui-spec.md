# shorty — UI spec (PR 5 + PR 6)

Frontier-authored design so the SPA PRs carry no open design decisions. The
user's brief: **simple, clean, helpful; descriptors only where a lay person
can't read it at first glance; tooltips preferred; mailery/telemetry visuals.**
The create form is the showcase.

Everything here talks to the server only through `createShortyClient`
(`src/client/index.ts`) using `UiRuntimeConfig` from `window.__SHORTY__`. No
new server endpoints.

---

## 0. Foundations

**Copy, don't import** (house style: no shared runtime between packages):

| From | Take | Into |
|---|---|---|
| `mailery/src/client/styles.css` | tokens (`:root` + dark), base, `.app/.main/.content`, `.topbar`, `.btn*`, `.icon-btn`, `.card*`, `.table`, `.pill`, `.tag`, `.kpis/.kpi*`, `.spark`, `.input/.select/.textarea`, `.field*`, `.toggle`, `.split*` | `src/ui/styles.css` |
| `mailery/src/client/components/tip.tsx` + `lib/place-tip.ts` | `Tip` as-is | `src/ui/components/tip.tsx`, `src/ui/lib/place-tip.ts` |
| `mailery/src/client/components/icons.tsx` | the icon set; add `Link`, `Copy`, `QrCode`, `Archive`, `Refresh`, `ExternalLink`, `Chevron`, `Warning`, `Check` in the same stroke style | `src/ui/components/icons.tsx` |
| `telemetry/src/ui/atoms.jsx` | `StatTile`, `TimeSeries`, `BreakdownTable`, `fmtNumber` (port to TSX) | `src/ui/components/charts.tsx` |

**Accent swap** (the only token change, as telemetry did with violet):
`--accent: #0d9488; --accent-soft: #ccfbf1; --accent-press: #0f766e;
--accent-fg: #ffffff; --accent-border: #99f6e4;` and dark-mode equivalents
(`--accent: #2dd4bf; --accent-soft: rgba(45,212,191,.12); --accent-press:
#5eead4; --accent-border: rgba(45,212,191,.3)`). Brand mark: a teal rounded
square with a `↗` glyph; name from `config.title` (default "Links").

**No sidebar.** Shorty has three screens; a topbar with the brand, two tabs
(**Links**, **Analytics**) and a primary **New link** button replaces it.
Route state lives in the URL hash (`#/`, `#/new`, `#/links/:id`,
`#/links/:id/edit`, `#/analytics`) so links in the UI are shareable and
`onUnauthenticated` returns people to the exact view.

**Layout:** `.content-inner` max 1120px. ≥ 900px: form drawer is a right-side
sheet (560px) over the list; < 900px: full-screen sheet. Must work at 375px.

**Data state:** one small `useAsync` hook (`loading | ready | error`, plus
`reload`). Errors render inline (`role="alert"`) with the server `error` code
mapped to a sentence (§5). No global spinners — skeleton rows.

---

## 1. Links list (`#/`)

**Header row:** search input (placeholder "Search links"), tag filter
(select, from `client.tags()`), sort select (Newest · Most clicked · Last
clicked), "Show archived" toggle. Debounce search 250ms. Infinite scroll via
`nextCursor` ("Load more" button fallback).

**Row** (table on ≥ 900px, stacked card below):
- favicon (from `og.favicon`, else a neutral globe icon) + **title** (or the
  destination host + path when no title), truncated.
- short URL in mono, with a copy icon-button (copies `shortUrl`; button flips
  to a check for 1.2s; `aria-live` "Copied").
- destination: host bold + path muted, truncated; full URL in a `Tip`.
- UTM chips: up to 3 `.tag`s `source · medium · campaign` values; `+n` overflow
  with all in a `Tip`.
- 30-day sparkline (from `client.stats({ linkId, from, to })` — fetch lazily
  per visible row, max 6 in flight; cache per session).
- clicks: humans number; bots shown only when > 0 as a muted `+n bots`.
- row actions (kebab on hover/focus): Copy · QR code · Duplicate · Edit ·
  Archive/Unarchive. Duplicate opens the create form prefilled with
  everything except slug (slug → Auto).
- archived rows: muted, with an "Archived" pill.

**Paste anywhere:** a `paste` event on the list (not inside an input) whose
text parses with `parseUrl` opens the create form prefilled (Dub). A one-time
hint under the header: "Tip: paste a URL anywhere to start a link." dismissed
on first use (localStorage, try/catch).

**Empty state (first run):** a centered card: headline "Make your first short
link", one sentence ("Shorten a URL, add campaign tags, and see who clicks."),
a single URL input + **Create** button that opens the form prefilled. No table
chrome until a link exists.

---

## 2. Create / edit form (`#/new`, `#/links/:id/edit`) — the showcase

Two columns inside the sheet on ≥ 1100px viewport (form left, live panels
right); single column with panels below the form otherwise.

### 2.1 Fields, in order

1. **Destination** — one wide input, autofocus. On paste/blur: `parseUrl` →
   fill base URL + UTM + params + hash; the input then shows only the base
   URL. Invalid → inline "That doesn't look like a web address." Non-http →
   "Only http and https links can be shortened."
2. **Short link** — segmented control **Auto | Custom**.
   - Auto: shows `publicBaseUrl/` + generated slug (from
     `client.generateSlug()`) in mono with a ↻ regenerate button (Tip:
     "Pick another random ending").
   - Custom: input prefixed visually with `publicBaseUrl/`; live
     `client.checkSlug` (debounced 300ms) → check icon "Available", or the
     reason sentence (§5). Normalization shown live ("Café" → "Cafe").
   - Edit mode follows `config.slug.rename` (§2.4).
3. **Campaign tracking (UTM)** — a titled group, collapsed to a one-line
   summary when empty ("Add campaign tags"); open by default when any UTM is
   set. Five comboboxes in a 2-column grid: Source, Medium, Campaign, Term,
   Content (Term/Content under a "More" disclosure). Labels carry Tips (§4).
4. **Extra parameters** — key/value rows; both cells are comboboxes; add row
   (+), remove (×), drag handle to reorder (keyboard: Alt+↑/↓). Collapsed to
   "Add parameter" when none.
5. **Title** (optional; placeholder pulls `og.title` when known) and
   **Notes** (textarea, 3 rows) and **Tags** (chip input with suggestions from
   `client.tags()`).
6. **Advanced** — collapsed disclosure (remember open state per viewer):
   - Redirect type: radio "Temporary (recommended)" / "Permanent" with a Tip
     carrying the status codes; "Permanent" shows inline: "Browsers remember
     permanent redirects — later edits may not reach people who already
     clicked." Under it, a small select for 307/308 only when the operator
     default isn't 302 (otherwise hidden — keep it simple).
   - "Pass along extra URL parameters" toggle (forwardQuery) with Tip.
   - Expiry: date-time picker, "Stop after N clicks" number, "Then send people
     to" URL (expiredUrl). Tip on "clicks": "Counts people, not bots."
   - Custom social card: title (counter /120), description (counter /240),
     image URL (hint "1200 × 630 works best"). Tip on the group: "Shown when
     the link is shared on social apps. People who click still go to the
     destination."

### 2.2 Comboboxes (UTM + params)

Built on `client.paramValues()` (fetched once per form open). Free text always
allowed. Dropdown lists previous values with a muted count ("instagram · 41
links"), filtered by prefix then substring, ↑/↓/Enter/Esc, ARIA combobox
pattern. **Near-duplicate lint** inline under the field when the typed value
differs only by case/whitespace/punctuation from an existing value: "41 links
use `instagram` — use that instead?" with a one-click **Use instagram**. Key
comboboxes for params exclude `utm_*` keys.

### 2.3 Live panels (right column)

**Anatomy** (always visible once a destination exists): two lines.
- Line 1: the short URL (`publicBaseUrl` muted + slug strong).
- ↓ connector with the redirect type as a tiny label ("temporary").
- Line 2: the final URL from `composeUrl`, broken into coloured segments:
  origin · path · each `utm_*=value` · each custom param · `#hash`. Each
  segment has its own soft background (origin/path neutral, UTM = accent
  soft, custom = amber soft, hash = neutral dashed). When forwardQuery is on,
  a dimmed `+ ?…` tail with Tip "Parameters on the short link are passed
  along."
- Hovering/focusing a segment highlights its field and vice versa.
- A copy button for the final URL.

**Preview** (tabs: **Social** · **Destination** · **QR**), driven by `client.inspect(baseUrl+query)`
debounced 600ms after the destination settles; stale results fade.
- Social: card mockups for **X**, **LinkedIn**, **Facebook**, **Slack**,
  **iMessage** — each a faithful-enough frame (image ratio, title lines,
  domain line) using `social` override when set, else `og`. Missing image →
  that platform's text-only layout.
- Destination: final URL, status as a pill (green 2xx, amber 3xx chain, red
  ≥ 400), response time, and the redirect chain as a vertical list. Warnings
  as `.card` rows with icon + `message` + the fix button where present
  ("Use final URL" replaces the destination). `private_address` →
  "Preview isn't available for internal addresses." (not an error tone).
- QR: canvas rendering of `shortUrl?qr=1` (bundle `qrcode`), size 240,
  download PNG and SVG buttons. Tip: "Scans are counted separately from
  clicks."

### 2.4 Edit mode extras

- Slug field per `config.slug.rename`:
  - `alias`: editable; on change, a calm inline note "The old link
    (`…/spring`) will keep working."
  - `untilClicked`: editable until `clicks > 0`, then read-only with a lock
    icon + Tip "Locked after the first click so printed links keep working."
  - `always`: editable; on save with a changed slug, a confirm dialog: "Change
    the short link? Anyone using `…/spring` will get a 'not found' page."
  - `never`: read-only with lock icon + Tip "Short links can't be renamed."
- **History** section (below the form): timeline from `client.history(id)` —
  created, destination changes (old → new, diff-highlighted), renames. Each
  destination revision shows its click count from stats `breakdowns.revision`.
- Footer: **Save** (primary), **Cancel**, and on the left a muted **Archive**
  text button; **Delete** lives in the kebab of the history header and
  requires typing the slug.

On save: the form sends the last `inspect` OG as `og` so the list has
thumbnails; on success, toast "Link saved" with a Copy button and the drawer
closes (create) or stays (edit).

---

## 3. Link detail + Analytics (`#/links/:id`, `#/analytics`) — PR 6

Shared pieces: range picker (7d · 30d · 90d · 12m · custom), interval auto
(day ≤ 90d, week ≤ 12m... month beyond), **Bots** segmented control: **Hide**
(default) · **Show separately** · **Include** — persisted per viewer
(localStorage, try/catch). Tip: "Bots are automated visitors like search
crawlers and link previewers."

- **Link detail:** header (title, short URL + copy, destination, Edit button),
  KPI tiles (Clicks, Unique visitors (Tip: "First click from a visitor within
  an hour"), QR scans, Last click), the time series (humans line; bots as a
  muted stacked band when "separately"; summed when "include"), revision
  markers as vertical ticks with a Tip ("Destination changed"), breakdown
  cards in a 2-col grid: Referrers, Countries, Devices, Browsers, Operating
  systems, QR vs link. `breakdownsTruncated` → a quiet note "Details older
  than N days aren't kept; totals are."
- **Analytics overview:** KPI tiles across all links, the series, Top links
  (click → detail), Top campaigns, plus Referrers/Countries/Devices.

All charts hand-rolled SVG (port telemetry `TimeSeries`), tabular numbers,
both themes.

---

## 4. Tooltip copy (labels that get a `Tip`, nothing else does)

| Label | Tip |
|---|---|
| Source | Where the traffic comes from, e.g. `instagram` or `newsletter`. |
| Medium | The kind of channel, e.g. `social`, `email`, `cpc`. |
| Campaign | The campaign or promotion name, e.g. `spring_sale`. |
| Term | Paid-search keyword, if any. |
| Content | Tells apart links in the same campaign, e.g. `header_button`. |
| Extra parameters | Anything else to add to the destination URL. |
| Redirect type | Temporary (302) lets you change the destination later. Permanent (301) is cached by browsers. |
| Pass along extra URL parameters | If someone opens the short link with `?ref=x`, it's added to the destination. |
| Stop after N clicks | Counts people, not bots. |
| Unique visitors | First click from a visitor within an hour. |
| Bots | Automated visitors like search crawlers and link previewers. |
| QR scans | Clicks that came from this link's QR code. |
| Auto / Custom | Auto picks a short random ending. Custom lets you choose it. |

Field hints (inline, always visible) are reserved for consequences: permanent
redirect warning, `always` rename warning, delete confirmation, expiry
fallback.

## 5. Error copy (server `error` code → sentence)

`invalid_url` "That doesn't look like a web address." · `unsupported_scheme`
"Only http and https links can be shortened." · `host_not_allowed` "Links to
this site aren't allowed here." · `host_blocked` "Links to this site are
blocked." · `destination_loop` "A short link can't point to another short link
on this site." · `slug_invalid` "Use letters, numbers, - and _ (and / between
words)." · `slug_too_long` "That's too long — 190 characters max." ·
`slug_reserved` "That ending is reserved." · `slug_taken` "That ending is
already in use." · `slug_locked` "This short link can't be renamed." ·
`validation` "Something in the form needs fixing." (+ field focus when
`details.field`) · `not_found` "This link no longer exists." · anything else
"Something went wrong. Try again."

## 6. Accessibility + keyboard

- Every interactive element reachable by Tab; visible focus ring (`--accent`).
- `N` opens New link (when focus isn't in a field); `/` focuses search;
  `Esc` closes the sheet (confirm if dirty); `⌘/Ctrl+Enter` saves.
- Comboboxes follow WAI-ARIA combobox 1.2; Tips are `aria-describedby`.
- Colour is never the only signal (warnings have icons + text).

## 7. Files (PR 5)

```
src/ui/main.tsx            (exists — keep the config hand-off)
src/ui/App.tsx             router + topbar
src/ui/lib/{router,use-async,format,errors}.ts
src/ui/components/{tip,icons,combobox,segmented,disclosure,toast,dialog,copy-button,sheet}.tsx
src/ui/screens/links.tsx
src/ui/screens/link-form/{index,anatomy,preview,social-cards,history,qr}.tsx
src/ui/styles.css
```
PR 6 adds `src/ui/components/charts.tsx`, `src/ui/screens/{link-detail,analytics}.tsx`.

New devDeps allowed: `qrcode` (+ `@types/qrcode`) — bundled into the SPA, not
a runtime dep; `@playwright/test`.

## 8. Tests (Playwright, `test/e2e/`, run against `examples/express/server.js`)

PR 5:
1. empty state → paste URL with UTMs → form opens with fields split; anatomy
   shows coloured UTM segments; save; row appears with copy button that
   copies the short URL.
2. custom slug: taken → reason shown; available → check; save.
3. combobox: second link's Source suggests the first link's value with count;
   near-duplicate lint offers the existing value.
4. edit under default `alias`: rename shows the "old link keeps working" note;
   after save, the old short URL still redirects (request via `page.request`).
5. archive hides from list; "Show archived" shows it.
6. 375px viewport: create flow completes; no horizontal scroll.

PR 6:
7. after 3 human + 1 bot request to a short URL, detail shows Clicks 3; Bots
   "Include" shows 4; "Show separately" renders the bot band.
8. analytics overview lists the link under Top links.
