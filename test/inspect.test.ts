import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { ShortyError } from '../src/shared/errors.js';
import type { InspectConfig, InspectResult, InspectWarningCode, ScreenshotAdapter } from '../types/index.js';
import { allowLoopback, harness, page, redirectTo, startSite, startDb, stopDb } from './helpers.js';
import type { Site, SiteHandler } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * `shorty.inspect(url)` — OG preview + destination health (§7.6, research.md
 * §1 and §7). Every fetch goes to a throwaway local site; tests that need the
 * site reachable opt in with `isAllowedAddress: allowLoopback`. The SSRF tests
 * use the DEFAULT address policy and assert the site saw ZERO requests —
 * "blocked" means never connected, not "connected and discarded".
 */

const sites: Site[] = [];
async function site(routes: Record<string, SiteHandler>): Promise<Site> {
  const s = await startSite(routes);
  sites.push(s);
  return s;
}

async function inspector(inspect: InspectConfig = {}, extra: { screenshot?: ScreenshotAdapter } = {}) {
  const h = await harness({ config: { inspect, ...extra } });
  return h.shorty;
}

/** Loopback allowed — the normal way an OG test reaches its local site. */
const local = (more: InspectConfig = {}) => inspector({ isAllowedAddress: allowLoopback, ...more });

const codes = (r: InspectResult): InspectWarningCode[] => r.warnings.map((w) => w.code);

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t0 };
}

beforeAll(startDb);
afterAll(stopDb);
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
});

describe('inspect — OG extraction', () => {
  it('prefers og:title over twitter:title over <title>', async () => {
    const s = await site({
      '/all': page('<title>Doc</title><meta name="twitter:title" content="Tw"><meta property="og:title" content="Og">'),
      '/tw': page('<title>Doc</title><meta name="twitter:title" content="Tw">'),
      '/doc': page('<title>Doc</title>'),
    });
    const shorty = await local();
    expect((await shorty.inspect(`${s.origin}/all`)).og.title).toBe('Og');
    expect((await shorty.inspect(`${s.origin}/tw`)).og.title).toBe('Tw');
    expect((await shorty.inspect(`${s.origin}/doc`)).og.title).toBe('Doc');
  });

  it('does not invent a title from the body when the head has none', async () => {
    // OgData is what was SCRAPED; a "Visit host/path" presentation fallback is the UI's job.
    const s = await site({ '/none': page('', '<h1>Body heading</h1>') });
    const r = await (await local()).inspect(`${s.origin}/none`);
    expect(r.og.title).toBeUndefined();
  });

  it('prefers meta description over og:description over twitter:description', async () => {
    const s = await site({
      '/all': page('<meta name="twitter:description" content="Tw"><meta property="og:description" content="Og"><meta name="description" content="Meta">'),
      '/og': page('<meta name="twitter:description" content="Tw"><meta property="og:description" content="Og">'),
      '/tw': page('<meta name="twitter:description" content="Tw">'),
    });
    const shorty = await local();
    expect((await shorty.inspect(`${s.origin}/all`)).og.description).toBe('Meta');
    expect((await shorty.inspect(`${s.origin}/og`)).og.description).toBe('Og');
    expect((await shorty.inspect(`${s.origin}/tw`)).og.description).toBe('Tw');
  });

  it('prefers og:image over twitter:image over image_src over the icon', async () => {
    const s = await site({
      '/all': page(`<link rel="icon" href="/icon.png"><link rel="image_src" href="/src.png">
        <meta name="twitter:image" content="/tw.png"><meta property="og:image" content="/og.png">`),
      '/tw': page('<link rel="icon" href="/icon.png"><link rel="image_src" href="/src.png"><meta name="twitter:image" content="/tw.png">'),
      '/src': page('<link rel="icon" href="/icon.png"><link rel="image_src" href="/src.png">'),
      '/icon': page('<link rel="icon" href="/icon.png">'),
    });
    const shorty = await local();
    expect((await shorty.inspect(`${s.origin}/all`)).og.image).toBe(`${s.origin}/og.png`);
    expect((await shorty.inspect(`${s.origin}/tw`)).og.image).toBe(`${s.origin}/tw.png`);
    expect((await shorty.inspect(`${s.origin}/src`)).og.image).toBe(`${s.origin}/src.png`);
    expect((await shorty.inspect(`${s.origin}/icon`)).og.image).toBe(`${s.origin}/icon.png`);
  });

  it('resolves a relative og:image against the FINAL url, not the one asked for', async () => {
    const s = await site({
      '/start': redirectTo('/deep/dir/page'),
      '/deep/dir/page': page('<meta property="og:image" content="img/card.png">'),
    });
    const r = await (await local()).inspect(`${s.origin}/start`);
    expect(r.og.image).toBe(`${s.origin}/deep/dir/img/card.png`);
  });

  it('reads the favicon from <link rel="icon"> (and "shortcut icon"), absolute', async () => {
    const s = await site({
      '/icon': page('<link rel="icon" href="/static/fav.png">'),
      '/shortcut': page('<link rel="shortcut icon" href="sc.ico">'),
    });
    const shorty = await local();
    expect((await shorty.inspect(`${s.origin}/icon`)).og.favicon).toBe(`${s.origin}/static/fav.png`);
    expect((await shorty.inspect(`${s.origin}/shortcut`)).og.favicon).toBe(`${s.origin}/sc.ico`);
  });

  it('never guesses /favicon.ico when the page declares no icon', async () => {
    const s = await site({ '/plain': page('<title>Plain</title>') });
    const r = await (await local()).inspect(`${s.origin}/plain`);
    expect(r.og.favicon).toBeUndefined();
    expect(r.og.image).toBeUndefined();
    // And it did not go probing for one either.
    expect(s.hits.some((h) => h.startsWith('/favicon'))).toBe(false);
  });

  it('reads og:site_name and decodes HTML entities in every field', async () => {
    const s = await site({
      '/e': page(`<title>Ignored</title><meta property="og:title" content="Tom &amp; Jerry &quot;Live&quot;">
        <meta property="og:site_name" content="Acme &amp; Co">
        <meta name="description" content="Fish &lt;3 chips &#39;n&#x27; peas">`),
      '/t': page('<title>A &amp; B</title>'),
    });
    const shorty = await local();
    const r = await shorty.inspect(`${s.origin}/e`);
    expect(r.og.title).toBe('Tom & Jerry "Live"');
    expect(r.og.siteName).toBe('Acme & Co');
    expect(r.og.description).toBe("Fish <3 chips 'n' peas");
    expect((await shorty.inspect(`${s.origin}/t`)).og.title).toBe('A & B');
  });

  it('echoes the url asked for and reports the final status', async () => {
    const s = await site({ '/ok': page('<title>Ok</title>') });
    const url = `${s.origin}/ok`;
    const r = await (await local()).inspect(url);
    expect(r.url).toBe(url);
    expect(r.final).toMatchObject({ url, status: 200 });
    expect(r.chain).toEqual([{ url, status: 200 }]);
    expect(r.warnings).toEqual([]);
  });
});

