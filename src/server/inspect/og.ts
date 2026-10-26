import type { OgData } from '../../../types/index.js';

/**
 * A deliberately small `<head>` tokenizer. It reads tags up to `</head>` (or
 * `<body>`), collecting `<meta>`, `<link>` and `<title>`; comments, scripts and
 * styles are skipped; an unterminated trailing tag (the body was cut at
 * maxBytes) is ignored. It is not an HTML parser and never needs to be one.
 */

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
  trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', middot: '·', bull: '•', laquo: '«', raquo: '»',
  euro: '€', pound: '£', yen: '¥', cent: '¢', times: '×', deg: '°',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

interface Tag {
  name: string;
  attrs: Map<string, string>;
  end: number;
}

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/** Reads the open tag starting at `text[i] === '<'`. `null` when it never terminates. */
function readTag(text: string, i: number): Tag | null {
  const nameMatch = /^<([a-zA-Z][^\s/>]*)/.exec(text.slice(i, i + 64));
  if (!nameMatch) return null;
  const attrs = new Map<string, string>();
  let p = i + nameMatch[0].length;
  const n = text.length;
  while (p < n) {
    while (p < n && (isSpace(text[p]) || text[p] === '/')) p++;
    if (p >= n) return null;
    if (text[p] === '>') return { name: nameMatch[1].toLowerCase(), attrs, end: p + 1 };
    const s = p;
    while (p < n && !isSpace(text[p]) && text[p] !== '=' && text[p] !== '>' && text[p] !== '/') p++;
    const key = text.slice(s, p).toLowerCase();
    while (p < n && isSpace(text[p])) p++;
    let value = '';
    if (text[p] === '=') {
      p++;
      while (p < n && isSpace(text[p])) p++;
      if (p >= n) return null;
      const q = text[p];
      if (q === '"' || q === "'") {
        const close = text.indexOf(q, p + 1);
        if (close === -1) return null;
        value = text.slice(p + 1, close);
        p = close + 1;
      } else {
        const vs = p;
        while (p < n && !isSpace(text[p]) && text[p] !== '>') p++;
        value = text.slice(vs, p);
      }
    }
    if (key && !attrs.has(key)) attrs.set(key, value);
  }
  return null;
}

function findCI(text: string, needle: string, from: number): number {
  const re = new RegExp(needle, 'ig');
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? m.index : -1;
}

export interface HeadInfo {
  og: OgData;
  /** `<meta name="robots">` carried `noindex` (or `none`). */
  noindex: boolean;
}

const clean = (s: string | undefined): string | undefined => {
  if (s === undefined) return undefined;
  const v = decodeEntities(s).replace(/\s+/g, ' ').trim();
  return v === '' ? undefined : v;
};

export function parseHead(html: string, baseUrl: string): HeadInfo {
  const meta = new Map<string, string>();      // lowercased property/name → first non-empty content
  const links: Array<{ rel: string[]; href: string }> = [];
  let docTitle: string | undefined;
  let noindex = false;

  let i = 0;
  scan: while ((i = html.indexOf('<', i)) !== -1) {
    if (html.startsWith('<!--', i)) {
      const j = html.indexOf('-->', i + 4);
      if (j === -1) break;
      i = j + 3;
      continue;
    }
    const next = html[i + 1];
    if (next === '/') {
      const m = /^<\/([a-zA-Z][a-zA-Z0-9]*)/.exec(html.slice(i, i + 32));
      if (m && m[1].toLowerCase() === 'head') break;
      const j = html.indexOf('>', i);
      if (j === -1) break;
      i = j + 1;
      continue;
    }
    if (next === '!' || next === '?') {
      const j = html.indexOf('>', i);
      if (j === -1) break;
      i = j + 1;
      continue;
    }
    const tag = readTag(html, i);
    if (!tag) {
      if (next && /[a-zA-Z]/.test(next)) break;   // unterminated tag: the cut-off point
      i += 1;                                      // a stray `<` in text
      continue;
    }
    i = tag.end;
    switch (tag.name) {
      case 'body':
        break scan;
      case 'title': {
        const close = findCI(html, '</title', tag.end);
        if (close === -1) break scan;
        if (docTitle === undefined) docTitle = clean(html.slice(tag.end, close));
        i = close;
        break;
      }
      case 'script':
      case 'style': {
        const close = findCI(html, `</${tag.name}`, tag.end);
        if (close === -1) break scan;
        i = close;
        break;
      }
      case 'meta': {
        const key = (tag.attrs.get('property') ?? tag.attrs.get('name'))?.trim().toLowerCase();
        const content = tag.attrs.get('content');
        if (!key || content === undefined) break;
        if (key === 'robots' || key === 'googlebot') {
          if (/(^|[\s,])(noindex|none)([\s,]|$)/i.test(content)) noindex = true;
        }
        if (content.trim() !== '' && !meta.has(key)) meta.set(key, content);
        break;
      }
      case 'link': {
        const rel = tag.attrs.get('rel');
        const href = tag.attrs.get('href');
        if (rel && href && href.trim()) links.push({ rel: rel.toLowerCase().split(/\s+/), href: href.trim() });
        break;
      }
      default:
        break;
    }
  }

  const absolute = (raw: string | undefined): string | undefined => {
    const v = raw === undefined ? undefined : decodeEntities(raw).trim();
    if (!v) return undefined;
    try {
      const u = new URL(v, baseUrl);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
    } catch {
      return undefined;
    }
  };
  const linkHref = (pred: (rel: string[]) => boolean): string | undefined => {
    for (const l of links) if (pred(l.rel)) { const a = absolute(l.href); if (a) return a; }
    return undefined;
  };
  const firstMeta = (...keys: string[]): string | undefined => {
    for (const k of keys) { const v = clean(meta.get(k)); if (v !== undefined) return v; }
    return undefined;
  };
  const firstUrl = (...candidates: Array<string | undefined>): string | undefined => {
    for (const c of candidates) if (c !== undefined) return c;
    return undefined;
  };

  const favicon = linkHref((rel) => rel.includes('icon'));
  const og: OgData = {};
  const title = firstMeta('og:title', 'twitter:title') ?? docTitle;
  const description = firstMeta('description', 'og:description', 'twitter:description');
  const image = firstUrl(
    absolute(meta.get('og:image')) ?? absolute(meta.get('og:image:url')) ?? absolute(meta.get('og:image:secure_url')),
    absolute(meta.get('twitter:image')) ?? absolute(meta.get('twitter:image:src')),
    linkHref((rel) => rel.includes('image_src')),
    favicon,
  );
  const siteName = firstMeta('og:site_name');
  if (title !== undefined) og.title = title;
  if (description !== undefined) og.description = description;
  if (image !== undefined) og.image = image;
  if (siteName !== undefined) og.siteName = siteName;
  if (favicon !== undefined) og.favicon = favicon;
  return { og, noindex };
}
