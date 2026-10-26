import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type http from 'node:http';
import { ShortyError } from '../src/shared/errors.js';
import type { InspectConfig, InspectResult, InspectWarningCode, ScreenshotAdapter } from '../types/index.js';
import { allowLoopback, harness, page, redirectTo, startSite, startDb, stopDb } from './helpers.js';
import type { Site, SiteHandler } from './helpers.js';

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