describe('inspect — bounded reading', () => {
  it('stops at </head> instead of waiting for a body that never ends', async () => {
    const s = await site({
      '/stream': (_req, res) => {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.write('<!doctype html><html><head><meta property="og:title" content="Streamed"></head><body>');
        const t = setInterval(() => res.write('x'.repeat(1024)), 5);
        res.on('close', () => clearInterval(t));
      },
    });
    const shorty = await local({ timeoutMs: 5000 });
    const { value: r, ms } = await timed(() => shorty.inspect(`${s.origin}/stream`));
    expect(r.og.title).toBe('Streamed');
    expect(r.final?.status).toBe(200);
    expect(codes(r)).not.toContain('unreachable');
    expect(ms).toBeLessThan(2000);
  });

  it('returns what it read when the head is larger than maxBytes — partial, no crash', async () => {
    const padding = `<meta name="pad" content="${'p'.repeat(5000)}">`;
    const s = await site({
      '/big': page(`<meta property="og:title" content="Early">${padding}<meta property="og:description" content="Late">`),
    });
    const r = await (await local({ maxBytes: 300 })).inspect(`${s.origin}/big`);
    expect(r.og.title).toBe('Early');
    expect(r.og.description).toBeUndefined();
    expect(r.final?.status).toBe(200);
  });
});

