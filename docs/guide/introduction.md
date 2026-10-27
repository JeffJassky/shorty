# Introduction

shorty is a short-link service you embed in your own Express app. It stores
links in your MongoDB, redirects people to their destinations, counts clicks,
and ships a React admin UI you mount behind your own login.

```
https://acme.com/go/spring   →   https://acme.com/sale?utm_source=instagram&utm_medium=social&utm_campaign=spring
```

![The links list](/ui-list.png)

## What you get

- **Redirects** (`shorty.redirect`): public, GET/HEAD only, one indexed lookup
  per hit. Mount it at a path, at `/`, or on its own host.
- **Admin API** (`shorty.routes`): a JSON API for links, history, stats, the
  parameter catalog, slug checks and destination previews.
- **Admin UI** (`shorty.ui()`): a prebuilt single-page app. List, create/edit
  form, link detail, analytics overview.
- **Programmatic API**: everything the UI does is a method on the instance
  (`createLink`, `updateLink`, `stats`, ...).
- **Typed client** (`@jeffjassky/shorty/client`): the fetch client the UI uses.

## Why embed

A hosted shortener means a second account, a second login and your campaign
data in someone else's database. shorty gives you the parts that matter for
marketing links (structured UTMs, history, click analytics) without leaving
your app, and without a Redis, queue or worker to run.

## Design choices worth knowing

- **Destinations are structured.** A link stores `baseUrl`, `utm`, `params`
  and `hash` separately and composes the final URL. That is what makes
  suggestions and campaign roll-ups possible. See [UTM & parameters](./utm).
- **Editing is safe by default.** Changing a destination writes a revision.
  Renaming a slug keeps the old one working unless you configure otherwise.
  See [Slugs & renaming](./slugs).
- **Tracking never touches the redirect.** The response is sent first; click
  recording runs afterwards and any failure is counted, not surfaced.
  See [Click analytics & privacy](./analytics).
- **Route order does not matter.** An unknown slug calls `next()` by default,
  so you can mount the redirect router before or after your own routes.
  See [Mounting & route order](./mounting).
- **No anonymous creation.** Creating links is admin-only. There is no public
  shortener endpoint.

## Non-goals (0.x)

Password-protected links, cloaking, A/B splits, device or geo targeting,
signed webhooks (use the [hooks](./hooks)), multiple domains per instance,
bulk CSV import, a built-in screenshotter or GeoIP database.
