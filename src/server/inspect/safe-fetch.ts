import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { ResolvedContext } from '../config.js';
import { parseHead } from './og.js';

/**
 * SSRF-safe fetch (Dub's model, research.md §7): per hop, resolve ONCE, check
 * EVERY address, connect to the address that was checked (never re-resolve),
 * follow redirects by hand and re-validate each hop. Nothing here throws for
 * network reasons — a failure is `failure: 'private_address' | 'unreachable'`.
 */

type InspectCtx = ResolvedContext['inspect'];

// ── address policy ──────────────────────────────────────────────────────────

function parseIPv4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

function parseIPv6(input: string): number[] | null {
  let s = input;
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (s.includes('.')) {
    const cut = s.lastIndexOf(':');
    const v4 = parseIPv4(s.slice(cut + 1));
    if (!v4) return null;
    s = `${s.slice(0, cut + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const split = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const head = split(halves[0]);
  const tail = halves.length === 2 ? split(halves[1]) : [];
  if (halves.length === 1 ? head.length !== 8 : head.length + tail.length > 7) return null;
  const fill = halves.length === 2 ? new Array<string>(8 - head.length - tail.length).fill('0') : [];
  const groups = [...head, ...fill, ...tail].map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : null;
}

function isPublicV4([a, b, c]: number[]): boolean {
  if (a === 0) return false;                                   // 0/8 "this network" / unspecified
  if (a === 10) return false;                                  // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return false;          // CGNAT 100.64/10
  if (a === 127) return false;                                 // loopback
  if (a === 169 && b === 254) return false;                    // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;           // RFC 1918
  if (a === 192 && b === 0 && c === 0) return false;           // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return false;           // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false;         // 6to4 relay anycast (deprecated)
  if (a === 192 && b === 168) return false;                    // RFC 1918
  if (a === 198 && (b === 18 || b === 19)) return false;       // benchmarking
  if (a === 198 && b === 51 && c === 100) return false;        // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false;         // TEST-NET-3
  if (a >= 224) return false;                                  // multicast 224/4, reserved 240/4, broadcast
  return true;
}

function isPublicV6(g: number[]): boolean {
  const v4 = (hi: number, lo: number): number[] => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  const zeros = (n: number): boolean => g.slice(0, n).every((x) => x === 0);
  if (zeros(5) && g[5] === 0xffff) return isPublicV4(v4(g[6], g[7]));            // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return false;               // local-use NAT64 64:ff9b:1::/48
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) { // NAT64 64:ff9b::/96
    return isPublicV4(v4(g[6], g[7]));
  }
  if ((g[0] & 0xe000) !== 0x2000) return false;                                  // only 2000::/3 from here on
  if (g[0] === 0x2002) return isPublicV4(v4(g[1], g[2]));                        // 6to4
  if (g[0] === 0x2001) {
    if (g[1] === 0) return false;                                                // Teredo 2001::/32
    if (g[1] === 2 && g[2] === 0) return false;                                  // benchmarking 2001:2::/48
    if ((g[1] & 0xfff0) === 0x10) return false;                                  // ORCHID 2001:10::/28
    if ((g[1] & 0xfff0) === 0x20) return false;                                  // ORCHIDv2 2001:20::/28
    if (g[1] === 0xdb8) return false;                                            // documentation
  }
  if (g[0] === 0x3fff && (g[1] & 0xf000) === 0) return false;                    // documentation 3fff::/20
  return true;
}

/** The default policy: public unicast addresses only. Unparseable → refused. */
export function isPublicAddress(address: string): boolean {
  const ip = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const v4 = parseIPv4(ip);
  if (v4) return isPublicV4(v4);
  const v6 = net.isIPv6(ip) || ip.includes(':') ? parseIPv6(ip) : null;
  return v6 ? isPublicV6(v6) : false;
}

// ── deadline plumbing ───────────────────────────────────────────────────────

class Aborted extends Error {
  constructor() { super('inspect deadline reached'); }
}

/** Rejects with `Aborted` as soon as `signal` fires, whatever `promise` is doing. */
function until<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Aborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

// ── one hop ─────────────────────────────────────────────────────────────────

interface HopResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** Present only for `text/html` responses; cut at `</head>` / `<body` / maxBytes. */
  body?: Buffer;
}

const stripBrackets = (h: string): string => (h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h);

function requestHop(url: URL, addresses: string[], cfg: InspectCtx, signal: AbortSignal): Promise<HopResponse> {
  return new Promise<HopResponse>((resolve, reject) => {
    if (signal.aborted) { reject(new Aborted()); return; }
    const secure = url.protocol === 'https:';
    const host = stripBrackets(url.hostname);
    const entries = addresses.map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 }));

    let req: http.ClientRequest | undefined;
    let res: http.IncomingMessage | undefined;
    let status = 0;
    let headers: http.IncomingHttpHeaders = {};
    const chunks: Buffer[] = [];
    let size = 0;
    let parsedAt = 0;
    let pending = false;   // a marker was seen but its parse was skipped by the doubling rule
    let done = false;

    const finish = (err?: Error): void => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      res?.destroy();
      req?.destroy();
      if (err) { reject(err); return; }
      resolve({ status, headers, ...(wantsBody ? { body: Buffer.concat(chunks).subarray(0, cfg.maxBytes) } : {}) });
    };
    // Past the headers, running out of time keeps what was read; before them it is a failure.
    const onAbort = (): void => finish(res ? undefined : new Aborted());
    let wantsBody = false;
    signal.addEventListener('abort', onAbort, { once: true });

    const options: https.RequestOptions = {
      method: 'GET',
      hostname: host,
      port: url.port || (secure ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      agent: false,
      headers: {
        'user-agent': cfg.userAgent,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'accept-encoding': 'identity',
        connection: 'close',
      },
      // The ONLY resolution that happens at connect time: hand back the
      // addresses that already passed the policy. Node never asks DNS.
      // Called back on the next tick, like real DNS: a synchronous callback lets
      // an instant connect failure (ENETUNREACH on hosts without an IPv6 route)
      // fire the socket's 'error' before ClientRequest has attached its handler,
      // which surfaces as an uncaught exception in the host process.
      lookup: ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
        process.nextTick(() => {
          if (opts && opts.all) cb(null, entries);
          else cb(null, entries[0].address, entries[0].family);
        });
      }) as unknown as net.LookupFunction,
    };
    if (secure && !net.isIP(host)) options.servername = host;   // SNI + cert name stay the hostname

    req = (secure ? https : http).request(options, (response) => {
      res = response;
      status = response.statusCode ?? 0;
      headers = response.headers;
      response.on('error', () => finish());
      response.on('close', () => finish());
      const type = String(headers['content-type'] ?? '').toLowerCase();
      wantsBody = !(status >= 300 && status < 400) && /^\s*text\/html\b/.test(type);
      if (!wantsBody) { finish(); return; }

      let tail = '';
      response.on('data', (chunk: Buffer) => {
        if (done) return;
        chunks.push(chunk);
        size += chunk.length;
        const window = (tail + chunk.toString('latin1')).toLowerCase();
        tail = window.slice(-8);
        if (size >= cfg.maxBytes) { finish(); return; }
        // Cheap pre-filter, then ask the tokenizer: a `</head` inside a
        // <script> or comment is not the end of the head.
        // Re-parse only once the buffer has doubled since the last parse (linear in total);
        // a marker seen while waiting is remembered so a decoy cannot hide the real end.
        if (window.includes('</head') || window.includes('<body')) pending = true;
        if (pending && size >= parsedAt * 2) {
          parsedAt = size;
          pending = false;
          if (parseHead(Buffer.concat(chunks).toString('latin1'), url.href).ended) finish();
        }
      });
      response.on('end', () => finish());
    });
    req.on('error', (e) => finish(e));
    req.end();
  });
}

// ── the chain ───────────────────────────────────────────────────────────────

export type FetchOutcome =
  | {
      chain: Array<{ url: string; status: number }>;
      /** A hop answered and the chain ended there. */
      final: { url: string; status: number; ms: number };
      headers: http.IncomingHttpHeaders;
      /** Raw head bytes, `text/html` only. */
      body?: Buffer;
      failure?: undefined;
    }
  | {
      chain: Array<{ url: string; status: number }>;
      final?: undefined;
      headers?: undefined;
      body?: undefined;
      failure: 'private_address' | 'unreachable';
    };

const REDIRECT = (s: number): boolean => s >= 300 && s < 400;
const bare = (u: URL): string => { const c = new URL(u.href); c.hash = ''; return c.href; };

async function checkedAddresses(url: URL, cfg: InspectCtx, signal: AbortSignal): Promise<string[] | 'private_address' | 'unreachable'> {
  const allowed = (ip: string): boolean => {
    try { return cfg.isAllowedAddress ? cfg.isAllowedAddress(ip) === true : isPublicAddress(ip); } catch { return false; }
  };
  const host = stripBrackets(url.hostname);
  let addresses: string[];
  if (net.isIP(host)) {
    addresses = [host];                       // already a literal (WHATWG normalised 2130706433, 0x7f.1, 127.1 …)
  } else {
    try {
      const found = await until(Promise.resolve().then(() => cfg.lookup(host)), signal);
      addresses = Array.isArray(found) ? found.filter((a): a is string => typeof a === 'string') : [];
    } catch {
      return 'unreachable';                   // DNS failure, timeout: fail closed
    }
    if (addresses.length === 0 || addresses.some((a) => !net.isIP(a))) return 'unreachable';
  }
  return addresses.every(allowed) ? addresses : 'private_address';
}

export async function safeFetch(start: URL, cfg: InspectCtx, signal: AbortSignal, t0: number): Promise<FetchOutcome> {
  const out: { chain: Array<{ url: string; status: number }> } = { chain: [] };
  const seen = new Set<string>();
  let url = start;
  let redirects = 0;

  for (;;) {
    const key = bare(url);
    if (seen.has(key)) return { ...out, failure: 'unreachable' };   // loop
    seen.add(key);

    const addresses = await checkedAddresses(url, cfg, signal);
    if (typeof addresses === 'string') return { ...out, failure: addresses };

    let hop: HopResponse;
    try {
      hop = await requestHop(url, addresses, cfg, signal);
    } catch {
      return { ...out, failure: 'unreachable' };
    }
    out.chain.push({ url: key, status: hop.status });

    if (REDIRECT(hop.status)) {
      const location = hop.headers.location;
      let next: URL | null = null;
      if (typeof location === 'string' && location.trim()) {
        try {
          const candidate = new URL(location.trim(), url);
          if (candidate.protocol === 'http:' || candidate.protocol === 'https:') next = candidate;
        } catch { /* unparseable Location: this response is the end */ }
      }
      if (next) {
        if (redirects >= cfg.maxRedirects) return { ...out, failure: 'unreachable' };
        redirects += 1;
        url = next;
        continue;
      }
    }
    return {
      ...out,
      final: { url: key, status: hop.status, ms: Date.now() - t0 },
      headers: hop.headers,
      ...(hop.body ? { body: hop.body } : {}),
    };
  }
}
