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

const port = await freePort();
const server = spawn('node', ['examples/express/server.js'], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const stop = () => { if (!server.killed) server.kill('SIGTERM'); };
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(130); });

let code = 1;
try {
  const base = `http://127.0.0.1:${port}/admin/links/`;
  await waitFor(base, 120_000);
  code = run('npx', ['playwright', 'test', ...process.argv.slice(2)], {
    env: { ...process.env, E2E_BASE_URL: base },
  }).status ?? 1;
} finally {
  stop();
}
process.exit(code);
