import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import type { Request } from 'express';
import {
  composeUrl, createShorty, defaultResolveUser, ERROR_STATUS, ShortyError,
} from '../src/server/index.js';
import type {
  Actor,
  CreateShortyConfig,
  Link,
  LinkInput,
  ShortyErrorCode,
  ShortyInstance,
} from '../types/index.js';
import { BOT_UA, HOUR, HUMAN_UA, MINUTE, harness, startDb, stopDb } from './helpers.js';
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
    expect(h.shorty.health().hookFailures).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Audit follow-ups
// ─────────────────────────────────────────────────────────────────────────────

function siblingOf(h: Harness, caseSensitive: boolean): ShortyInstance {
  return createShorty({ ...h.config, ...h.prefixes, slug: { ...h.config.slug, caseSensitive } });
}

async function settle<T>(ps: Array<Promise<T>>): Promise<{ ok: T[]; codes: string[] }> {
  const results = await Promise.allSettled(ps);
  const ok: T[] = [];
  const codes: string[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') ok.push(r.value);
    else codes.push(r.reason instanceof ShortyError ? r.reason.code : `non-ShortyError: ${String(r.reason)}`);
  }
  return { ok, codes };
}

describe('slugs — generator config', () => {
  it('does not emit 0, 1, i, l or o from the default alphabet', async () => {
    const h = await harness();
    const chars = new Set<string>();
    for (let i = 0; i < 300; i += 1) {
      const slug = await h.shorty.generateSlug();
      expect(slug).toHaveLength(7);
      for (const c of slug) chars.add(c);
    }
    for (const banned of ['0', '1', 'i', 'l', 'o']) expect(chars.has(banned), banned).toBe(false);
    for (const c of chars) expect('23456789abcdefghjkmnpqrstuvwxyz').toContain(c);
  });

  it('does not ignore a configured length and alphabet', async () => {
    const h = await harness({ config: { slug: { length: 12, alphabet: 'ab' } } });
    expect((await create(h)).slug).toMatch(/^[ab]{12}$/);
    expect(await h.shorty.generateSlug()).toMatch(/^[ab]{12}$/);
  });

  it('does not accept invalid or reserved generator output — it retries', async () => {
    const queue = ['a b', '_x', 'good1'];
    const h = await harness({ config: { slug: { generate: () => queue.shift() ?? 'zzfallback' } } });
    const link = await create(h);
    expect(link.slug).toBe('good1');
  });

  it.each(['a b', '_x', 'x'.repeat(191)])('does not loop forever when the generator always returns %j', async (bad) => {
    const h = await harness({ config: { slug: { generate: () => bad } } });
    await rejects(create(h), 'slug_generation_exhausted');
  });
});

describe('slugs — grammar edges', () => {
  it.each(['', '/'])('does not treat custom slug %j as "generate one"', async (slug) => {
    const h = await harness();
    await rejects(create(h, { slug }), 'slug_invalid');
    expect((await h.shorty.links({ archived: 'all' })).items).toHaveLength(0);
  });

  it('does not report the empty slug as anything but invalid', async () => {
    const h = await harness();
    expect(await h.shorty.checkSlug('')).toMatchObject({ available: false, reason: 'invalid' });
  });

  it('does not reject underscores mid-slug, digits, or slashes it can trim', async () => {
    const h = await harness();
    expect((await create(h, { slug: 'a_b' })).slug).toBe('a_b');
    expect((await create(h, { slug: '2026' })).slug).toBe('2026');
    expect((await create(h, { slug: '//a//' })).slug).toBe('a');
  });
});

