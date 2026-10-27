# Mounting & route order

shorty gives you three Express routers. Where they go is your call.

| Router | Audience | Mount |
|---|---|---|
| `shorty.redirect` | public | a path (`/go`), the root (`/`), or a vhost |
| `shorty.routes` | admin | behind your guard, e.g. `/admin/links/api` |
| `shorty.ui()` | admin | behind the same guard, e.g. `/admin/links` |

`publicBaseUrl` must match wherever `redirect` ends up, as the browser sees it.
`ui({ mountPath, apiBase })` must match where `ui()` and `routes` are mounted.

## Nested

```js
app.use('/go', shorty.redirect);
// publicBaseUrl: 'https://acme.com/go'
```

## At the root

```js
app.use('/', shorty.redirect);
// publicBaseUrl: 'https://acme.com'
```

At the root, `/spring` is a link and `/about` is your page. An unknown slug
calls `next()` (the default `onMiss: 'next'`), so your own routes still answer
whichever order you register them in. Paths that cannot be slugs (they contain
a dot, are empty, too long or reserved) never touch the database, so
`/assets/app.js` and `/favicon.ico` cost nothing.

Paths that *are* valid slugs, such as `/api/users`, do get one lookup and a
miss row. If a root-mounted host wants none, reserve them:

```js
createShorty({ slug: { reserved: [/^api(\/|$)/, 'login', 'logout'] } });
```

Reserved entries **extend** the built-in list (anything starting with `_`);
they never replace it. A reserved slug cannot be created, and a request for it
falls through.

## On its own host

```js
import vhost from 'vhost';
app.use(vhost('go.acme.com', shorty.redirect));
// publicBaseUrl: 'https://go.acme.com'
```

## Misses and expiry

| Situation | Default | Options |
|---|---|---|
| Unknown slug | `next()` | `redirect.onMiss`: `'next'`, `'notFound'` (404), or a URL (302) |
| Expired link | 410 + minimal HTML | `redirect.onExpired`: `'page'`, `'notFound'`, or a URL; a link's own `expiredUrl` wins |
| Database down | `next(err)` | your error handler answers |

## Body parser and guard

`routes` needs `express.json()` upstream. The redirect router needs nothing,
and sets no cookies.