describe('inspect — redirects', () => {
  it('lists every hop with its status, resolving relative Location headers', async () => {
    const s = await site({
      '/a': redirectTo('/b', 301),
      '/b': redirectTo(`/c`, 302),
      '/c': page('<title>C</title>'),
    });
    const r = await (await local()).inspect(`${s.origin}/a`);
    expect(r.chain).toEqual([
      { url: `${s.origin}/a`, status: 301 },
      { url: `${s.origin}/b`, status: 302 },
      { url: `${s.origin}/c`, status: 200 },
    ]);
    expect(r.final).toMatchObject({ url: `${s.origin}/c`, status: 200 });
    expect(typeof r.final?.ms).toBe('number');
    expect(r.final!.ms).toBeGreaterThanOrEqual(0);
    expect(r.og.title).toBe('C');
  });

  it('offers the final url as a fix when the destination redirects', async () => {
    const s = await site({ '/old': redirectTo('/new', 301), '/new': page('<title>New</title>') });
    const r = await (await local()).inspect(`${s.origin}/old`);
    const w = r.warnings.find((x) => x.code === 'redirects');
    expect(w).toBeDefined();
    expect(w!.fix).toEqual({ kind: 'use_final_url', url: `${s.origin}/new` });
    expect(typeof w!.message).toBe('string');
  });

  it('does not warn about redirects for a single-hop destination', async () => {
    const s = await site({ '/ok': page('<title>Ok</title>') });
    const r = await (await local()).inspect(`${s.origin}/ok`);
    expect(codes(r)).not.toContain('redirects');
  });

  it('gives up as unreachable after maxRedirects, but follows exactly maxRedirects', async () => {
    const s = await site({
      '/r1': redirectTo('/r2'),
      '/r2': redirectTo('/r3'),
      '/r3': redirectTo('/end'),
      '/end': page('<title>End</title>'),
    });
    const shorty = await local({ maxRedirects: 2 });
    const tooMany = await shorty.inspect(`${s.origin}/r1`); // 3 redirects
    expect(codes(tooMany)).toContain('unreachable');
    const justEnough = await shorty.inspect(`${s.origin}/r2`); // 2 redirects
    expect(codes(justEnough)).not.toContain('unreachable');
    expect(justEnough.og.title).toBe('End');
  });

  it('warns query_dropped when a hop redirects to a url without the original UTMs', async () => {
    const s = await site({
      '/sale': redirectTo('/landing', 301),
      '/landing': page('<title>Landing</title>'),
    });
    const r = await (await local()).inspect(`${s.origin}/sale?utm_source=ig&utm_medium=social&utm_campaign=spring`);
    expect(codes(r)).toContain('query_dropped');
  });

  it('does not warn query_dropped when the redirect preserves the query', async () => {
    const s = await site({
      '/keep': (req, res) => {
        const q = (req.url ?? '').split('?')[1] ?? '';
        res.statusCode = 301;
        res.setHeader('location', `/kept?${q}`);
        res.end();
      },
      '/kept': page('<title>Kept</title>'),
    });
    const r = await (await local()).inspect(`${s.origin}/keep?utm_source=ig&utm_medium=social&utm_campaign=spring`);
    expect(codes(r)).toContain('redirects');
    expect(codes(r)).not.toContain('query_dropped');
  });
});

describe('inspect — destination health warnings', () => {
  it('warns not_ok when the final status is 404 or 500', async () => {
    const s = await site({
      '/boom': (_req, res) => { res.statusCode = 500; res.end('err'); },
    });
    const shorty = await local();
    const missing = await shorty.inspect(`${s.origin}/missing`);
    expect(missing.final?.status).toBe(404);
    expect(codes(missing)).toContain('not_ok');
    const boom = await shorty.inspect(`${s.origin}/boom`);
    expect(boom.final?.status).toBe(500);
    expect(codes(boom)).toContain('not_ok');
  });

  it('warns noindex_destination from an X-Robots-Tag header', async () => {
    const s = await site({
      '/h': (_req, res) => {
        res.setHeader('x-robots-tag', 'noindex, nofollow');
        page('<title>H</title>')(_req, res);
      },
    });
    const r = await (await local()).inspect(`${s.origin}/h`);
    expect(codes(r)).toContain('noindex_destination');
  });

  it('warns noindex_destination from <meta name="robots" content="noindex">', async () => {
    const s = await site({
      '/m': page('<meta name="robots" content="noindex"><title>M</title>'),
      '/fine': page('<meta name="robots" content="index, follow"><title>F</title>'),
    });
    const shorty = await local();
    expect(codes(await shorty.inspect(`${s.origin}/m`))).toContain('noindex_destination');
    expect(codes(await shorty.inspect(`${s.origin}/fine`))).not.toContain('noindex_destination');
  });

  it('flags a Cloudflare challenge instead of scraping "Just a moment..." as the title', async () => {
    const s = await site({
      '/cf': (_req, res) => {
        res.statusCode = 403;
        res.setHeader('cf-mitigated', 'challenge');
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end('<!doctype html><html><head><title>Just a moment...</title></head><body></body></html>');
      },
    });
    const r = await (await local()).inspect(`${s.origin}/cf`);
    expect(codes(r)).toContain('cloudflare_challenge');
    expect(r.og.title).not.toBe('Just a moment...');
  });

  it('warns utm_incomplete when only some of source/medium/campaign are set', async () => {
    const s = await site({ '/': page('<title>Home</title>') });
    const shorty = await local();
    expect(codes(await shorty.inspect(`${s.origin}/?utm_source=ig`))).toContain('utm_incomplete');
    expect(codes(await shorty.inspect(`${s.origin}/?utm_source=ig&utm_medium=social`))).toContain('utm_incomplete');
  });

  it('does not warn utm_incomplete with source+medium+campaign, or with no UTMs at all', async () => {
    const s = await site({ '/': page('<title>Home</title>') });
    const shorty = await local();
    expect(codes(await shorty.inspect(`${s.origin}/?utm_source=ig&utm_medium=social&utm_campaign=spring`)))
      .not.toContain('utm_incomplete');
    expect(codes(await shorty.inspect(`${s.origin}/`))).not.toContain('utm_incomplete');
  });

  it('returns unreachable within the budget when the server never answers', async () => {
    const s = await site({ '/hang': () => { /* never responds */ } });
    const shorty = await local({ timeoutMs: 300 });
    const { value: r, ms } = await timed(() => shorty.inspect(`${s.origin}/hang`));
    expect(codes(r)).toContain('unreachable');
    expect(ms).toBeLessThan(2000);
  });

  it('returns within the budget when headers arrive but </head> never does', async () => {
    const s = await site({
      '/slow': (_req, res) => {
        res.setHeader('content-type', 'text/html');
        res.write('<!doctype html><html><head><title>Slow');
      },
    });
    const shorty = await local({ timeoutMs: 300 });
    const { ms } = await timed(() => shorty.inspect(`${s.origin}/slow`));
    expect(ms).toBeLessThan(2000);
  });

  it('returns unreachable (never throws) when the connection is refused', async () => {
    const s = await startSite({});
    const origin = s.origin;
    await s.close();
    const r = await (await local()).inspect(`${origin}/`);
    expect(codes(r)).toContain('unreachable');
    expect(r.final).toBeUndefined();
  });

  it('sends the configured User-Agent', async () => {
    let ua: string | undefined;
    const s = await site({
      '/ua': (req: http.IncomingMessage, res) => { ua = req.headers['user-agent']; page('<title>U</title>')(req, res); },
    });
    await (await local({ userAgent: 'acme-preview/9' })).inspect(`${s.origin}/ua`);
    expect(ua).toBe('acme-preview/9');
  });
});

