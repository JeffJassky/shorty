# shorty

Self-hosted short links for Express + MongoDB: a UTM builder, click analytics
and a React admin UI, embedded in your own app. No third-party service, no
Redis, no worker.

- Redirect router you can mount at a path, at `/`, or on its own host, in any route order
- Structured destinations (base URL, UTM fields, parameters, hash) with suggestions and near-duplicate lint
- Safe editing: destination revisions, and slug renames that keep old links working
- Click analytics with no stored IPs, a daily-rotating visitor hash, and bots counted separately
- Prebuilt admin UI (list, form with live previews, link detail, analytics); SSRF-hardened link inspection

```bash
npm install @jeffjassky/shorty
```

```js
import express from 'express';
import mongoose from 'mongoose';
import { createShorty } from '@jeffjassky/shorty';

await mongoose.connect(process.env.MONGO_URL);

const shorty = createShorty({
  connection: mongoose,
  publicBaseUrl: 'https://acme.com/go',
  pepper: process.env.SHORTY_PEPPER,   // enables click recording
});
await shorty.ready();

const app = express();
app.use(express.json());
app.use('/go', shorty.redirect);                                   // public
app.use('/admin/links/api', requireAdmin, shorty.routes);          // your guard
app.use('/admin/links', requireAdmin, shorty.ui({ mountPath: '/admin/links', apiBase: '/admin/links/api' }));
```

`requireAdmin` is yours: shorty trusts whoever reaches `routes` and `ui()`.

**Documentation: https://jeffjassky.github.io/shorty/**

## Requirements

Node 20+, MongoDB 5.2+, mongoose 7, 8 or 9, Express 4.18+ or 5 (mongoose and
Express are peer dependencies; CI runs the suite on all three mongoose majors).

## Development

```bash
npm install
npm run check-tracked && npm run typecheck && npm run build && npm test
npm run test:e2e          # Playwright against examples/express/server.js
npm run docs:dev
```

## License

MIT © Jeff Jassky
