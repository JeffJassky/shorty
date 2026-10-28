# Admin UI

![The create form with live anatomy and previews](/ui-form.png)

`shorty.ui(opts)` returns an Express router serving a prebuilt React app. It
needs no bundler in your app and works from any host framework. It talks to
`shorty.routes` through the typed client.

```js
app.use('/admin/links/api', requireAdmin, shorty.routes);
app.use('/admin/links', requireAdmin, shorty.ui({
  mountPath: '/admin/links',     // where ui() is mounted, as the BROWSER sees it
  apiBase: '/admin/links/api',   // where routes is mounted, as the browser sees it
  title: 'Links',
  loginUrl: '/login',            // optional
}));
```

If the bundle is missing, `ui()` answers 503 rather than a blank page. It
injects a `<base href>` and an escaped config blob, so any mount path works.

## The guard is yours

::: danger
`routes` and `ui()` trust whoever reaches them. shorty cannot know what "admin"
means in your app, so your middleware is the entire boundary. A refactor that
drops it silently exposes link management, edits and deletion.
:::

Write a test that asserts an unauthenticated request to both mounts is
refused. `examples/express/server.js` shows the shape; the example's
`admin-guard.test.js` is meant to be copied into your suite.

## `loginUrl`

When a session expires mid-page the API answers 401 or 403. With `loginUrl`
set, the UI sends the person to `loginUrl?next=<current URL>` (the parameter
name is `returnParam`), and the hash is preserved, so they return to the exact
screen. Without it, the UI shows an inline error.

## Screens

- **Links** (`#/`): search, tag filter, sort, show archived, infinite scroll.
  Each row has a copy button, UTM chips and a 30-day sparkline. Click a row
  for its detail; Edit, QR, Duplicate and Archive are in the row menu. Paste a
  URL anywhere on the list to start a link. `N` starts a new link and `/`
  focuses search.
- **New / edit** (`#/new`, `#/links/:id/edit`): see below.
- **Link detail** (`#/links/:id`): clicks, unique visitors, QR scans, last
  click, a time series with destination-change markers, and breakdowns by
  referrer, country, device, browser, OS and QR vs link.
- **Analytics** (`#/analytics`): the same across all links, plus top links
  and top campaigns.

![Analytics overview](/ui-analytics.png)

Both analytics screens have a range picker (7 days, 30 days, 90 days,
12 months, custom up to 400 days; the interval switches from day to week to
month automatically) and the Bots control described under
[Click analytics](./analytics). Analytics are hidden when click recording is
off.

## The form

Paste a full URL and it splits into base URL, UTM fields, extra parameters and
hash. The short link is **Auto** (generated, with a regenerate button) or
**Custom** (validated live against your slug rules). UTM and parameter fields
are comboboxes over your existing values with near-duplicate lint. A live
**anatomy** panel colours the final URL by segment, and the preview tabs show
social cards (X, LinkedIn, Facebook, Slack, iMessage), destination health with
one-click fixes, and a downloadable QR code. The slug
field follows `slug.rename`: locked with an explanation, or a confirm that
spells out what breaks.

Dark mode follows the system setting. The UI works down to 375px wide.