describe('inspect — SSRF, default address policy', () => {
  // A site on 127.0.0.1 that the DEFAULT policy must never reach. Every test
  // asserts zero hits: blocked means "never connected".
  async function guarded() {
    return site({ '/': page('<title>SECRET</title>') });
  }

  async function expectBlocked(s: Site, r: InspectResult) {
    expect(codes(r)).toContain('private_address');
    expect(s.hits).toEqual([]);
    expect(r.final).toBeUndefined();
    expect(r.chain).toEqual([]);
    expect(r.og.title).toBeUndefined();
  }

  it('refuses a 127.0.0.1 literal', async () => {
    const s = await guarded();
    const r = await (await inspector()).inspect(`http://127.0.0.1:${s.port}/`);
    await expectBlocked(s, r);
  });

  it('refuses localhost (resolves to loopback)', async () => {
    const s = await guarded();
    const r = await (await inspector()).inspect(`http://localhost:${s.port}/`);
    await expectBlocked(s, r);
  });

  const privateAddresses = [
    '127.0.0.1', // loopback
    '10.0.0.5', // RFC 1918
    '192.168.1.1', // RFC 1918
    '172.16.0.1', // RFC 1918
    '169.254.169.254', // link-local / cloud metadata
    '100.64.0.1', // CGNAT
    '0.0.0.0', // unspecified
    '::1', // v6 loopback
    'fe80::1', // v6 link-local
    'fc00::1', // v6 unique-local
    '::ffff:127.0.0.1', // v4-mapped loopback
  ];

  it.each(privateAddresses)('refuses a hostname that resolves to %s', async (addr) => {
    const s = await guarded();
    const asked: string[] = [];
    const shorty = await inspector({
      lookup: async (host) => { asked.push(host); return [addr]; },
    });
    const r = await shorty.inspect(`http://sneaky.test:${s.port}/`);
    await expectBlocked(s, r);
    expect(asked).toContain('sneaky.test');
  });

  it('refuses a hostname resolving to [public, private] — every address is checked', async () => {
    const s = await guarded();
    const shorty = await inspector({ lookup: async () => ['93.184.216.34', '10.0.0.5'] });
    await expectBlocked(s, await shorty.inspect(`http://mixed.test:${s.port}/`));
  });

  it('refuses [allowed, disallowed] even when the allowed one would have worked', async () => {
    // Same rule with an observable site: 127.0.0.1 passes the policy, 10.0.0.5
    // does not, so the whole host is refused and the site sees nothing.
    const s = await guarded();
    const shorty = await inspector({ isAllowedAddress: allowLoopback, lookup: async () => ['127.0.0.1', '10.0.0.5'] });
    await expectBlocked(s, await shorty.inspect(`http://mixed.test:${s.port}/`));
  });

  it('fails closed as unreachable when DNS lookup throws', async () => {
    const s = await guarded();
    const shorty = await inspector({
      isAllowedAddress: () => true,
      lookup: async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); },
    });
    const r = await shorty.inspect(`http://nxdomain.test:${s.port}/`);
    expect(codes(r)).toContain('unreachable');
    expect(s.hits).toEqual([]);
    expect(r.final).toBeUndefined();
  });

  it('fails closed when DNS returns no addresses', async () => {
    const s = await guarded();
    const shorty = await inspector({ isAllowedAddress: () => true, lookup: async () => [] });
    const r = await shorty.inspect(`http://empty.test:${s.port}/`);
    expect(codes(r)).toContain('unreachable');
    expect(s.hits).toEqual([]);
  });
});

