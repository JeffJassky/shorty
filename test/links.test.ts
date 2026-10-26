import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import { composeUrl, createShorty, ShortyError } from '../src/server/index.js';
import type {
  Actor,
  CreateShortyConfig,
  Link,
  LinkInput,
  ShortyErrorCode,
  ShortyInstance,
} from '../types/index.js';
import { BOT_UA, HUMAN_UA, MINUTE, harness, startDb, stopDb } from './helpers.js';
import type { Harness } from './helpers.js';

/**
 * The programmatic link service (§7.1, §7.3; ShortyInstance in types/index.d.ts).
 * HTTP routes are covered elsewhere; the only HTTP here is the redirect hit that
 * locks a slug under `rename: 'untilClicked'`.
 */

beforeAll(startDb);
afterAll(stopDb);

const ANN: Actor = { id: 'u_1', name: 'Ann Admin' };
const BOB: Actor = { id: 'u_2', name: 'Bob' };
const GENERATED = /^[23456789abcdefghjkmnpqrstuvwxyz]{7}$/;

async function rejects(p: Promise<unknown>, code: ShortyErrorCode): Promise<ShortyError> {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err, `expected ShortyError(${code})`).toBeInstanceOf(ShortyError);
  expect((err as ShortyError).code).toBe(code);
  return err as ShortyError;
}

function create(h: Harness, input: Partial<LinkInput> = {}): Promise<Link> {
  return h.shorty.createLink({ url: 'https://acme.com/sale', ...input });
}

/** The composed destination must always be composeUrl of the returned parts. */
function expectConsistent(link: Link): void {
  expect(link.destination).toBe(composeUrl({
    baseUrl: link.baseUrl, utm: link.utm, params: link.params, hash: link.hash,
  }));
}

async function humanClick(h: Harness, slug: string, ua = HUMAN_UA): Promise<void> {
  await request(h.app).get(`/go/${slug}`).set('User-Agent', ua);
  await h.shorty.drain();
}

// ─────────────────────────────────────────────────────────────────────────────

describe('createLink — destination', () => {
  it('does not store a pasted URL unsplit', async () => {
    const h = await harness();
    const link = await h.shorty.createLink({
      url: 'https://acme.com/sale?ref=nav&utm_source=ig&utm_medium=social#top',
    });
    expect(link.baseUrl).toBe('https://acme.com/sale');
    expect(link.utm).toEqual({ source: 'ig', medium: 'social' });
    expect(link.params).toEqual([{ key: 'ref', value: 'nav' }]);
    expect(link.hash).toBe('top');
    expect(link.destination).toBe('https://acme.com/sale?utm_source=ig&utm_medium=social&ref=nav#top');
  });

  it('does not compose a destination from parts any differently than composeUrl', async () => {
    const h = await harness();
    const link = await h.shorty.createLink({
      baseUrl: 'https://acme.com/p',
      utm: { campaign: 'spring', source: 'ig' },
      params: [{ key: 'ref', value: 'x' }, { key: 'debug', value: '' }],
      hash: 'top',
    });
    expect(link.destination).toBe('https://acme.com/p?utm_source=ig&utm_campaign=spring&ref=x&debug#top');
    expectConsistent(link);
  });

  it('does not start a new link with anything but rev 1, zero counters, unarchived', async () => {
    const h = await harness();
    const link = await create(h);
    expect(link).toMatchObject({
      rev: 1, clicks: 0, uniqueClicks: 0, botClicks: 0, archived: false, tags: [], aliases: [],
    });
    expect(link.id).toMatch(/^[0-9a-f]{24}$/);
    expect(link.shortUrl).toBe(`http://short.test/go/${link.slug}`);
  });

  it('does not stamp createdAt from the wall clock instead of config.now', async () => {
    const h = await harness();
    h.clock.set('2026-05-01T08:00:00.000Z');
    const link = await create(h);
    expect(link.createdAt.toISOString()).toBe('2026-05-01T08:00:00.000Z');
  });

  it('does not accept both url and parts', async () => {
    const h = await harness();
    await rejects(h.shorty.createLink({ url: 'https://acme.com/', baseUrl: 'https://acme.com/' }), 'ambiguous_destination');
    await rejects(h.shorty.createLink({ url: 'https://acme.com/', utm: { source: 'x' } }), 'ambiguous_destination');
  });

  it('does not accept a link with no destination', async () => {
    const h = await harness();
    await rejects(h.shorty.createLink({}), 'invalid_url');
    await rejects(h.shorty.createLink({ slug: 'nothing' }), 'invalid_url');
  });

  it('does not accept a bad url or baseUrl', async () => {
    const h = await harness();
    await rejects(h.shorty.createLink({ url: 'javascript:alert(1)' }), 'unsupported_scheme');
    await rejects(h.shorty.createLink({ url: 'https://google.com@evil.com/' }), 'invalid_url');
    await rejects(h.shorty.createLink({ baseUrl: 'https://acme.com/p?x=1' }), 'invalid_base_url');
  });

  it('does not accept a non-http expiredUrl or social image', async () => {
    const h = await harness();
    await rejects(create(h, { expiredUrl: 'javascript:alert(1)' }), 'validation');
    await rejects(create(h, { social: { image: 'ftp://acme.com/card.png' } }), 'validation');
  });

  it('does not let a link point back at this shorty', async () => {
    const h = await harness();
    await rejects(h.shorty.createLink({ url: 'http://short.test/go/other' }), 'destination_loop');
  });

  it('does not lose who created the link', async () => {
    const h = await harness();
    expect((await create(h, {})).createdBy).toBeUndefined();
    const link = await h.shorty.createLink({ url: 'https://acme.com/' }, { actor: BOB });
    expect(link.createdBy).toEqual(BOB);
  });
});

