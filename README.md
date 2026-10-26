# shorty

> `/scaffold` renames this file to `README.md`. The template's own README —
> the one explaining tokens and settled divergences — stays behind in foundry.

Self-hosted short links for Express + MongoDB: UTM builder, click analytics, React admin UI

npm renders this file, and it goes stale faster than anything else in the repo.
`standards/done.md` gates on it reflecting the final API.

```bash
npm install @jeffjassky/shorty
```

## Quick start

```js
import express from 'express';
import mongoose from 'mongoose';
import { createShorty } from '@jeffjassky/shorty';

await mongoose.connect(process.env.MONGO_URL);

const pkg = createShorty({
  connection: mongoose,
  resolveUser: (req) => req.user && {
    id: req.user._id,
    email: req.user.email,
    displayName: req.user.name,
    isAdmin: req.user.role === 'admin',
  },
});

await pkg.model.createIndexes();

const app = express();
app.use(express.json());          // yours, not ours

app.use('/api/shorty', requireAuth, pkg.routes);
app.use('/shorty',    requireAuth, pkg.ui({ mountPath: '/shorty' }));

app.use('/api/shorty/admin', requireAuth, requireAdmin, pkg.adminRoutes);
app.use('/admin/shorty',    requireAuth, requireAdmin,
        pkg.adminUi({ mountPath: '/admin/shorty' }));
```

Full docs: **https://jeffjassky.github.io/shorty/**

## The one thing to get right

`isAdmin` from your adapter **gates nothing**. shorty cannot know what admin
means in your app, so it refuses nobody — your middleware is the entire
boundary around `adminRoutes` and `adminUi()`.

Copy `examples/admin-guard.test.js` into your suite. It has to live in your
repo, because it is the only thing that catches a refactor dropping the guard.

## Requirements

Node 20+, Express 4.18+/5, Mongoose 7/8/9. Both are peer dependencies — all
three Mongoose majors run the full suite in CI.

## Development

```bash
npm install
npm run check-tracked   # run this FIRST — a global gitignore can eat source files
npm run typecheck
npm run build           # server, then the UI bundle into dist/ui
npm test                # after build: the UI tests assert against the bundle
node examples/express/server.js   # imports dist/, so build first
```

## License

MIT © Jeff Jassky