describe('inspect — SSRF across redirects and rebinding', () => {
  it('stops the chain when a hop redirects to a private IP literal', async () => {
    const s = await site({ '/start': redirectTo('http://10.0.0.5/admin') });
    const shorty = await inspector({
      isAllowedAddress: allowLoopback,
      lookup: async (host) => (host === 'public.test' ? ['127.0.0.1'] : ['10.0.0.5']),
    });
    const url = `http://public.test:${s.port}/start`;
    const r = await shorty.inspect(url);
    expect(codes(r)).toContain('private_address');
    expect(r.chain).toEqual([{ url, status: 302 }]);
    expect(s.hits).toEqual(['/start']);
  });

  it('stops the chain when a hop redirects to a hostname that resolves private', async () => {
    const s = await site({
      '/start': (_req, res) => {
        res.statusCode = 301;
        res.setHeader('location', `http://internal.test:${s.port}/secret`);
        res.end();
      },
      '/secret': page('<title>SECRET</title>'),
    });
    const shorty = await inspector({
      isAllowedAddress: allowLoopback,
      lookup: async (host) => (host === 'public.test' ? ['127.0.0.1'] : ['10.0.0.5']),
    });
    const url = `http://public.test:${s.port}/start`;
    const r = await shorty.inspect(url);
    expect(codes(r)).toContain('private_address');
    expect(r.chain).toEqual([{ url, status: 301 }]);
    expect(s.hits).toEqual(['/start']);
    expect(r.og.title).not.toBe('SECRET');
  });

  it('connects to the address it checked — DNS rebinding cannot swap it at connect time', async () => {
    // The lookup answers 127.0.0.1 (allowed) the first time and 10.0.0.5
    // (disallowed) on every later call. The requirement, made observable:
    //  - `lookup` is called exactly once for the single hop, i.e. the connect
    //    reuses the checked answer instead of resolving again (or handing the
    //    hostname to the OS resolver, which cannot resolve `.test` at all);
    //  - the request reaches the 127.0.0.1 site, proving the socket went to
    //    the address that passed `isAllowedAddress`.
    const s = await site({ '/': page('<title>Checked</title>') });
    let calls = 0;
    const checked: string[] = [];
    const shorty = await inspector({
      isAllowedAddress: (ip) => { checked.push(ip); return ip === '127.0.0.1'; },
      lookup: async () => { calls += 1; return calls === 1 ? ['127.0.0.1'] : ['10.0.0.5']; },
    });
    const r = await shorty.inspect(`http://rebind.test:${s.port}/`);
    expect(calls).toBe(1);
    expect(checked).toContain('127.0.0.1');
    expect(checked).not.toContain('10.0.0.5');
    expect(s.hits).toEqual(['/']);
    expect(r.final?.status).toBe(200);
    expect(r.og.title).toBe('Checked');
    expect(codes(r)).not.toContain('private_address');
  });
});

describe('inspect — input validation', () => {
  it('throws unsupported_scheme for non-http(s) urls', async () => {
    const shorty = await inspector();
    for (const url of ['ftp://example.com/file', 'file:///etc/passwd', 'javascript:alert(1)', 'gopher://x.test/']) {
      const err = await shorty.inspect(url).catch((e: unknown) => e);
      expect(err, url).toBeInstanceOf(ShortyError);
      expect((err as ShortyError).code, url).toBe('unsupported_scheme');
    }
  });

  it('throws invalid_url for garbage', async () => {
    const shorty = await inspector();
    for (const url of ['not a url', '', '/relative/path', 'http://']) {
      const err = await shorty.inspect(url).catch((e: unknown) => e);
      expect(err, url).toBeInstanceOf(ShortyError);
      expect((err as ShortyError).code, url).toBe('invalid_url');
    }
  });
});

describe('inspect — screenshot adapter', () => {
  it('leaves screenshot undefined when no adapter is configured', async () => {
    const s = await site({ '/': page('<title>S</title>') });
    const r = await (await local()).inspect(`${s.origin}/`);
    expect(r.screenshot).toBeUndefined();
  });

  it('returns the adapter image as a base64 data URL', async () => {
    const s = await site({ '/': page('<title>S</title>') });
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const asked: string[] = [];
    const shorty = await inspector(
      { isAllowedAddress: allowLoopback },
      { screenshot: async (url) => { asked.push(url); return { contentType: 'image/png', body }; } },
    );
    const r = await shorty.inspect(`${s.origin}/`);
    expect(r.screenshot).toBe(`data:image/png;base64,${body.toString('base64')}`);
    expect(asked).toHaveLength(1);
  });

  it('leaves screenshot undefined when the adapter returns null', async () => {
    const s = await site({ '/': page('<title>S</title>') });
    const shorty = await inspector({ isAllowedAddress: allowLoopback }, { screenshot: async () => null });
    expect((await shorty.inspect(`${s.origin}/`)).screenshot).toBeUndefined();
  });

  it('does not hand a refused (private) url to the screenshot adapter — no SSRF side door', async () => {
    const asked: string[] = [];
    const shorty = await inspector({}, {
      screenshot: async (url) => { asked.push(url); return { contentType: 'image/png', body: Buffer.from('x') }; },
    });
    const r = await shorty.inspect('http://169.254.169.254/latest/meta-data/');
    expect(codes(r)).toContain('private_address');
    expect(asked).toEqual([]);
    expect(r.screenshot).toBeUndefined();
  });

  it('does not fail the inspect when the adapter throws', async () => {
    const s = await site({ '/': page('<title>Still here</title>') });
    const shorty = await inspector(
      { isAllowedAddress: allowLoopback },
      { screenshot: async () => { throw new Error('browser crashed'); } },
    );
    const r = await shorty.inspect(`${s.origin}/`);
    expect(r.screenshot).toBeUndefined();
    expect(r.og.title).toBe('Still here');
    expect(r.final?.status).toBe(200);
    expect(codes(r)).not.toContain('unreachable');
  });
});

