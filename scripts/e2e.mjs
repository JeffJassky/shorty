#!/usr/bin/env node
/**
 * `npm run test:e2e` — build, start the example host on a free port, run
 * Playwright against it, then stop the host.
 *
 * The example (examples/express/server.js) reads PORT and uses an in-memory
 * MongoDB, so every run starts from an empty database.
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'inherit', ...opts });

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`example server did not come up at ${url}`);
}

if (!process.env.E2E_SKIP_BUILD && run('npm', ['run', 'build']).status !== 0) process.exit(1);

/** One example host per slug-rename mode; each is its own in-memory database. */
const MODES = { E2E_BASE_URL: 'alias', E2E_BASE_URL_UNTIL_CLICKED: 'untilClicked', E2E_BASE_URL_ALWAYS: 'always', E2E_BASE_URL_NEVER: 'never' };
const servers = [];
const stop = () => { for (const s of servers) if (!s.killed) s.kill('SIGTERM'); };
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(130); });

const env = { ...process.env };
let code = 1;
try {
  const waits = [];
  for (const [name, mode] of Object.entries(MODES)) {
    const port = await freePort();
    servers.push(spawn('node', ['examples/express/server.js'], {
      env: { ...process.env, PORT: String(port), SHORTY_RENAME: mode },
      stdio: ['ignore', 'ignore', 'inherit'],
    }));
    env[name] = `http://127.0.0.1:${port}/admin/links/`;
    waits.push(waitFor(env[name], 120_000));
  }
  await Promise.all(waits);
  code = run('npx', ['playwright', 'test', ...process.argv.slice(2)], { env }).status ?? 1;
} finally {
  stop();
}
process.exit(code);