describe('slugs — races and released claims', () => {
  it('does not let two concurrent creates claim one slug', async () => {
    const h = await harness();
    const { ok, codes } = await settle(Array.from({ length: 10 }, () => create(h, { slug: 'race' })));
    expect(ok).toHaveLength(1);
    expect(codes).toEqual(Array(9).fill('slug_taken'));
    expect(await h.shorty.models.Link.countDocuments({})).toBe(1);
    expect((await h.shorty.link('race'))?.id).toBe(ok[0].id);
  });

  it('does not let two concurrent renames claim one slug', async () => {
    const h = await harness();
    const a = await create(h, { slug: 'a1' });
    const b = await create(h, { slug: 'b1' });
    const { ok, codes } = await settle([
      h.shorty.updateLink(a.id, { slug: 'prize' }),
      h.shorty.updateLink(b.id, { slug: 'prize' }),
    ]);
    expect(ok).toHaveLength(1);
    expect(codes).toEqual(['slug_taken']);
    const winner = ok[0];
    const loser = winner.id === a.id ? b : a;
    expect((await h.shorty.link('prize'))?.id).toBe(winner.id);
    expect((await h.shorty.link(loser.id))?.slug).toBe(loser.slug);
  });

  it('does not keep a slug claimed by a create that failed', async () => {
    const h = await harness({ config: { destinations: { blockedHosts: ['evil.com'] } } });
    await rejects(create(h, { slug: 'x', url: 'https://evil.com/' }), 'host_blocked');
    expect((await h.shorty.checkSlug('x')).available).toBe(true);
    await expect(create(h, { slug: 'x' })).resolves.toBeTruthy();
  });

  it('does not half-apply a patch that fails (rename + blocked host)', async () => {
    const h = await harness({ config: { destinations: { blockedHosts: ['evil.com'] } } });
    const link = await create(h, { slug: 'spring' });
    await rejects(h.shorty.updateLink(link.id, { slug: 'summer', baseUrl: 'https://evil.com/' }), 'host_blocked');
    const after = await h.shorty.link(link.id);
    expect(after?.slug).toBe('spring');
    expect(after?.destination).toBe(link.destination);
    expect(after?.aliases).toEqual([]);
    expect(await h.shorty.link('summer')).toBeNull();
    expect(await h.shorty.history(link.id)).toHaveLength(1);
    await expect(create(h, { slug: 'summer' })).resolves.toBeTruthy();
  });
});

describe('createLink — validation edges', () => {
  it.each([
    'http://short.test/go',
    'http://short.test/go/',
    'http://short.test/go?x=1',
    'http://short.test/go/a/b',
  ])('does not let a link loop to %s', async (url) => {
    const h = await harness();
    await rejects(h.shorty.createLink({ url }), 'destination_loop');
  });

  it('does not let an update create a loop', async () => {
    const h = await harness();
    const link = await create(h);
    await rejects(h.shorty.updateLink(link.id, { url: 'http://short.test/go/x' }), 'destination_loop');
    await rejects(h.shorty.updateLink(link.id, { baseUrl: 'http://short.test/go' }), 'destination_loop');
  });

  it('does not mistake a sibling path on the same host for a loop', async () => {
    const h = await harness();
    await expect(h.shorty.createLink({ url: 'http://short.test/gone' })).resolves.toBeTruthy();
    await expect(h.shorty.createLink({ url: 'http://short.test/' })).resolves.toBeTruthy();
  });

  it('does not accept a social card over the character limits (120 / 240)', async () => {
    const h = await harness();
    await rejects(create(h, { social: { title: 't'.repeat(121) } }), 'validation');
    await rejects(create(h, { social: { description: 'd'.repeat(241) } }), 'validation');
    await expect(create(h, { social: { title: 't'.repeat(120), description: 'd'.repeat(240) } })).resolves.toBeTruthy();
  });
});

describe('og', () => {
  it('does not store og without fetchedAt from config.now, or keep it after og: null', async () => {
    const h = await harness();
    const link = await create(h, { og: { title: 'Sale', image: 'https://acme.com/card.png', favicon: 'https://acme.com/f.ico' } });
    expect(link.og).toEqual({
      title: 'Sale', image: 'https://acme.com/card.png', favicon: 'https://acme.com/f.ico', fetchedAt: h.clock.now,
    });

    h.clock.advance(HOUR);
    const refreshed = await h.shorty.updateLink(link.id, { og: { title: 'Sale 2' } });
    expect(refreshed.og).toEqual({ title: 'Sale 2', fetchedAt: h.clock.now });
    expect(refreshed.rev).toBe(1);

    const cleared = await h.shorty.updateLink(link.id, { og: null });
    expect(cleared.og).toBeUndefined();
  });
});