describe('inspect — default address policy, edges (audit follow-up)', () => {
  // Public addresses below would make a real outbound attempt; a 300 ms budget
  // keeps it bounded. 'unreachable' is fine — only 'private_address' is wrong.
  it('does not mistake a public address for a private one', async () => {
    const shorty = await inspector({ timeoutMs: 300, lookup: async () => ['93.184.216.34'] });
    const r = await shorty.inspect('http://public.test:9/');
    expect(codes(r)).not.toContain('private_address');
  });

  it.each(['172.32.0.1', '100.128.0.1'])('does not block %s, just outside a private range', async (addr) => {
    const shorty = await inspector({ timeoutMs: 300, lookup: async () => [addr] });
    const r = await shorty.inspect('http://edge.test:9/');
    expect(codes(r)).not.toContain('private_address');
  });

  const moreBlocked = [
    '224.0.0.1', // multicast
    'ff02::1', // v6 multicast
    '240.0.0.1', // reserved (class E)
    '255.255.255.255', // broadcast
    '192.0.2.1', // TEST-NET-1 documentation
    '::', // v6 unspecified
    '::ffff:10.0.0.5', // v4-mapped private
    '172.31.255.255', // top of 172.16/12
    '100.127.255.255', // top of CGNAT 100.64/10
  ];

  it.each(moreBlocked)('refuses a hostname that resolves to %s', async (addr) => {
    const s = await site({ '/': page('<title>SECRET</title>') });
    const shorty = await inspector({ lookup: async () => [addr] });
    const r = await shorty.inspect(`http://sneaky.test:${s.port}/`);
    expect(codes(r)).toContain('private_address');
    expect(s.hits).toEqual([]);
    expect(r.final).toBeUndefined();
  });

  it.each([
    ['[::1]', 'v6 loopback literal'],
    ['2130706433', 'decimal-integer 127.0.0.1'],
    ['0x7f.1', 'hex short-form 127.0.0.1'],
    ['127.1', 'short-form 127.0.0.1'],
  ])('refuses %s (%s) without connecting', async (host) => {
    const s = await site({ '/': page('<title>SECRET</title>') });
    const r = await (await inspector()).inspect(`http://${host}:${s.port}/`);
    expect(codes(r)).toContain('private_address');
    expect(s.hits).toEqual([]);
  });

  it('throws invalid_url for a url carrying credentials', async () => {
    const err = await (await inspector()).inspect('http://user:pass@example.com/').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShortyError);
    expect((err as ShortyError).code).toBe('invalid_url');
  });
});

describe('inspect — redirect edges (audit follow-up)', () => {
  it('does not follow a redirect to file:///etc/passwd', async () => {
    const s = await site({ '/x': redirectTo('file:///etc/passwd') });
    const url = `${s.origin}/x`;
    const r = await (await local()).inspect(url);
    expect(r.chain).toEqual([{ url, status: 302 }]);
    expect(r.chain.some((hop) => hop.url.startsWith('file:'))).toBe(false);
    expect(r.og.title).toBeUndefined();
  });

  it('ends the chain at a 3xx without a Location header, reporting that response as final', async () => {
    const s = await site({ '/nowhere': (_req, res) => { res.statusCode = 302; res.end(); } });
    const url = `${s.origin}/nowhere`;
    const r = await (await local()).inspect(url);
    expect(r.chain).toEqual([{ url, status: 302 }]);
    expect(r.final).toMatchObject({ url, status: 302 });
  });

  it('reports a redirect loop as unreachable instead of spinning', async () => {
    const s = await site({ '/a': redirectTo('/b'), '/b': redirectTo('/a') });
    const { value: r, ms } = await timed(async () => (await local()).inspect(`${s.origin}/a`));
    expect(codes(r)).toContain('unreachable');
    expect(ms).toBeLessThan(3000);
    expect(s.hits.length).toBeLessThanOrEqual(6); // 1 + default maxRedirects
  });

  it('does not warn query_dropped for an input url that had no query', async () => {
    const s = await site({ '/x': redirectTo('/y', 301), '/y': page('<title>Y</title>') });
    const r = await (await local()).inspect(`${s.origin}/x`);
    expect(codes(r)).toContain('redirects');
    expect(codes(r)).not.toContain('query_dropped');
  });

  it('follows 5 redirects by default but not 6', async () => {
    const routes: Record<string, SiteHandler> = { '/end': page('<title>End</title>') };
    for (let i = 0; i < 6; i++) routes[`/r${i}`] = redirectTo(i === 5 ? '/end' : `/r${i + 1}`);
    const s = await site(routes);
    const shorty = await local();
    const five = await shorty.inspect(`${s.origin}/r1`);
    expect(codes(five)).not.toContain('unreachable');
    expect(five.og.title).toBe('End');
    expect(five.chain).toHaveLength(6);
    const six = await shorty.inspect(`${s.origin}/r0`);
    expect(codes(six)).toContain('unreachable');
  });
});

