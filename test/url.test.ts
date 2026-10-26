import { describe, expect, it } from 'vitest';
import { composeUrl, parseUrl, ShortyError } from '../src/server/index.js';
import type { ShortyErrorCode, UrlParts } from '../types/index.js';

/**
 * composeUrl / parseUrl — the pure pair the server stores and the SPA previews
 * with (types/index.d.ts, §7.1). No DB.
 */

function codeOf(fn: () => unknown): ShortyErrorCode | 'no error' {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ShortyError);
    return (err as ShortyError).code;
  }
  return 'no error';
}

const parts = (p: Partial<UrlParts> & { baseUrl: string }): UrlParts => ({ utm: {}, params: [], ...p });

describe('composeUrl', () => {
  it('does not let UTM order depend on object key order', () => {
    const url = composeUrl(parts({
      baseUrl: 'https://a.com/p',
      utm: { id: '6', content: '5', term: '4', campaign: '3', medium: '2', source: '1' },
    }));
    expect(url).toBe('https://a.com/p?utm_source=1&utm_medium=2&utm_campaign=3&utm_term=4&utm_content=5&utm_id=6');
  });

  it('does not reorder or dedupe params, and puts them after the UTMs', () => {
    const url = composeUrl(parts({
      baseUrl: 'https://a.com/p',
      utm: { source: 'ig' },
      params: [{ key: 'z', value: '1' }, { key: 'a', value: '2' }, { key: 'z', value: '3' }],
    }));
    expect(url).toBe('https://a.com/p?utm_source=ig&z=1&a=2&z=3');
  });

  it('does not emit a dangling ? or empty UTM fields', () => {
    expect(composeUrl(parts({ baseUrl: 'https://a.com/p' }))).toBe('https://a.com/p');
    expect(composeUrl(parts({ baseUrl: 'https://a.com/p', utm: { source: '', medium: 'email' } })))
      .toBe('https://a.com/p?utm_medium=email');
  });

  it('does not render an empty param value as key=', () => {
    expect(composeUrl(parts({ baseUrl: 'https://a.com/', params: [{ key: 'debug', value: '' }] })))
      .toBe('https://a.com/?debug');
  });

  it('does not encode spaces as + (uses %20)', () => {
    expect(composeUrl(parts({
      baseUrl: 'https://a.com/',
      utm: { campaign: 'spring sale' },
      params: [{ key: 'q', value: 'red shoes' }],
    }))).toBe('https://a.com/?utm_campaign=spring%20sale&q=red%20shoes');
  });

  it('does not let &, =, # or unicode in keys/values break the query', () => {
    expect(composeUrl(parts({
      baseUrl: 'https://a.com/',
      params: [{ key: 'a&b', value: 'c=d#e' }, { key: 'w', value: 'café' }],
    }))).toBe('https://a.com/?a%26b=c%3Dd%23e&w=caf%C3%A9');
  });

  it('does not put the hash before the query', () => {
    expect(composeUrl(parts({ baseUrl: 'https://a.com/p', utm: { source: 'x' }, hash: 'top' })))
      .toBe('https://a.com/p?utm_source=x#top');
  });

  it('does not accept a baseUrl carrying a query or fragment', () => {
    expect(codeOf(() => composeUrl(parts({ baseUrl: 'https://a.com/p?x=1' })))).toBe('invalid_base_url');
    expect(codeOf(() => composeUrl(parts({ baseUrl: 'https://a.com/p#top' })))).toBe('invalid_base_url');
  });

  it('does not accept a relative, non-http, or credentialed baseUrl', () => {
    expect(codeOf(() => composeUrl(parts({ baseUrl: '/p' })))).toBe('invalid_base_url');
    expect(codeOf(() => composeUrl(parts({ baseUrl: 'javascript:alert(1)' })))).toBe('invalid_base_url');
    expect(codeOf(() => composeUrl(parts({ baseUrl: 'ftp://a.com/f' })))).toBe('invalid_base_url');
    expect(codeOf(() => composeUrl(parts({ baseUrl: 'https://google.com@evil.com/' })))).toBe('invalid_base_url');
  });

  it('does not accept an empty param key', () => {
    expect(codeOf(() => composeUrl(parts({ baseUrl: 'https://a.com/', params: [{ key: '', value: 'x' }] }))))
      .toBe('invalid_param');
  });
});