describe('updateLink — edges', () => {
  it('does not drop utm, params or hash when only baseUrl is patched', async () => {
    const h = await harness();
    const link = await create(h, { url: 'https://acme.com/a?utm_source=ig&x=1#h' });
    const next = await h.shorty.updateLink(link.id, { baseUrl: 'https://acme.com/b' });
    expect(next.utm).toEqual({ source: 'ig' });
    expect(next.params).toEqual([{ key: 'x', value: '1' }]);
    expect(next.hash).toBe('h');
    expect(next.destination).toBe('https://acme.com/b?utm_source=ig&x=1#h');
  });

  it('does not stamp updatedAt from the wall clock, or move createdAt', async () => {
    const h = await harness();
    const link = await create(h);
    h.clock.advance(HOUR);
    const next = await h.shorty.updateLink(link.id, { title: 'later' });
    expect(next.updatedAt.toISOString()).toBe(h.clock.now.toISOString());
    expect(next.createdAt.toISOString()).toBe(link.createdAt.toISOString());
  });

  it.each([
    ['a b', 'slug_invalid'],
    ['_x', 'slug_reserved'],
    ['r'.repeat(191), 'slug_too_long'],
  ] as const)('does not apply a rename to %j (%s) or record it', async (slug, code) => {
    const h = await harness();
    const link = await create(h, { slug: 'spring' });
    await rejects(h.shorty.updateLink(link.id, { slug }), code);
    const after = await h.shorty.link(link.id);
    expect(after?.slug).toBe('spring');
    expect(after?.aliases).toEqual([]);
    expect(await h.shorty.history(link.id)).toHaveLength(1);
  });

  it.each(['archiveLink', 'unarchiveLink', 'history', 'recount'] as const)(
    'does not answer %s on an unknown id with anything but not_found',
    async (method) => {
      const h = await harness();
      await rejects(h.shorty[method](new Types.ObjectId().toHexString()), 'not_found');
    },
  );
});

describe('same-key slug in a patch is not a rename', () => {
  it('does not lock under untilClicked after a click when the same key is re-sent', async () => {
    const h = await harness({ config: { slug: { rename: 'untilClicked' } } });
    const link = await create(h, { slug: 'Spring' });
    await humanClick(h, 'Spring');
    expect((await h.shorty.link(link.id))?.clicks).toBe(1);
    const next = await h.shorty.updateLink(link.id, { slug: 'spring', title: 'ok' });
    expect(next.title).toBe('ok');
    expect(await h.shorty.history(link.id)).toHaveLength(1);
  });

  it('does not add an alias or a history entry in alias mode', async () => {
    const h = await harness();
    const link = await create(h, { slug: 'Spring' });
    const next = await h.shorty.updateLink(link.id, { slug: 'SPRING' });
    expect(next.aliases).toEqual([]);
    expect(await h.shorty.history(link.id)).toHaveLength(1);
  });
});

describe('history — rename mode and combined patches', () => {
  it.each(['always', 'untilClicked'] as const)('does not record the wrong mode on a slug entry (%s)', async (rename) => {
    const h = await harness({ config: { slug: { rename } } });
    const link = await create(h, { slug: 'spring' });
    await h.shorty.updateLink(link.id, { slug: 'summer' });
    const last = (await h.shorty.history(link.id)).at(-1);
    expect(last).toMatchObject({ kind: 'slug', from: 'spring', to: 'summer', mode: rename });
  });

  it('does not collapse a destination + slug patch into one entry', async () => {
    const onUpdate = vi.fn<NonNullable<CreateShortyConfig['onUpdate']>>();
    const h = await harness({ config: { onUpdate } });
    const link = await create(h, { slug: 'spring', url: 'https://acme.com/?utm_source=ig' });
    await h.shorty.updateLink(link.id, { slug: 'summer', utm: { source: 'fb' } });
    const entries = await h.shorty.history(link.id);
    expect(entries.map((e) => e.kind).sort()).toEqual(['created', 'destination', 'slug']);
    expect(onUpdate.mock.calls[0][0].history.map((e) => e.kind).sort()).toEqual(['destination', 'slug']);
  });
});