describe('inspect — utm_incomplete edges (audit follow-up)', () => {
  it('warns when medium and campaign are set but source is missing', async () => {
    const s = await site({ '/': page('<title>Home</title>') });
    const r = await (await local()).inspect(`${s.origin}/?utm_medium=social&utm_campaign=spring`);
    expect(codes(r)).toContain('utm_incomplete');
  });

  it('treats an empty utm_source= as absent', async () => {
    const s = await site({ '/': page('<title>Home</title>') });
    const r = await (await local()).inspect(`${s.origin}/?utm_source=&utm_medium=social&utm_campaign=spring`);
    expect(codes(r)).toContain('utm_incomplete');
  });
});

describe('inspect — budget and body handling (audit follow-up)', () => {
  it('bounds a DNS lookup that never resolves by timeoutMs', async () => {
    const shorty = await inspector({ timeoutMs: 300, lookup: () => new Promise<string[]>(() => {}) });
    const { value: r, ms } = await timed(() => shorty.inspect('http://stuck-dns.test/'));
    expect(codes(r)).toContain('unreachable');
    expect(ms).toBeLessThan(2000);
  });

  it('bounds a screenshot adapter that never resolves by timeoutMs, keeping the scraped OG', async () => {
    const s = await site({ '/': page('<title>Fast page</title>') });
    const shorty = await inspector(
      { isAllowedAddress: allowLoopback, timeoutMs: 500 },
      { screenshot: () => new Promise(() => {}) },
    );
    const { value: r, ms } = await timed(() => shorty.inspect(`${s.origin}/`));
    expect(ms).toBeLessThan(2500);
    expect(r.screenshot).toBeUndefined();
    expect(r.og.title).toBe('Fast page');
    expect(r.final?.status).toBe(200);
  });

  it('stops at maxBytes on an endless head that never reaches </head> — 200 with partial OG, not unreachable', async () => {
    const s = await site({
      '/endless': (_req, res) => {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.write('<!doctype html><html><head><meta property="og:title" content="Big">');
        const t = setInterval(() => res.write(`<meta name="filler" content="${'y'.repeat(1000)}">`), 5);
        res.on('close', () => clearInterval(t));
      },
    });
    const shorty = await local({ maxBytes: 50_000, timeoutMs: 5000 });
    const { value: r, ms } = await timed(() => shorty.inspect(`${s.origin}/endless`));
    expect(ms).toBeLessThan(3000);
    expect(r.final?.status).toBe(200);
    expect(r.og.title).toBe('Big');
    expect(codes(r)).not.toContain('unreachable');
  });

  it('does not scrape a non-HTML body (image/png that happens to contain a <title>)', async () => {
    const s = await site({
      '/img.png': (_req, res) => {
        res.setHeader('content-type', 'image/png');
        res.end(Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.from('<head><title>Fake</title><meta property="og:image" content="/x.png"></head>'),
        ]));
      },
    });
    const r = await (await local()).inspect(`${s.origin}/img.png`);
    expect(r.final?.status).toBe(200);
    expect(r.og).toEqual({});
  });

  it('hands the screenshot adapter the FINAL url after redirects', async () => {
    const s = await site({ '/start': redirectTo('/landing'), '/landing': page('<title>L</title>') });
    const asked: string[] = [];
    const shorty = await inspector(
      { isAllowedAddress: allowLoopback },
      { screenshot: async (url) => { asked.push(url); return null; } },
    );
    await shorty.inspect(`${s.origin}/start`);
    expect(asked).toEqual([`${s.origin}/landing`]);
  });

  it('does not call the screenshot adapter for an unreachable destination', async () => {
    const asked: string[] = [];
    const shorty = await inspector(
      { isAllowedAddress: () => true, lookup: async () => { throw new Error('ENOTFOUND'); } },
      { screenshot: async (url) => { asked.push(url); return null; } },
    );
    await shorty.inspect('http://nxdomain.test/');
    expect(asked).toEqual([]);
  });

  it('sends the default User-Agent when none is configured', async () => {
    let ua: string | undefined;
    const s = await site({
      '/ua': (req, res) => { ua = req.headers['user-agent']; page('<title>U</title>')(req, res); },
    });
    await (await local()).inspect(`${s.origin}/ua`);
    expect(ua).toBe('shorty-inspect (+link preview)');
  });
});

