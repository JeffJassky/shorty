# Client

```ts
import { createShortyClient } from '@jeffjassky/shorty/client';

const client = createShortyClient({ baseUrl: '/admin/links/api' });
const { items } = await client.links({ sort: 'clicks', limit: 20 });
```

A typed `fetch` client for [`shorty.routes`](./http). The admin UI is built on
it, and you can use it from your own front end or from a script.

## Options

| Option | Default | Notes |
|---|---|---|
| `baseUrl` | `'/api/shorty'` | Where `routes` is mounted. |
| `request` | built-in `fetch` | `(method, url, body?) => Promise<any>`. Swap in axios or a test double. |
| `onUnauthenticated` | none | Called on 401 and 403, since both strand an already-rendered page. |

The default transport throws an `ApiError` (`status`, `payload`) on a non-2xx.
`payload` is `{ error: code, ... }` from the server.

## Methods

| Method | Route |
|---|---|
| `links(query?)` | `GET /links` |
| `createLink(input)` | `POST /links` |
| `link(id)` | `GET /links/:id` |
| `updateLink(id, patch)` | `PATCH /links/:id` |
| `archiveLink(id)` / `unarchiveLink(id)` | `POST /links/:id/(un)archive` |
| `deleteLink(id)` | `DELETE /links/:id` |
| `history(id)` | `GET /links/:id/history` |
| `stats({ linkId?, from, to, interval?, top? })` | `GET /links/:id/stats` or `GET /stats` |
| `paramValues()` | `GET /params` |
| `tags()` | `GET /tags` |
| `checkSlug(slug, { linkId? })` | `GET /slugs/check` |
| `generateSlug()` | `GET /slugs/generate` |
| `inspect(url)` | `POST /inspect` |
| `call(method, url, body?)` | the raw transport |

Return types use `Json<T>`: the server's types with `Date` as ISO `string`.