describe('createLink — destination host rules', () => {
  it('does not allow a host outside allowedHosts (strings exact, RegExps tested)', async () => {
    const h = await harness({ config: { destinations: { allowedHosts: ['acme.com', /\.acme\.org$/] } } });
    await expect(h.shorty.createLink({ url: 'https://acme.com/x' })).resolves.toBeTruthy();
    await expect(h.shorty.createLink({ url: 'https://shop.acme.org/x' })).resolves.toBeTruthy();
    await rejects(h.shorty.createLink({ url: 'https://evil.com/x' }), 'host_not_allowed');
    await rejects(h.shorty.createLink({ url: 'https://shop.acme.com/x' }), 'host_not_allowed');
    await rejects(h.shorty.createLink({ url: 'https://notacme.com/x' }), 'host_not_allowed');
  });

  it('does not allow a blocked host (strings exact, RegExps tested)', async () => {
    const h = await harness({ config: { destinations: { blockedHosts: ['evil.com', /(^|\.)bad\.io$/] } } });
    await rejects(h.shorty.createLink({ url: 'https://evil.com/x' }), 'host_blocked');
    await rejects(h.shorty.createLink({ url: 'https://cdn.bad.io/x' }), 'host_blocked');
    await expect(h.shorty.createLink({ url: 'https://sub.evil.com/x' })).resolves.toBeTruthy();
  });

  it('does not let an update move a link onto a blocked host', async () => {
    const h = await harness({ config: { destinations: { blockedHosts: ['evil.com'] } } });
    const link = await create(h);
    await rejects(h.shorty.updateLink(link.id, { baseUrl: 'https://evil.com/' }), 'host_blocked');
    await rejects(h.shorty.updateLink(link.id, { url: 'https://evil.com/?a=1' }), 'host_blocked');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('slugs — generation', () => {
  it('does not generate slugs outside the default alphabet and length', async () => {
    const h = await harness();
    const link = await create(h);
    expect(link.slug).toMatch(GENERATED);
    expect(link.origin).toBe('generated');
  });

  it('does not mark a custom slug as generated', async () => {
    const h = await harness();
    expect((await create(h, { slug: 'spring' })).origin).toBe('custom');
  });

  it('does not give up on the first generator collision', async () => {
    const queue: string[] = [];
    const h = await harness({ config: { slug: { generate: () => queue.shift() ?? 'zzfallback' } } });
    await create(h, { slug: 'taken1' });
    queue.push('taken1', 'taken1', 'fresh1');
    const link = await create(h);
    expect(link.slug).toBe('fresh1');
    expect(link.origin).toBe('generated');
  });

  it('does not loop forever when every generated slug is taken', async () => {
    const h = await harness({ config: { slug: { generate: () => 'taken1' } } });
    await create(h, { slug: 'taken1' });
    await rejects(create(h), 'slug_generation_exhausted');
  });

  it('does not offer an already-claimed slug from generateSlug', async () => {
    const queue: string[] = [];
    const h = await harness({ config: { slug: { generate: () => queue.shift() ?? 'zzfallback' } } });
    await create(h, { slug: 'taken1' });
    queue.push('taken1', 'fresh2');
    expect(await h.shorty.generateSlug()).toBe('fresh2');
  });

  it('does not generate an unavailable slug by default', async () => {
    const h = await harness();
    const slug = await h.shorty.generateSlug();
    expect(slug).toMatch(GENERATED);
    expect((await h.shorty.checkSlug(slug)).available).toBe(true);
  });
});

describe('slugs — normalization and grammar', () => {
  it('does not keep accents in a slug, or let case split one under the default', async () => {
    const h = await harness();
    const link = await create(h, { slug: 'Café' });
    expect(link.slug).toBe('Cafe');
    const doc = await h.shorty.models.Link.findById(link.id).lean();
    expect(doc?.slugKey).toBe('cafe');
    expect((await h.shorty.link('cafe'))?.id).toBe(link.id);
    expect((await h.shorty.link('CAFÉ'))?.id).toBe(link.id);
  });

  it('does not keep leading or trailing slashes', async () => {
    const h = await harness();
    expect((await create(h, { slug: '/spring/' })).slug).toBe('spring');
  });

  it('does not reject a multi-segment slug', async () => {
    const h = await harness();
    const link = await create(h, { slug: 'spring/ig' });
    expect(link.slug).toBe('spring/ig');
    expect(link.shortUrl).toBe('http://short.test/go/spring/ig');
  });

  it.each(['a//b', 'a.b', 'file.js', 'a b', 'a?b', 'a#b'])('does not accept slug %j', async (slug) => {
    const h = await harness();
    await rejects(create(h, { slug }), 'slug_invalid');
  });

  it('does not accept a slug over 190 characters (190 is fine)', async () => {
    const h = await harness();
    await expect(create(h, { slug: 'a'.repeat(190) })).resolves.toBeTruthy();
    await rejects(create(h, { slug: 'b'.repeat(191) }), 'slug_too_long');
  });
});

describe('slugs — reserved', () => {
  it('does not let a slug start with _ (builtin)', async () => {
    const h = await harness();
    await rejects(create(h, { slug: '_x' }), 'slug_reserved');
  });

  it('does not let config reserved replace the builtin list', async () => {
    const h = await harness({ config: { slug: { reserved: ['admin', /^api(\/|$)/] } } });
    await rejects(create(h, { slug: '_x' }), 'slug_reserved');
    await rejects(create(h, { slug: 'admin' }), 'slug_reserved');
    await rejects(create(h, { slug: 'Admin' }), 'slug_reserved');
    await rejects(create(h, { slug: 'api/v1' }), 'slug_reserved');
    await rejects(create(h, { slug: 'api' }), 'slug_reserved');
  });

  it('does not treat a reserved string as a prefix', async () => {
    const h = await harness({ config: { slug: { reserved: ['admin'] } } });
    await expect(create(h, { slug: 'administrator' })).resolves.toBeTruthy();
    await expect(create(h, { slug: 'apiary' })).resolves.toBeTruthy();
  });
});

describe('slugs — uniqueness', () => {
  it('does not let two links share a slug', async () => {
    const h = await harness();
    await create(h, { slug: 'spring' });
    await rejects(create(h, { slug: 'spring' }), 'slug_taken');
  });

  it('does not let a case variant through when case-insensitive (default)', async () => {
    const h = await harness();
    await create(h, { slug: 'spring' });
    await rejects(create(h, { slug: 'SPRING' }), 'slug_taken');
  });

  it('does not merge case variants when caseSensitive: true', async () => {
    const h = await harness({ config: { slug: { caseSensitive: true } } });
    const upper = await create(h, { slug: 'Spring' });
    const lower = await create(h, { slug: 'spring' });
    expect(upper.id).not.toBe(lower.id);
    expect((await h.shorty.link('Spring'))?.id).toBe(upper.id);
    expect((await h.shorty.link('spring'))?.id).toBe(lower.id);
    expect(await h.shorty.link('SPRING')).toBeNull();
  });

  it('does not let a rename take another link\'s slug', async () => {
    const h = await harness();
    await create(h, { slug: 'spring' });
    const other = await create(h, { slug: 'summer' });
    await rejects(h.shorty.updateLink(other.id, { slug: 'spring' }), 'slug_taken');
  });
});

describe('checkSlug', () => {
  it('does not report an unavailable slug without the reason', async () => {
    const h = await harness();
    await create(h, { slug: 'spring' });
    expect(await h.shorty.checkSlug('a b')).toMatchObject({ available: false, reason: 'invalid' });
    expect(await h.shorty.checkSlug('c'.repeat(191))).toMatchObject({ available: false, reason: 'too_long' });
    expect(await h.shorty.checkSlug('_x')).toMatchObject({ available: false, reason: 'reserved' });
    expect(await h.shorty.checkSlug('Spring')).toMatchObject({ available: false, reason: 'taken' });
  });

  it('does not report a free slug as unavailable, and returns its normalized form', async () => {
    const h = await harness();
    const check = await h.shorty.checkSlug('/Été-26/');
    expect(check.available).toBe(true);
    expect(check.reason).toBeUndefined();
    expect(check.slug).toBe('Ete-26');
  });

  it('does not report a link\'s own slug or alias as taken when linkId is given', async () => {
    const h = await harness();
    const link = await create(h, { slug: 'spring' });
    await h.shorty.updateLink(link.id, { slug: 'summer' });
    const other = await create(h, { slug: 'winter' });
    expect((await h.shorty.checkSlug('summer', { linkId: link.id })).available).toBe(true);
    expect((await h.shorty.checkSlug('spring', { linkId: link.id })).available).toBe(true);
    expect(await h.shorty.checkSlug('spring', { linkId: other.id })).toMatchObject({ available: false, reason: 'taken' });
    expect(await h.shorty.checkSlug('spring')).toMatchObject({ available: false, reason: 'taken' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('updateLink — destination', () => {
  it('does not replace the whole UTM set when one field is patched', async () => {
    const h = await harness();
    const link = await h.shorty.createLink({
      baseUrl: 'https://acme.com/', utm: { source: 'ig', medium: 'social', campaign: 'spring', term: 't' },
    });
    const next = await h.shorty.updateLink(link.id, { utm: { campaign: 'summer', medium: '', term: null } });
    expect(next.utm).toEqual({ source: 'ig', campaign: 'summer' });
    expect(next.destination).toBe('https://acme.com/?utm_source=ig&utm_campaign=summer');
    expectConsistent(next);
  });

  it('does not merge params (an update replaces the array)', async () => {
    const h = await harness();
    const link = await create(h, { url: 'https://acme.com/?a=1&b=2' });
    const next = await h.shorty.updateLink(link.id, { params: [{ key: 'c', value: '3' }] });
    expect(next.params).toEqual([{ key: 'c', value: '3' }]);
    expectConsistent(next);
  });

  it('does not keep old UTMs, params or hash when url replaces the destination', async () => {
    const h = await harness();
    const link = await create(h, { url: 'https://acme.com/old?utm_source=ig&utm_campaign=c&a=1#top' });
    const next = await h.shorty.updateLink(link.id, { url: 'https://other.com/new?b=2' });
    expect(next.baseUrl).toBe('https://other.com/new');
    expect(next.utm).toEqual({});
    expect(next.params).toEqual([{ key: 'b', value: '2' }]);
    expect(next.hash).toBeUndefined();
    expect(next.destination).toBe('https://other.com/new?b=2');
  });

  it('does not accept url together with a destination part', async () => {
    const h = await harness();
    const link = await create(h);
    await rejects(h.shorty.updateLink(link.id, { url: 'https://a.com/', baseUrl: 'https://b.com/' }), 'ambiguous_destination');
    await rejects(h.shorty.updateLink(link.id, { url: 'https://a.com/', utm: { source: 'x' } }), 'ambiguous_destination');
    await rejects(h.shorty.updateLink(link.id, { url: 'https://a.com/', params: [] }), 'ambiguous_destination');
    await rejects(h.shorty.updateLink(link.id, { url: 'https://a.com/', hash: 'x' }), 'ambiguous_destination');
  });

  it('does not keep optional fields that were patched to null', async () => {
    const h = await harness();
    const link = await create(h, {
      url: 'https://acme.com/#top',
      title: 'T', notes: 'N', expiresAt: '2027-01-01T00:00:00.000Z', maxClicks: 5,
      expiredUrl: 'https://acme.com/expired', social: { title: 'Card' },
      redirect: { status: 301, forwardQuery: false },
    });
    const next = await h.shorty.updateLink(link.id, {
      title: null, notes: null, expiresAt: null, maxClicks: null, expiredUrl: null, social: null, hash: null,
      redirect: { status: null },
    });
    expect(next.title).toBeUndefined();
    expect(next.notes).toBeUndefined();
    expect(next.expiresAt).toBeUndefined();
    expect(next.maxClicks).toBeUndefined();
    expect(next.expiredUrl).toBeUndefined();
    expect(next.social).toBeUndefined();
    expect(next.hash).toBeUndefined();
    expect(next.redirect.status).toBeUndefined();
    expect(next.redirect.forwardQuery).toBe(false);
    expect(next.destination).toBe('https://acme.com/');
  });

  it('does not write a revision when the composed destination is unchanged', async () => {
    const h = await harness();
    const link = await create(h, { url: 'https://acme.com/?utm_source=ig' });
    const same = await h.shorty.updateLink(link.id, { utm: { source: 'ig' }, title: 'renamed title', tags: ['x'] });
    expect(same.rev).toBe(1);
    expect(same.title).toBe('renamed title');
    expect(same.tags).toEqual(['x']);
    expect(await h.shorty.history(link.id)).toHaveLength(1);
  });

  it('does not forget to bump rev when the destination changes', async () => {
    const h = await harness();
    const link = await create(h, { url: 'https://acme.com/?utm_source=ig' });
    const a = await h.shorty.updateLink(link.id, { utm: { source: 'fb' } });
    expect(a.rev).toBe(2);
    const b = await h.shorty.updateLink(link.id, { hash: 'x' });
    expect(b.rev).toBe(3);
  });

  it('does not lose who updated the link', async () => {
    const h = await harness();
    const link = await create(h);
    const next = await h.shorty.updateLink(link.id, { title: 'x' }, { actor: BOB });
    expect(next.updatedBy).toEqual(BOB);
  });

  it('does not answer an unknown id with anything but not_found', async () => {
    const h = await harness();
    await rejects(h.shorty.updateLink(new Types.ObjectId().toHexString(), { title: 'x' }), 'not_found');
  });
});

describe('history', () => {
  it('does not omit or reorder created, destination and slug entries', async () => {
    const h = await harness();
    const link = await h.shorty.createLink({ url: 'https://acme.com/?utm_source=ig', slug: 'spring' }, { actor: ANN });
    h.clock.advance(MINUTE);
    await h.shorty.updateLink(link.id, { utm: { source: 'fb' } }, { actor: BOB });
    h.clock.advance(MINUTE);
    await h.shorty.updateLink(link.id, { slug: 'summer' }, { actor: ANN });

    const entries = await h.shorty.history(link.id);
    expect(entries.map((e) => e.kind)).toEqual(['created', 'destination', 'slug']);
    expect(entries[0]).toMatchObject({
      kind: 'created', rev: 1, slug: 'spring', destination: 'https://acme.com/?utm_source=ig', by: ANN,
    });
    expect(entries[1]).toMatchObject({
      kind: 'destination', rev: 2,
      destination: 'https://acme.com/?utm_source=fb', previous: 'https://acme.com/?utm_source=ig', by: BOB,
    });
    expect(entries[2]).toMatchObject({ kind: 'slug', from: 'spring', to: 'summer', mode: 'alias', by: ANN });
    expect(entries[1].at.getTime() - entries[0].at.getTime()).toBe(MINUTE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("rename: 'alias' (default)", () => {
  it('does not stop an old slug resolving after a rename', async () => {
    const h = await harness();
    const link = await create(h, { slug: 'spring' });
    const renamed = await h.shorty.updateLink(link.id, { slug: 'summer' });
    expect(renamed.slug).toBe('summer');
    expect(renamed.aliases).toEqual(['spring']);
    expect(renamed.shortUrl).toBe('http://short.test/go/summer');
    const viaOld = await h.shorty.link('spring');
    expect(viaOld?.id).toBe(link.id);
    expect(viaOld?.slug).toBe('summer');
  });

  it('does not let a renamed-away slug be claimed by another link', async () => {
    const h = await harness();
    const link = await create(h, { slug: 'spring' });
    await h.shorty.updateLink(link.id, { slug: 'summer' });
    await rejects(create(h, { slug: 'spring' }), 'slug_taken');
    await rejects(create(h, { slug: 'SPRING' }), 'slug_taken');
  });

  it('does not refuse renaming back to one of the link\'s own aliases', async () => {
    const h = await harness();
    const link = await create(h, { slug: 'spring' });
    await h.shorty.updateLink(link.id, { slug: 'summer' });
    const back = await h.shorty.updateLink(link.id, { slug: 'spring' });
    expect(back.slug).toBe('spring');
    expect(back.aliases).toContain('summer');
    expect(back.aliases).not.toContain('spring');
    expect((await h.shorty.link('summer'))?.id).toBe(link.id);
  });

  it('does not keep aliases out of oldest-first order', async () => {
    const h = await harness();
    const link = await create(h, { slug: 's1' });
    await h.shorty.updateLink(link.id, { slug: 's2' });
    h.clock.advance(MINUTE);
    const last = await h.shorty.updateLink(link.id, { slug: 's3' });
    expect(last.aliases).toEqual(['s1', 's2']);
  });
});

describe("rename: 'untilClicked'", () => {
  const config = { slug: { rename: 'untilClicked' as const } };

  it('does not lock a slug that has never been clicked', async () => {
    const h = await harness({ config });
    const link = await create(h, { slug: 'spring' });
    expect((await h.shorty.updateLink(link.id, { slug: 'summer' })).slug).toBe('summer');
  });

  it('does not allow a rename after the first human click', async () => {
    const h = await harness({ config });
    const link = await create(h, { slug: 'spring' });
    await humanClick(h, 'spring');
    await rejects(h.shorty.updateLink(link.id, { slug: 'summer' }), 'slug_locked');
    expect((await h.shorty.link(link.id))?.slug).toBe('spring');
  });

  it('does not let a bot click lock the slug', async () => {
    const h = await harness({ config });
    const link = await create(h, { slug: 'spring' });
    await humanClick(h, 'spring', BOT_UA);
    expect((await h.shorty.link(link.id))?.botClicks).toBe(1);
    expect((await h.shorty.updateLink(link.id, { slug: 'summer' })).slug).toBe('summer');
  });

  it('does not lock destination edits after a click (only the slug locks)', async () => {
    const h = await harness({ config });
    const link = await create(h, { slug: 'spring' });
    await humanClick(h, 'spring');
    const next = await h.shorty.updateLink(link.id, { utm: { source: 'ig' } });
    expect(next.rev).toBe(2);
  });
});

describe("rename: 'always'", () => {
  const config = { slug: { rename: 'always' as const } };

  it('does not keep the old slug pointing at the link', async () => {
    const h = await harness({ config });
    const link = await create(h, { slug: 'spring' });
    const renamed = await h.shorty.updateLink(link.id, { slug: 'summer' });
    expect(renamed.aliases).toEqual([]);
    expect(await h.shorty.link('spring')).toBeNull();
  });

  it('does not keep the old slug from being claimed by another link', async () => {
    const h = await harness({ config });
    const link = await create(h, { slug: 'spring' });
    await h.shorty.updateLink(link.id, { slug: 'summer' });
    const other = await create(h, { slug: 'spring' });
    expect((await h.shorty.link('spring'))?.id).toBe(other.id);
    expect((await h.shorty.link('summer'))?.id).toBe(link.id);
  });
});

describe("rename: 'never'", () => {
  const config = { slug: { rename: 'never' as const } };

  it('does not allow any rename', async () => {
    const h = await harness({ config });
    const link = await create(h, { slug: 'spring' });
    await rejects(h.shorty.updateLink(link.id, { slug: 'summer' }), 'slug_locked');
    expect(await h.shorty.link('summer')).toBeNull();
  });

  it('does not treat re-sending the current slug as a rename', async () => {
    const h = await harness({ config });
    const link = await create(h, { slug: 'spring' });
    const next = await h.shorty.updateLink(link.id, { slug: 'spring', title: 'still fine' });
    expect(next.title).toBe('still fine');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('case mode flips (ready)', () => {
  function sibling(h: Harness, caseSensitive: boolean): ShortyInstance {
    const cfg: CreateShortyConfig = { ...h.config, ...h.prefixes, slug: { ...h.config.slug, caseSensitive } };
    return createShorty(cfg);
  }

  it('does not leave slugs keyed lowercase after switching to case-sensitive', async () => {
    const h = await harness();
    const spring = await create(h, { slug: 'Spring' });
    const summer = await create(h, { slug: 'summer' });

    const s2 = sibling(h, true);
    await s2.ready();
    expect((await s2.link('Spring'))?.id).toBe(spring.id);
    expect(await s2.link('spring')).toBeNull();
    expect((await s2.link('summer'))?.id).toBe(summer.id);
    const doc = await s2.models.Link.findById(spring.id).lean();
    expect(doc?.slugKey).toBe('Spring');
    // The lowercase key is free under the new mode.
    await expect(s2.createLink({ url: 'https://acme.com/', slug: 'spring' })).resolves.toBeTruthy();
  });

  it('does not silently merge two links when switching to case-insensitive', async () => {
    const h = await harness({ config: { slug: { caseSensitive: true } } });
    await create(h, { slug: 'Ab' });
    await create(h, { slug: 'ab' });

    const s2 = sibling(h, false);
    const err = await rejects(s2.ready(), 'case_collision');
    const said = `${err.message} ${JSON.stringify(err.details ?? {})}`;
    expect(said).toContain('Ab');
    expect(said).toContain('ab');
  });

  it('does not fail or re-key twice when ready() is called again', async () => {
    const h = await harness();
    const link = await create(h, { slug: 'Spring' });
    await expect(h.shorty.ready()).resolves.toBeUndefined();

    const s2 = sibling(h, true);
    await s2.ready();
    await expect(s2.ready()).resolves.toBeUndefined();
    expect((await s2.link('Spring'))?.id).toBe(link.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('archive', () => {
  it('does not stop an archived link resolving', async () => {
    const h = await harness();
    const link = await create(h, { slug: 'spring' });
    const archived = await h.shorty.archiveLink(link.id);
    expect(archived.archived).toBe(true);
    expect((await h.shorty.link('spring'))?.archived).toBe(true);
  });

  it('does not list archived links by default, nor live ones under archived: true', async () => {
    const h = await harness();
    const live = await create(h);
    const gone = await create(h);
    await h.shorty.archiveLink(gone.id);
    const ids = async (archived?: boolean | 'all') =>
      (await h.shorty.links(archived === undefined ? {} : { archived })).items.map((l) => l.id).sort();
    expect(await ids()).toEqual([live.id]);
    expect(await ids(false)).toEqual([live.id]);
    expect(await ids(true)).toEqual([gone.id]);
    expect(await ids('all')).toEqual([live.id, gone.id].sort());
  });

  it('does not keep a link hidden after unarchive', async () => {
    const h = await harness();
    const link = await create(h);
    await h.shorty.archiveLink(link.id);
    const back = await h.shorty.unarchiveLink(link.id);
    expect(back.archived).toBe(false);
    expect((await h.shorty.links()).items.map((l) => l.id)).toEqual([link.id]);
  });
});

describe('deleteLink', () => {
  it('does not leave keys, history, clicks or rollups behind — and reports what it removed', async () => {
    const h = await harness();
    const link = await create(h, { slug: 'spring' });
    await h.shorty.updateLink(link.id, { slug: 'summer' });
    const keep = await create(h, { slug: 'keeper' });
    const linkId = new Types.ObjectId(link.id);
    const keepId = new Types.ObjectId(keep.id);
    const { Click, Daily, History, Slug } = h.shorty.models;

    const click = (id: Types.ObjectId) => ({
      linkId: id, rev: 1, at: h.clock.now, visitor: 'v', unique: true, bot: false, qr: false, device: 'desktop' as const,
    });
    await Click.insertMany([click(linkId), click(linkId), click(linkId), click(keepId)]);
    await Daily.insertMany([
      { linkId, day: '2026-03-14', clicks: 1, uniques: 1, qr: 0, bots: 0, botUniques: 0 },
      { linkId, day: '2026-03-15', clicks: 2, uniques: 1, qr: 0, bots: 0, botUniques: 0 },
      { linkId: keepId, day: '2026-03-15', clicks: 1, uniques: 1, qr: 0, bots: 0, botUniques: 0 },
    ]);
    const historyBefore = (await h.shorty.history(link.id)).length;

    const summary = await h.shorty.deleteLink(link.id);
    expect(summary).toEqual({ clicks: 3, history: historyBefore, keys: 2 });

    expect(await h.shorty.link(link.id)).toBeNull();
    expect(await h.shorty.link('spring')).toBeNull();
    expect(await h.shorty.link('summer')).toBeNull();
    expect(await Click.countDocuments({ linkId })).toBe(0);
    expect(await Daily.countDocuments({ linkId })).toBe(0);
    expect(await History.countDocuments({ linkId })).toBe(0);
    expect(await Slug.countDocuments({ linkId })).toBe(0);

    // Another link's rows are untouched.
    expect(await Click.countDocuments({ linkId: keepId })).toBe(1);
    expect(await Daily.countDocuments({ linkId: keepId })).toBe(1);
    expect((await h.shorty.link('keeper'))?.id).toBe(keep.id);

    // Every freed key is claimable.
    await expect(create(h, { slug: 'spring' })).resolves.toBeTruthy();
    await expect(create(h, { slug: 'summer' })).resolves.toBeTruthy();
  });

  it('does not answer an unknown id with anything but not_found', async () => {
    const h = await harness();
    await rejects(h.shorty.deleteLink(new Types.ObjectId().toHexString()), 'not_found');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('link()', () => {
  it('does not fail to find a link by id, slug or alias', async () => {
    const h = await harness();
    const link = await create(h, { slug: 'spring' });
    await h.shorty.updateLink(link.id, { slug: 'summer' });
    expect((await h.shorty.link(link.id))?.slug).toBe('summer');
    expect((await h.shorty.link('summer'))?.id).toBe(link.id);
    expect((await h.shorty.link('spring'))?.id).toBe(link.id);
  });

  it('does not throw for unknown or malformed input — it returns null', async () => {
    const h = await harness();
    await create(h, { slug: 'spring' });
    expect(await h.shorty.link('nope')).toBeNull();
    expect(await h.shorty.link(new Types.ObjectId().toHexString())).toBeNull();
    expect(await h.shorty.link('not-an-object-id')).toBeNull();
    expect(await h.shorty.link('a b/../c')).toBeNull();
    expect(await h.shorty.link('')).toBeNull();
  });

  it('does not expose storage internals on a Link', async () => {
    const h = await harness();
    const link = await create(h, { slug: 'spring' });
    const got = (await h.shorty.link('spring')) as unknown as Record<string, unknown>;
    for (const key of ['_id', 'slugKey', 'keys', '__v']) expect(got[key], key).toBeUndefined();
    expect(got.id).toBe(link.id);
  });
});

describe('links()', () => {
  async function seed(h: Harness, count: number, input: (i: number) => Partial<LinkInput> = () => ({})): Promise<Link[]> {
    const out: Link[] = [];
    for (let i = 0; i < count; i += 1) {
      out.push(await create(h, { url: `https://example.com/p${i}`, ...input(i) }));
      h.clock.advance(MINUTE);
    }
    return out;
  }

  it('does not list oldest first by default', async () => {
    const h = await harness();
    const made = await seed(h, 3);
    expect((await h.shorty.links()).items.map((l) => l.id)).toEqual(made.map((l) => l.id).reverse());
  });

  it('does not ignore sort: clicks', async () => {
    const h = await harness();
    const made = await seed(h, 3);
    const counts = [5, 50, 1];
    await Promise.all(made.map((l, i) => h.shorty.models.Link.updateOne({ _id: l.id }, { $set: { clicks: counts[i] } })));
    expect((await h.shorty.links({ sort: 'clicks' })).items.map((l) => l.clicks)).toEqual([50, 5, 1]);
  });

  it('does not ignore the tag filter', async () => {
    const h = await harness();
    const made = await seed(h, 3, (i) => ({ tags: i === 1 ? ['spring', 'ig'] : ['fall'] }));
    expect((await h.shorty.links({ tag: 'spring' })).items.map((l) => l.id)).toEqual([made[1].id]);
  });

  it('does not miss text matches in title, notes or campaign', async () => {
    const h = await harness();
    const [a, b, c] = await seed(h, 4, (i) => [
      { title: 'Gazpacho launch' },
      { notes: 'for the tortilla newsletter' },
      { url: 'https://example.com/c?utm_campaign=paella' },
      { title: 'unrelated' },
    ][i]);
    const q = async (text: string) => (await h.shorty.links({ q: text })).items.map((l) => l.id);
    expect(await q('gazpacho')).toEqual([a.id]);
    expect(await q('tortilla')).toEqual([b.id]);
    expect(await q('paella')).toEqual([c.id]);
  });

  it.each(['newest', 'clicks'] as const)('does not duplicate or skip rows across cursor pages (sort %s, with ties)', async (sort) => {
    const h = await harness();
    const made = await seed(h, 7);
    const counts = [5, 5, 5, 2, 2, 0, 0];
    await Promise.all(made.map((l, i) => h.shorty.models.Link.updateOne({ _id: l.id }, { $set: { clicks: counts[i] } })));

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await h.shorty.links({ sort, limit: 3, ...(cursor ? { cursor } : {}) });
      expect(page.items.length).toBeLessThanOrEqual(3);
      seen.push(...page.items.map((l) => l.id));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual(made.map((l) => l.id).sort());
  });

  it('does not return more than listLimit rows, and reports the cap', async () => {
    const h = await harness({ config: { listLimit: 5 } });
    await seed(h, 7);
    const page = await h.shorty.links({ limit: 100 });
    expect(page.limit).toBe(5);
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).not.toBeNull();
  });

  it('does not exceed the default cap of 200', async () => {
    const h = await harness();
    expect((await h.shorty.links({ limit: 10_000 })).limit).toBe(200);
  });
});

describe('tags()', () => {
  it('does not miscount tags', async () => {
    const h = await harness();
    await create(h, { tags: ['spring', 'ig'] });
    await create(h, { tags: ['spring'] });
    await create(h, { tags: [] });
    const tags = (await h.shorty.tags()).sort((a, b) => a.tag.localeCompare(b.tag));
    expect(tags).toEqual([{ tag: 'ig', count: 1 }, { tag: 'spring', count: 2 }]);
  });
});

describe('recount()', () => {
  it('does not leave drifted counters — it rebuilds them from daily rollups', async () => {
    const h = await harness();
    const link = await create(h);
    const linkId = new Types.ObjectId(link.id);
    await h.shorty.models.Daily.insertMany([
      { linkId, day: '2026-03-14', clicks: 3, uniques: 2, qr: 1, bots: 4, botUniques: 1 },
      { linkId, day: '2026-03-15', clicks: 2, uniques: 1, qr: 0, bots: 1, botUniques: 1 },
    ]);
    await h.shorty.models.Link.updateOne({ _id: linkId }, { $set: { clicks: 99, uniqueClicks: 99, botClicks: 99 } });

    const fixed = await h.shorty.recount(link.id);
    expect(fixed).toMatchObject({ clicks: 5, uniqueClicks: 3, botClicks: 5 });
    expect(await h.shorty.link(link.id)).toMatchObject({ clicks: 5, uniqueClicks: 3, botClicks: 5 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('lifecycle hooks and track', () => {
  type Cfg = CreateShortyConfig;

  it('does not skip a hook or call one twice, and passes what the contract says', async () => {
    const onCreate = vi.fn<NonNullable<Cfg['onCreate']>>();
    const onUpdate = vi.fn<NonNullable<Cfg['onUpdate']>>();
    const onArchive = vi.fn<NonNullable<Cfg['onArchive']>>();
    const onDelete = vi.fn<NonNullable<Cfg['onDelete']>>();
    const h = await harness({ config: { onCreate, onUpdate, onArchive, onDelete } });

    const link = await h.shorty.createLink({ url: 'https://acme.com/?utm_campaign=a', slug: 'spring' }, { actor: ANN });
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0][0].link.id).toBe(link.id);
    expect(onCreate.mock.calls[0][0].actor).toEqual(ANN);

    await h.shorty.updateLink(link.id, { utm: { campaign: 'b' } }, { actor: BOB });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    const upd = onUpdate.mock.calls[0][0];
    expect(upd.prev.utm.campaign).toBe('a');
    expect(upd.link.utm.campaign).toBe('b');
    expect(upd.actor).toEqual(BOB);
    expect(upd.history).toHaveLength(1);
    expect(upd.history[0]).toMatchObject({ kind: 'destination', rev: 2, previous: 'https://acme.com/?utm_campaign=a' });

    await h.shorty.updateLink(link.id, { title: 'meta only' });
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate.mock.calls[1][0].history).toEqual([]);

    await h.shorty.archiveLink(link.id);
    await h.shorty.unarchiveLink(link.id);
    expect(onArchive.mock.calls.map(([e]) => e.archived)).toEqual([true, false]);
    expect(onArchive.mock.calls[0][0].link.archived).toBe(true);

    const summary = await h.shorty.deleteLink(link.id);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete.mock.calls[0][0].link.id).toBe(link.id);
    expect(onDelete.mock.calls[0][0].summary).toEqual(summary);

    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('does not let a throwing hook fail the write — it is counted in health()', async () => {
    const h = await harness({
      config: {
        onCreate: () => { throw new Error('boom'); },
        onUpdate: async () => { throw new Error('async boom'); },
      },
    });
    const link = await create(h, { slug: 'spring' });
    expect((await h.shorty.link('spring'))?.id).toBe(link.id);
    const next = await h.shorty.updateLink(link.id, { title: 'saved anyway' });
    expect(next.title).toBe('saved anyway');
    expect((await h.shorty.link(link.id))?.title).toBe('saved anyway');
    expect(h.shorty.health().hookFailures).toBe(2);
  });

  it('does not emit lifecycle track events without the link subject', async () => {
    const track = vi.fn<NonNullable<Cfg['track']>>();
    const h = await harness({ config: { track } });
    const link = await create(h);
    await h.shorty.updateLink(link.id, { title: 'x' });
    await h.shorty.archiveLink(link.id);
    await h.shorty.unarchiveLink(link.id);
    await h.shorty.deleteLink(link.id);

    const names = track.mock.calls.map(([name]) => name);
    expect(names).toEqual([
      'shorty.link_created',
      'shorty.link_updated',
      'shorty.link_archived',
      'shorty.link_unarchived',
      'shorty.link_deleted',
    ]);
    for (const [, opts] of track.mock.calls) {
      expect(opts?.subjects).toEqual([expect.objectContaining({ type: 'shorty_link', id: link.id })]);
    }
  });

  it('does not let a throwing track fail the write', async () => {
    const h = await harness({ config: { track: () => { throw new Error('telemetry down'); } } });
    await expect(create(h, { slug: 'spring' })).resolves.toBeTruthy();
    expect((await h.shorty.link('spring'))).not.toBeNull();
  });
});