describe('case mode flips — edges', () => {
  it('does not leave aliases on the old keys after a flip', async () => {
    const h = await harness();
    const link = await create(h, { slug: 'Spring' });
    await h.shorty.updateLink(link.id, { slug: 'Summer' });
    const s2 = siblingOf(h, true);
    await s2.ready();
    expect((await s2.link('Spring'))?.id).toBe(link.id);
    expect((await s2.link('Summer'))?.id).toBe(link.id);
    expect(await s2.link('spring')).toBeNull();
  });

  it('does not keep mixed-case keys after switching to case-insensitive', async () => {
    const h = await harness({ config: { slug: { caseSensitive: true } } });
    const link = await create(h, { slug: 'Spring' });
    const s2 = siblingOf(h, false);
    await s2.ready();
    expect((await s2.link('spring'))?.id).toBe(link.id);
    expect((await s2.link('SPRING'))?.id).toBe(link.id);
    expect((await s2.models.Link.findById(link.id).lean())?.slugKey).toBe('spring');
  });

  it('does not miss a collision between one link\'s slug and another\'s alias — and changes nothing', async () => {
    const h = await harness({ config: { slug: { caseSensitive: true } } });
    const first = await create(h, { slug: 'Ab' });
    await h.shorty.updateLink(first.id, { slug: 'Cd' });   // 'Ab' is now an alias
    await create(h, { slug: 'ab' });

    const { Link: LinkModel, Meta, Slug } = h.shorty.models;
    const snapshot = async () => ({
      links: (await LinkModel.find({}, { slugKey: 1, keys: 1 }).sort({ _id: 1 }).lean())
        .map((d) => ({ id: String(d._id), slugKey: d.slugKey, keys: [...d.keys].sort() })),
      slugs: (await Slug.find({}).sort({ _id: 1 }).lean()).map((d) => ({ id: d._id, linkId: String(d.linkId), current: d.current })),
      meta: await Meta.find({}).lean(),
    });
    const before = await snapshot();

    const s2 = siblingOf(h, false);
    const err = await rejects(s2.ready(), 'case_collision');
    const said = `${err.message} ${JSON.stringify(err.details ?? {})}`;
    expect(said).toContain('Ab');
    expect(said).toContain('ab');

    expect(await snapshot()).toEqual(before);
    // The original instance still resolves everything.
    expect((await h.shorty.link('Ab'))?.id).toBe(first.id);
  });
});

describe('links() — more sorts, search and paging', () => {
  async function seed(h: Harness, count: number, input: (i: number) => Partial<LinkInput> = () => ({})): Promise<Link[]> {
    const out: Link[] = [];
    for (let i = 0; i < count; i += 1) {
      out.push(await create(h, { url: `https://example.com/p${i}`, ...input(i) }));
      h.clock.advance(MINUTE);
    }
    return out;
  }

  async function allPages(h: Harness, query: Parameters<ShortyInstance['links']>[0]): Promise<{ ids: string[]; pages: number }> {
    const ids: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await h.shorty.links({ ...query, ...(cursor ? { cursor } : {}) });
      ids.push(...page.items.map((l) => l.id));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor && pages < 20);
    return { ids, pages };
  }

  it('does not put never-clicked links ahead of clicked ones under sort: lastClicked', async () => {
    const h = await harness();
    const [never, old, mid, recent] = await seed(h, 4);
    const at = (iso: string) => new Date(iso);
    await h.shorty.models.Link.updateOne({ _id: old.id }, { $set: { lastClickedAt: at('2026-03-01T00:00:00Z') } });
    await h.shorty.models.Link.updateOne({ _id: mid.id }, { $set: { lastClickedAt: at('2026-03-05T00:00:00Z') } });
    await h.shorty.models.Link.updateOne({ _id: recent.id }, { $set: { lastClickedAt: at('2026-03-10T00:00:00Z') } });
    const expected = [recent.id, mid.id, old.id, never.id];
    expect((await h.shorty.links({ sort: 'lastClicked' })).items.map((l) => l.id)).toEqual(expected);
    const { ids } = await allPages(h, { sort: 'lastClicked', limit: 1 });
    expect(ids).toEqual(expected);
  });

  it('does not leave slug or baseUrl out of text search', async () => {
    const h = await harness();
    const bySlug = await create(h, { slug: 'zucchini-promo', url: 'https://example.com/a' });
    const byBase = await create(h, { url: 'https://example.com/aubergine' });
    expect((await h.shorty.links({ q: 'zucchini' })).items.map((l) => l.id)).toEqual([bySlug.id]);
    expect((await h.shorty.links({ q: 'aubergine' })).items.map((l) => l.id)).toEqual([byBase.id]);
  });

  it('does not throw on regex metacharacters, or treat them as a pattern', async () => {
    const h = await harness();
    await seed(h, 3);
    await expect(h.shorty.links({ q: '(' })).resolves.toBeTruthy();
    expect((await h.shorty.links({ q: '.*' })).items).toEqual([]);
  });

  it('does not report the cap instead of a smaller requested limit', async () => {
    const h = await harness();
    await seed(h, 4);
    const page = await h.shorty.links({ limit: 3 });
    expect(page.limit).toBe(3);
    expect(page.items).toHaveLength(3);
  });

  it('does not hand out a cursor to an empty page when the count is an exact multiple', async () => {
    const h = await harness();
    await seed(h, 6);
    const first = await h.shorty.links({ limit: 3 });
    expect(first.nextCursor).not.toBeNull();
    const second = await h.shorty.links({ limit: 3, cursor: first.nextCursor ?? undefined });
    expect(second.items).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
  });

  it('does not lose the tag or archived filter across cursor pages', async () => {
    const h = await harness();
    const made = await seed(h, 8, (i) => ({ tags: i % 2 === 0 ? ['x'] : [] }));
    const tagged = made.filter((_, i) => i % 2 === 0).map((l) => l.id).sort();
    expect((await allPages(h, { tag: 'x', limit: 2 })).ids.sort()).toEqual(tagged);

    const archived = made.slice(0, 5);
    for (const l of archived) await h.shorty.archiveLink(l.id);
    expect((await allPages(h, { archived: true, limit: 2 })).ids.sort()).toEqual(archived.map((l) => l.id).sort());
    expect((await allPages(h, { archived: false, limit: 2 })).ids.sort()).toEqual(made.slice(5).map((l) => l.id).sort());
  });
});