describe('parseUrl', () => {
  it('does not leave UTMs in params or lose param order', () => {
    expect(parseUrl('https://acme.com/sale?ref=nav&utm_source=ig&utm_medium=social&x=1&ref=footer')).toEqual({
      baseUrl: 'https://acme.com/sale',
      utm: { source: 'ig', medium: 'social' },
      params: [{ key: 'ref', value: 'nav' }, { key: 'x', value: '1' }, { key: 'ref', value: 'footer' }],
    });
  });

  it('does not drop a later duplicate UTM (first wins, the rest stay params)', () => {
    const p = parseUrl('https://a.com/?utm_source=a&utm_source=b');
    expect(p.utm).toEqual({ source: 'a' });
    expect(p.params).toEqual([{ key: 'utm_source', value: 'b' }]);
  });

  it('does not treat an empty UTM value as the field', () => {
    const p = parseUrl('https://a.com/?utm_source=&utm_medium=m');
    expect(p.utm).toEqual({ medium: 'm' });
    expect(p.params).toEqual([{ key: 'utm_source', value: '' }]);
  });

  it('does not recognize UTM keys by case or by prefix', () => {
    const p = parseUrl('https://a.com/?UTM_SOURCE=x&utm_source_platform=y&Utm_Medium=z');
    expect(p.utm).toEqual({});
    expect(p.params).toEqual([
      { key: 'UTM_SOURCE', value: 'x' },
      { key: 'utm_source_platform', value: 'y' },
      { key: 'Utm_Medium', value: 'z' },
    ]);
  });

  it('does not keep + literally (URLSearchParams decoding: + is a space)', () => {
    const p = parseUrl('https://a.com/?q=a+b&utm_campaign=spring+sale');
    expect(p.utm.campaign).toBe('spring sale');
    expect(p.params).toEqual([{ key: 'q', value: 'a b' }]);
    expect(composeUrl(p)).toBe('https://a.com/?utm_campaign=spring%20sale&q=a%20b');
  });

  it('does not leave keys or values percent-encoded', () => {
    const p = parseUrl('https://a.com/?a%26b=c%3Dd%23e&w=caf%C3%A9&phone=%2B15551234');
    expect(p.params).toEqual([
      { key: 'a&b', value: 'c=d#e' },
      { key: 'w', value: 'café' },
      { key: 'phone', value: '+15551234' },
    ]);
  });

  it('does not mangle raw unicode in the query', () => {
    expect(parseUrl('https://a.com/?q=café').params).toEqual([{ key: 'q', value: 'café' }]);
  });

  it('does not lose bare keys', () => {
    const u = 'https://a.com/?debug&x=1';
    const p = parseUrl(u);
    expect(p.params).toEqual([{ key: 'debug', value: '' }, { key: 'x', value: '1' }]);
    expect(composeUrl(p)).toBe(u);
  });

  it('does not lose the fragment, or invent one', () => {
    expect(parseUrl('https://a.com/p?x=1#section-2').hash).toBe('section-2');
    expect(parseUrl('https://a.com/#/spa/route?x=1').hash).toBe('/spa/route?x=1');
    expect(parseUrl('https://a.com/p?x=1').hash).toBeUndefined();
  });

  it('does not return a baseUrl without a path', () => {
    expect(parseUrl('https://a.com').baseUrl).toBe('https://a.com/');
    expect(parseUrl('https://a.com?utm_source=x').baseUrl).toBe('https://a.com/');
    expect(parseUrl('http://localhost:3000/landing').baseUrl).toBe('http://localhost:3000/landing');
  });

  it('does not accept credentials (google.com@evil.com reads as google, goes to evil)', () => {
    expect(codeOf(() => parseUrl('https://google.com@evil.com/'))).toBe('invalid_url');
    expect(codeOf(() => parseUrl('https://user:pass@acme.com/'))).toBe('invalid_url');
  });

  it('does not accept non-http(s) schemes', () => {
    for (const u of ['javascript:alert(1)', 'ftp://a.com/file', 'data:text/html,<b>hi</b>', 'mailto:a@b.com']) {
      expect(codeOf(() => parseUrl(u)), u).toBe('unsupported_scheme');
    }
  });

  it('does not accept relative or empty input', () => {
    for (const u of ['/sale?x=1', 'acme.com/sale', '', '   ']) {
      expect(codeOf(() => parseUrl(u)), JSON.stringify(u)).toBe('invalid_url');
    }
  });
});

describe('round trip', () => {
  // Already in canonical form: UTMs first in fixed order, %20 for spaces.
  const canonical = [
    'https://acme.com/sale?utm_source=ig&utm_medium=social&utm_campaign=spring-26',
    'https://shop.acme.com/p/123?utm_source=newsletter&utm_medium=email&utm_campaign=bf&utm_content=hero&ref=abc#reviews',
    'https://acme.com/search?q=red%20shoes&size=10&size=11',
    'http://localhost:3000/landing?utm_source=test&debug',
    'https://acme.com/a/b/c?utm_term=caf%C3%A9&x=%26%3D',
    'https://acme.com/fr/caf%C3%A9?utm_source=fb',
    'https://acme.com/?phone=%2B15551234',
    'https://acme.com/?utm_source=a&utm_source=b',
    'https://acme.com/#/spa/route?x=1',
    'https://acme.com/p',
  ];

  // Real pastes that compose to a different (normalized) string.
  const nonCanonical = [
    'https://acme.com/?gclid=abc123&utm_source=google&utm_medium=cpc',
    'https://acme.com/?fbclid=x&utm_campaign=y&utm_source=z',
    'https://acme.com/?q=a+b',
    'https://acme.com/?a=1&&b=2',
    'https://acme.com/?q=café#frag',
    'https://acme.com',
  ];

  it.each(canonical)('does not change a canonical URL: %s', (u) => {
    expect(composeUrl(parseUrl(u))).toBe(u);
  });

  it.each([...canonical, ...nonCanonical])('does not lose information composing a parse: %s', (u) => {
    const once = parseUrl(u);
    const composed = composeUrl(once);
    expect(parseUrl(composed)).toEqual(once);
    // A second pass is a fixed point.
    expect(composeUrl(parseUrl(composed))).toBe(composed);
  });
});
