# Quickstart

## Install

```bash
npm install @jeffjassky/shorty
```

Peers: `express` 4.18+ or 5, `mongoose` 7, 8 or 9. MongoDB 5.2+. See
[Requirements](./requirements).

## Create and mount

```js
import express from 'express';
import mongoose from 'mongoose';
import { createShorty } from '@jeffjassky/shorty';

await mongoose.connect(process.env.MONGO_URL);

const shorty = createShorty({
  connection: mongoose,
  publicBaseUrl: 'https://acme.com/go',        // where `redirect` is reachable
  pepper: process.env.SHORTY_PEPPER,           // enables click recording
});
await shorty.ready();                          // indexes, TTLs, case-mode re-key

const app = express();
app.use(express.json());                       // yours, not ours

app.use('/go', shorty.redirect);                                     // public
app.use('/admin/links/api', requireAdmin, shorty.routes);            // JSON API
app.use('/admin/links', requireAdmin, shorty.ui({
  mountPath: '/admin/links',
  apiBase: '/admin/links/api',
}));
```

Four things to get right:

1. **`publicBaseUrl` is the URL a browser uses**, including any path prefix.
   It is never inferred from a request.
2. **`await shorty.ready()` once at boot.** It creates every collection and
   builds indexes. Skipping it leaves you with slow or missing indexes.
3. **`express.json()` is yours.** `routes` does not install a body parser. A
   missing body is a 400, not a crash.
4. **`requireAdmin` is yours.** `routes` and `ui()` trust whoever reaches
   them. Test the guard (see [Admin UI](./ui)).

The three routers can be mounted in any order; see
[Mounting & route order](./mounting).

## Create a link

From the UI at `/admin/links`, or in code:

```js
const link = await shorty.createLink({
  url: 'https://acme.com/sale?utm_source=instagram&utm_medium=social',
  slug: 'spring',
});
link.shortUrl;   // https://acme.com/go/spring
```

## Without clicks

Leave `pepper` unset (and `SHORTY_PEPPER` empty) and click recording is off
with one logged warning. Redirects still work. Set `clicks: false` to turn it
off explicitly.
