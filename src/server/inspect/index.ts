import type { InspectResult, InspectWarning, OgData } from '../../../types/index.js';
import { parseUrl } from '../../shared/url.js';
import type { ResolvedContext } from '../config.js';
import { parseHead } from './og.js';
import { safeFetch } from './safe-fetch.js';

/** `inspect(url)` — OG preview + destination health (plan §7.6). */

const UTM_REQUIRED = ['source', 'medium', 'campaign'] as const;

function decodeBody(body: Buffer, contentType: string): string {
  let label = /charset\s*=\s*["']?([\w:.-]+)/i.exec(contentType)?.[1];
  if (!label) label = /<meta[^>]+charset\s*=\s*["']?([\w:.-]+)/i.exec(body.subarray(0, 2048).toString('latin1'))?.[1];
  try {
    return new TextDecoder(label ?? 'utf-8').decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

/** Every query param of the original (name and value) is still on the final url. */
function queryKept(original: URL, final: URL): boolean {
  const kept = new Set<string>();
  for (const [k, v] of final.searchParams) kept.add(`${k}\u0000${v}`);
  for (const [k, v] of original.searchParams) if (!kept.has(`${k}\u0000${v}`)) return false;
  return true;
}

export function createInspect(ctx: ResolvedContext): (url: string) => Promise<InspectResult> {
  return async function inspect(input: string): Promise<InspectResult> {
    const parts = parseUrl(input);            // throws invalid_url / unsupported_scheme
    const asked = input.trim();
    const start = new URL(asked);

    const t0 = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ctx.inspect.timeoutMs);
    try {
      const fetched = await safeFetch(start, ctx.inspect, ac.signal, t0);
      const warnings: InspectWarning[] = [];
      let og: OgData = {};

      if (fetched.failure === 'private_address') {
        warnings.push({ code: 'private_address', message: 'This address points at a private or internal network, so it was not fetched.' });
      } else if (fetched.failure === 'unreachable') {
        warnings.push({ code: 'unreachable', message: 'The destination could not be reached (timeout, DNS failure, refused connection, or too many redirects).' });
      }

      const final = fetched.final;
      if (final) {
        const headers = fetched.headers ?? {};
        let noindex = /(^|[\s,])(noindex|none)([\s,]|$)/i.test(String(headers['x-robots-tag'] ?? ''));

        if (fetched.body) {
          const head = parseHead(decodeBody(fetched.body, String(headers['content-type'] ?? '')), final.url);
          og = head.og;
          noindex = noindex || head.noindex;
        }

        const cloudflare =
          /challenge/i.test(String(headers['cf-mitigated'] ?? '')) ||
          ([403, 429, 503].includes(final.status) &&
            /cloudflare/i.test(String(headers.server ?? '')) &&
            /^just a moment/i.test(og.title ?? ''));

        if (fetched.chain.length > 1) {
          warnings.push({
            code: 'redirects',
            message: `The link redirects ${fetched.chain.length - 1} time${fetched.chain.length === 2 ? '' : 's'} before reaching its page; linking to the final address is faster.`,
            fix: { kind: 'use_final_url', url: final.url },
          });
          if (start.search && !queryKept(start, new URL(final.url))) {
            warnings.push({ code: 'query_dropped', message: 'A redirect drops the query string, so UTM parameters never reach your analytics.' });
          }
        }
        if (final.status >= 400) {
          warnings.push({ code: 'not_ok', message: `The destination answered with status ${final.status}.` });
        }
        if (noindex) {
          warnings.push({ code: 'noindex_destination', message: 'The destination asks search engines not to index it.' });
        }
        if (cloudflare) {
          og = {};
          warnings.push({ code: 'cloudflare_challenge', message: 'The destination showed a bot challenge, so its preview is unavailable (the page itself may be fine).' });
        }
      }

      const utmSet = Object.keys(parts.utm).length > 0;
      if (utmSet && !UTM_REQUIRED.every((f) => parts.utm[f])) {
        warnings.push({ code: 'utm_incomplete', message: 'Some UTM parameters are set, but not all of source, medium and campaign.' });
      }

      const result: InspectResult = {
        url: asked,
        og,
        ...(final ? { final } : {}),
        chain: fetched.chain,
        warnings,
      };

      if (final && ctx.screenshot && !ac.signal.aborted) {
        const shoot = ctx.screenshot;
        try {
          const shot = await new Promise<unknown>((resolve) => {
            const onAbort = (): void => resolve(null);
            ac.signal.addEventListener('abort', onAbort, { once: true });
            Promise.resolve()
              .then(() => shoot(final.url, { addresses: fetched.addresses ?? [] }))
              .then(resolve, () => resolve(null))
              .finally(() => ac.signal.removeEventListener('abort', onAbort));
          });
          const o = shot as { contentType?: unknown; body?: unknown } | null;
          if (o && typeof o === 'object' && typeof o.contentType === 'string' && /^image\/[a-z0-9.+-]+$/i.test(o.contentType) &&
              (Buffer.isBuffer(o.body) || o.body instanceof Uint8Array)) {
            result.screenshot = `data:${o.contentType};base64,${Buffer.from(o.body).toString('base64')}`;
          }
        } catch { /* any adapter misbehaviour: no screenshot */ }
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  };
}