describe('inspect — PR 3 review follow-ups', () => {
  // v6 forms that embed or stand in for a non-public v4 / non-public v6 space.
  it.each([
    ['2002:7f00:1::', '6to4 of 127.0.0.1'],
    ['2002:a00:5::', '6to4 of 10.0.0.5'],
    ['2001:0::1', 'Teredo'],
    ['64:ff9b::7f00:1', 'NAT64 of 127.0.0.1'],
    ['64:ff9b:1::a00:5', 'local-use NAT64 64:ff9b:1::/48'],
    ['::7f00:1', 'deprecated v4-compatible ::127.0.0.1'],
    ['fec0::1', 'site-local'],
    ['100::1', 'discard-only 100::/64'],
  ])('refuses a hostname that resolves to %s (%s)', async (addr) => {
    const s = await site({ '/': page('<title>SECRET</title>') });
    const shorty = await inspector({ lookup: async () => [addr] });
    const r = await shorty.inspect(`http://sneaky.test:${s.port}/`);
    expect(codes(r)).toContain('private_address');
    expect(s.hits).toEqual([]);
  });

  it('does not connect when the isAllowedAddress override throws', async () => {
    const s = await site({ '/': page('<title>SECRET</title>') });
    const shorty = await inspector({
      lookup: async () => ['127.0.0.1'],
      isAllowedAddress: () => { throw new Error('policy bug'); },
    });
    const r = await shorty.inspect(`http://x.test:${s.port}/`);
    expect(codes(r)).toContain('private_address');
    expect(s.hits).toEqual([]);
  });

  it.each(['apple-touch-icon', 'mask-icon', 'icon-x'])('does not treat rel="%s" as a favicon or image', async (rel) => {
    const s = await site({ '/': page(`<title>T</title><link rel="${rel}" href="/a.png">`) });
    const r = await (await local()).inspect(`${s.origin}/`);
    expect(r.og.favicon).toBeUndefined();
    expect(r.og.image).toBeUndefined();
  });

  it('does not stop reading at a </head> or <body inside a head <script> or comment', async () => {
    // Two chunks with a pause, so a reader that stops at the first raw
    // `</head` / `<body` byte sequence really does stop before the og tag.
    const s = await site({
      '/': (_req, res) => {
        res.setHeader('content-type', 'text/html');
        res.write(`<!doctype html><html><head><script>var a = '</head><body>';</script><!-- <body> </head> -->`);
        setTimeout(() => res.end('<meta property="og:title" content="After the decoys"></head><body></body></html>'), 150);
      },
    });
    const r = await (await local()).inspect(`${s.origin}/`);
    expect(r.og.title).toBe('After the decoys');
  });

  it.each([
    [{ contentType: 123, body: 'x' }],
    [{ contentType: null, body: null }],
    [{}],
    ['not an object'],
  ])('does not reject when the screenshot adapter returns garbage (%j)', async (garbage) => {
    const s = await site({ '/': page('<title>T</title>') });
    const shot = (async () => garbage) as unknown as ScreenshotAdapter;
    const shorty = await inspector({ isAllowedAddress: allowLoopback }, { screenshot: shot });
    const r = await shorty.inspect(`${s.origin}/`);
    expect(r.og.title).toBe('T');
    expect(r.screenshot).toBeUndefined();
  });

  describe('over https', () => {
    const tls = {
      key: fs.readFileSync(path.join(__dirname, 'fixtures/tls-key.pem')),
      cert: fs.readFileSync(path.join(__dirname, 'fixtures/tls-cert.pem')),
    };
    let server: https.Server | undefined;
    afterEach(async () => {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      server = undefined;
    });

    async function startTls(): Promise<{ port: number; snis: string[]; connections: () => number }> {
      const snis: string[] = [];
      let connections = 0;
      server = https.createServer({
        ...tls,
        SNICallback: (name, cb) => { snis.push(name); cb(null, tlsContext); },
      }, (_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>TLS</title>'); });
      const tlsContext = (await import('node:tls')).createSecureContext(tls);
      server.on('connection', () => { connections += 1; });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      return { port: (server!.address() as AddressInfo).port, snis, connections: () => connections };
    }

    it('connects to the checked address with the hostname as SNI, resolving once', async () => {
      const t = await startTls();
      let lookups = 0;
      const shorty = await inspector({
        isAllowedAddress: allowLoopback,
        lookup: async () => { lookups += 1; return ['127.0.0.1']; },
      });
      // The fixture cert is self-signed, so verification fails → 'unreachable'.
      // What matters: the TLS handshake reached the CHECKED address and named
      // the original host, and DNS ran exactly once.
      const r = await shorty.inspect(`https://public.test:${t.port}/`);
      expect(t.snis).toEqual(['public.test']);
      expect(lookups).toBe(1);
      expect(codes(r)).toContain('unreachable');
    });

    it('does not open a TLS connection to a private address', async () => {
      const t = await startTls();
      const shorty = await inspector({ lookup: async () => ['127.0.0.1'] });
      const r = await shorty.inspect(`https://public.test:${t.port}/`);
      expect(codes(r)).toContain('private_address');
      expect(t.connections()).toBe(0);
    });
  });
});