describe('shortUrl()', () => {
  it('does not build a different URL from a Link object than from its slug', async () => {
    const h = await harness();
    const link = await create(h, { slug: 'spring/ig' });
    expect(h.shorty.shortUrl(link)).toBe('http://short.test/go/spring/ig');
    expect(h.shorty.shortUrl(link)).toBe(link.shortUrl);
    expect(h.shorty.shortUrl('spring/ig')).toBe(link.shortUrl);
  });
});

describe('defaultResolveUser', () => {
  const req = (fields: Record<string, unknown>) => fields as unknown as Request;

  it('does not miss the conventional id locations', () => {
    expect(defaultResolveUser(req({ authUserId: 'a1' }))).toEqual({ id: 'a1' });
    const oid = new Types.ObjectId();
    expect(defaultResolveUser(req({ user: { _id: oid } }))).toEqual({ id: oid.toHexString() });
    expect(defaultResolveUser(req({ user: { id: 42 } }))).toEqual({ id: '42' });
  });

  it('does not miss a display name from name, displayName or email', () => {
    expect(defaultResolveUser(req({ user: { id: 'u', name: 'Ann' } }))).toEqual({ id: 'u', name: 'Ann' });
    expect(defaultResolveUser(req({ user: { id: 'u', displayName: 'Ann D' } }))).toEqual({ id: 'u', name: 'Ann D' });
    expect(defaultResolveUser(req({ user: { id: 'u', email: 'ann@acme.com' } }))).toEqual({ id: 'u', name: 'ann@acme.com' });
  });

  it('does not invent an actor when there is no id', () => {
    expect(defaultResolveUser(req({}))).toBeNull();
    expect(defaultResolveUser(req({ user: {} }))).toBeNull();
    expect(defaultResolveUser(req({ user: { name: 'No Id' } }))).toBeNull();
    expect(defaultResolveUser(req({ authUserId: '' }))).toBeNull();
  });
});

describe('ERROR_STATUS / ShortyError', () => {
  it('does not drift from the documented status table', () => {
    expect({ ...ERROR_STATUS }).toEqual({
      invalid_url: 400,
      unsupported_scheme: 400,
      invalid_base_url: 400,
      invalid_param: 400,
      ambiguous_destination: 400,
      slug_invalid: 400,
      slug_too_long: 400,
      slug_reserved: 400,
      validation: 400,
      range_too_large: 400,
      not_found: 404,
      slug_taken: 409,
      slug_locked: 409,
      host_not_allowed: 422,
      host_blocked: 422,
      destination_loop: 422,
      slug_generation_exhausted: 500,
      case_collision: 500,
    });
  });

  it('does not default a ShortyError to any status but its table entry', () => {
    const err = new ShortyError('slug_taken', undefined, { slug: 'x' });
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(409);
    expect(err.code).toBe('slug_taken');
    expect(err.details).toEqual({ slug: 'x' });
    expect(new ShortyError('validation', 418).status).toBe(418);
  });
});
