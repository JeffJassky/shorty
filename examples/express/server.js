/**
 * Runnable example — in-memory Mongo, a fake auth middleware, every shorty mount.
 *
 *   npm run build && node examples/express/server.js
 *
 * Admin UI:   http://127.0.0.1:3000/admin/links        (?as=staff to sign in as staff)
 * Short links: http://127.0.0.1:3000/go/<slug>
 *
 * Slug rename mode (used by the e2e suite): SHORTY_RENAME=alias|untilClicked|always|never
 * (default alias).
 *
 * Try remounting `redirect` at '/' — it falls through to the host's own routes
 * for anything that isn't a known slug, whatever order they're registered in.
 */
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
// The BUILT artifact, not `src/` — this runs under plain node and exercises
// what a host actually installs. Run `npm run build` first.
import { createShorty } from '../../dist/index.js';

const mongod = await MongoMemoryServer.create();
await mongoose.connect(mongod.getUri(), { dbName: 'shorty-example' });

const port = Number(process.env.PORT) || 3000;

const PEOPLE = {
  visitor: null,
  staff: { id: 'staff-1', name: 'Staff Person', isAdmin: true },
};

const shorty = createShorty({
  connection: mongoose,
  publicBaseUrl: `http://127.0.0.1:${port}/go`,
  pepper: 'example-pepper-change-me',
  slug: { rename: process.env.SHORTY_RENAME || 'alias' },
  onClick: ({ link, click }) => console.log(`click ${link.slug}${click.bot ? ' (bot)' : ''}`),
  logger: console,
});
await shorty.ready();

const app = express();

// The host mounts the body parser, not the package — traps #5.
app.use(express.json());

// Fake auth. The identity sticks in a cookie so the SPA's fetches keep it.
app.use((req, res, next) => {
  const who = req.query.as;
  if (who && who in PEOPLE) res.cookie('as', who);
  const key = who && who in PEOPLE ? who : (req.headers.cookie?.match(/as=(\w+)/)?.[1] ?? 'staff');
  req.person = PEOPLE[key] ?? null;
  next();
});

/**
 * THE GUARD THE PACKAGE CANNOT WRITE. Shorty never decides who may manage
 * links — this middleware is the whole boundary. Copy it, and copy
 * examples/admin-guard.test.js with it.
 */
const requireStaff = (req, res, next) => (
  req.person?.isAdmin ? next() : res.status(403).json({ error: 'forbidden' })
);

app.use('/admin/links/api', requireStaff, shorty.routes);
app.use('/admin/links', requireStaff, shorty.ui({ mountPath: '/admin/links', apiBase: '/admin/links/api' }));
app.use('/go', shorty.redirect);

app.get('/', (_req, res) => res.redirect('/admin/links'));

// Honor PORT. On macOS a process bound to IPv6 `*:3000` does NOT stop node
// binding IPv4 — this would "listen" and every request would go elsewhere.
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`shorty example → http://127.0.0.1:${port}/admin/links`);
  console.log(`                 http://127.0.0.1:${port}/go/<slug>`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is taken. Try: PORT=3100 node examples/express/server.js`);
    process.exit(1);
  }
  throw err;
});
