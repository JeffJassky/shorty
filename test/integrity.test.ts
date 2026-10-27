import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { createShorty } from '../src/server/index.js';
import { ShortyError } from '../src/shared/errors.js';
import { HUMAN_UA, harness, startDb, stopDb } from './helpers.js';
import type { Harness, HarnessOptions } from './helpers.js';
import type { ShortyErrorCode, ShortyInstance } from '../types/index.js';

/**
 * Data integrity under concurrency and partial failure (end review (c), PR 7).
 *
 * Races are forced DETERMINISTICALLY: a model method is wrapped once so that a
 * competing operation runs at an exact point inside the operation under test
 * (just before a claim, just after the first read, just before a write). The
 * wrapper restores the original before running the competitor, so the
 * competitor itself is unaffected. Each test asserts the CORRECT end state
 * stated in the contract (types/index.d.ts: updateLink, deleteLink, recount,
 * ready, LinkDoc.wv / ck, LinkPatch.slug).
 */

beforeAll(startDb);
afterAll(stopDb);

const DEST = 'https://acme.com/sale';
const DAY_KEY = '2026-03-15'; // makeClock() default

// ── forcing helpers ──────────────────────────────────────────────────────────

type AnyFn = (...args: any[]) => any;
const restores: Array<() => void> = [];
afterEach(() => { while (restores.length) restores.pop()!(); });

function swap(model: any, method: string, impl: (orig: AnyFn) => AnyFn): () => void {
  const own = Object.prototype.hasOwnProperty.call(model, method);
  const prev = model[method];
  const orig: AnyFn = prev.bind(model);
  model[method] = impl(orig);
  const restore = (): void => {
    if (own) model[method] = prev;
    else delete model[method];
  };
  restores.push(restore);
  return restore;
}

/** Promise-returning method (create, insertMany, bulkWrite): run `fn` once before the first matching call. */
function beforeCall(model: any, method: string, fn: () => Promise<void>, when: (args: any[]) => boolean = () => true): void {
  const restore = swap(model, method, (orig) => async (...args: any[]) => {
    if (!when(args)) return orig(...args);
    restore();
    await fn();
    return orig(...args);
  });
}

/** Query-returning method (findById, updateOne, …): run `fn` once before the first call's query executes. */
function beforeExec(model: any, method: string, fn: () => Promise<void>): void {
  const restore = swap(model, method, (orig) => (...args: any[]) => {
    restore();
    const q = orig(...args);
    const exec = q.exec.bind(q);
    q.exec = async (...a: any[]) => { await fn(); return exec(...a); };
    return q;
  });
}

/** Query-returning method: run `fn` once AFTER the first call's query has executed, then hand back its result. */
function afterExec(model: any, method: string, fn: (result: unknown) => Promise<void>): void {
  const restore = swap(model, method, (orig) => (...args: any[]) => {
    restore();
    const q = orig(...args);
    const exec = q.exec.bind(q);
    q.exec = async (...a: any[]) => { const r = await exec(...a); await fn(r); return r; };
    return q;
  });
}

const oid = (id: string) => new mongoose.Types.ObjectId(id);

async function rejects(p: Promise<unknown>, code: ShortyErrorCode): Promise<void> {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err, `expected ShortyError(${code})`).toBeInstanceOf(ShortyError);
  expect((err as ShortyError).code).toBe(code);
}

function hit(h: Harness, path: string, ip = '198.51.100.1') {
  return request(h.app).get(path).set('User-Agent', HUMAN_UA).set('X-Forwarded-For', ip);
}

function sibling(h: Harness, caseSensitive: boolean): ShortyInstance {
  return createShorty({ ...h.config, ...h.prefixes, slug: { ...h.config.slug, caseSensitive } });
}

/** Every Slug row of the link is in `keys` and vice versa; only `slugKey` is current. */
async function expectClaimsMatchKeys(h: Harness, id: string): Promise<void> {
  const doc = await h.shorty.models.Link.findById(id).lean();
  expect(doc, 'link exists').toBeTruthy();
  const claims = await h.shorty.models.Slug.find({ linkId: oid(id) }).lean();
  expect(claims.map((c) => c._id).sort(), 'claims == keys').toEqual([...doc!.keys].sort());
  expect(claims.filter((c) => c.current).map((c) => c._id), 'only slugKey is current').toEqual([doc!.slugKey]);
}

async function rowsLeft(h: Harness, id: string) {
  const linkId = oid(id);
  const { Link, Slug, History, Click, Daily } = h.shorty.models;
  const [link, slugs, history, clicks, daily] = await Promise.all([
    Link.countDocuments({ _id: linkId }),
    Slug.countDocuments({ linkId }),
    History.countDocuments({ linkId }),
    Click.countDocuments({ linkId }),
    Daily.countDocuments({ linkId }),
  ]);
  return { link, slugs, history, clicks, daily };
}

const NONE = { link: 0, slugs: 0, history: 0, clicks: 0, daily: 0 };

async function setup(opts: HarnessOptions = {}, slug = 'aaa') {
  const h = await harness(opts);
  const link = await h.shorty.createLink({ url: DEST, slug });
  return { h, link };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('renames under concurrency', () => {
  it('does not let an untilClicked rename through when the first human click lands between read and write', async () => {
    const { h, link } = await setup({ config: { slug: { rename: 'untilClicked' } } });
    beforeCall(h.shorty.models.Slug, 'create', async () => {
      expect((await hit(h, '/go/aaa')).status).toBe(302);
      await h.shorty.drain();
    }, ([doc]) => doc?._id === 'bbb');

    await rejects(h.shorty.updateLink(link.id, { slug: 'bbb' }), 'slug_locked');

    const after = await h.shorty.link(link.id);
    expect(after?.slug).toBe('aaa');
    expect(after?.clicks).toBe(1);
    expect(await h.shorty.models.Slug.exists({ _id: 'bbb' }), 'the losing claim is released').toBeNull();
    await expectClaimsMatchKeys(h, link.id);
  });

  it('does not drop an alias when a rename computed from a stale read races A→B→A', async () => {
    const { h, link } = await setup({}, 'a');
    beforeCall(h.shorty.models.Slug, 'create', async () => {
      await h.shorty.updateLink(link.id, { slug: 'b' });
      await h.shorty.updateLink(link.id, { slug: 'a' });
    }, ([doc]) => doc?._id === 'c');

    const out = await h.shorty.updateLink(link.id, { slug: 'c' });

    expect(out.slug).toBe('c');
    expect([...out.aliases].sort()).toEqual(['a', 'b']);
    await expectClaimsMatchKeys(h, link.id);
    expect((await h.shorty.link('b'))?.id).toBe(link.id);
    expect((await hit(h, '/go/b')).status).toBe(302);
    expect((await hit(h, '/go/a')).status).toBe(302);
  });

  it('does not duplicate a history rev when the destination changes A→B→A under a pending update', async () => {
    const h = await harness();
    const link = await h.shorty.createLink({ url: 'https://acme.com/a' });
    afterExec(h.shorty.models.Link, 'findById', async () => {
      await h.shorty.updateLink(link.id, { url: 'https://acme.com/b' });
      await h.shorty.updateLink(link.id, { url: 'https://acme.com/a' });
    });

    const out = await h.shorty.updateLink(link.id, { url: 'https://acme.com/c' });

    const revs = (await h.shorty.history(link.id))
      .filter((e) => e.kind === 'destination')
      .map((e) => (e.kind === 'destination' ? e.rev : -1));
    expect(out.rev).toBe(4);
    expect(revs).toEqual([2, 3, 4]);
  });

  it('does not lose a redirect field when two redirect patches race', async () => {
    const h = await harness();
    const link = await h.shorty.createLink({ url: DEST });
    afterExec(h.shorty.models.Link, 'findById', async () => {
      await h.shorty.updateLink(link.id, { redirect: { forwardQuery: false } });
    });

    await h.shorty.updateLink(link.id, { redirect: { status: 301 } });

    const doc = await h.shorty.models.Link.findById(link.id).lean();
    expect(doc?.redirect).toMatchObject({ status: 301, forwardQuery: false });
  });

  it('does not leave history rows behind when a delete lands mid-rename', async () => {
    const { h, link } = await setup({}, 'm');
    const del = async (): Promise<void> => { await h.shorty.deleteLink(link.id); };
    // Whichever history write the implementation uses, the delete lands just before it.
    let fired = false;
    const once = async (): Promise<void> => { if (!fired) { fired = true; await del(); } };
    beforeCall(h.shorty.models.History, 'insertMany', once);
    beforeCall(h.shorty.models.History, 'create', once);

    await h.shorty.updateLink(link.id, { slug: 'n' }).catch(() => undefined);

    expect(fired, 'the delete was forced').toBe(true);
    expect(await rowsLeft(h, link.id)).toEqual(NONE);
  });
});

describe('claims survive ambiguous and partial failures', () => {
  it('does not release a rename claim when the write landed but its ack was lost', async () => {
    const { h, link } = await setup({}, 'p');
    const lost = Object.assign(new Error('connection timed out'), { name: 'MongoNetworkTimeoutError' });
    let fired = false;
    const ackLost = (orig: AnyFn) => (...args: any[]) => {
      const q = orig(...args);
      if (fired) return q;
      fired = true;
      const exec = q.exec.bind(q);
      q.exec = async (...a: any[]) => { await exec(...a); throw lost; };
      return q;
    };
    swap(h.shorty.models.Link, 'updateOne', ackLost);
    swap(h.shorty.models.Link, 'findOneAndUpdate', ackLost);

    await h.shorty.updateLink(link.id, { slug: 'q' }).catch(() => undefined);

    expect(fired, 'the ack was dropped').toBe(true);
    const doc = await h.shorty.models.Link.findById(link.id).lean();
    expect(doc?.keys).toContain('q'); // the server applied the write
    expect((await h.shorty.models.Slug.findById('q').lean())?.linkId?.toString()).toBe(link.id);
    await rejects(h.shorty.createLink({ url: 'https://other.example/', slug: 'q' }), 'slug_taken');
    expect(await h.shorty.models.Link.countDocuments({ keys: 'q' })).toBe(1);
  });

  it('does not keep a rename claim when the write genuinely failed', async () => {
    // Guard for the fix above: a write that never landed still releases.
    const { h, link } = await setup({}, 'p');
    swap(h.shorty.models.Link, 'updateOne', (orig) => (...args: any[]) => {
      const q = orig(...args);
      q.exec = async () => { throw new Error('write failed'); };
      return q;
    });

    await expect(h.shorty.updateLink(link.id, { slug: 'q' })).rejects.toThrow();
    restores.pop()!();

    expect((await h.shorty.link(link.id))?.slug).toBe('p');
    expect(await h.shorty.models.Slug.exists({ _id: 'q' })).toBeNull();
    await expectClaimsMatchKeys(h, link.id);
  });

  it('does not leave a second owner of a slug when a failed create cannot delete its link row', async () => {
    const h = await harness();
    const { History, Link, Slug } = h.shorty.models;
    beforeCall(History, 'create', async () => { throw new Error('history write failed'); });
    beforeExec(Link, 'deleteOne', async () => { throw new Error('cleanup failed'); });

    await expect(h.shorty.createLink({ url: DEST, slug: 'x' })).rejects.toThrow();
    await h.shorty.createLink({ url: 'https://other.example/', slug: 'x' }).catch(() => undefined);

    const holders = await Link.find({ keys: 'x' }).lean();
    expect(holders.length, 'at most one link holds a key').toBeLessThanOrEqual(1);
    for (const doc of holders) {
      expect((await Slug.findById('x').lean())?.linkId?.toString()).toBe(String(doc._id));
    }
  });
});

describe('counters and deletes racing the click pipeline', () => {
  it('does not leave daily or click rows when a delete lands before the click row is written', async () => {
    const { h, link } = await setup({}, 'zz');
    let fired = false;
    beforeCall(h.shorty.models.Click, 'create', async () => { fired = true; await h.shorty.deleteLink(link.id); });

    await hit(h, '/go/zz');
    await h.shorty.drain();

    expect(fired, 'the delete was forced').toBe(true);
    expect(await rowsLeft(h, link.id)).toEqual(NONE);
    const stats = await h.shorty.stats({ from: DAY_KEY, to: DAY_KEY });
    expect(stats.totals.humans.clicks).toBe(0);
    expect(stats.topLinks).toEqual([]);
  });

  it('does not leave daily or click rows when a delete lands before the daily rollup is written', async () => {
    const { h, link } = await setup({}, 'zz');
    let fired = false;
    beforeExec(h.shorty.models.Daily, 'updateOne', async () => { fired = true; await h.shorty.deleteLink(link.id); });

    await hit(h, '/go/zz');
    await h.shorty.drain();

    expect(fired, 'the delete was forced').toBe(true);
    expect(await rowsLeft(h, link.id)).toEqual(NONE);
    const stats = await h.shorty.stats({ from: DAY_KEY, to: DAY_KEY });
    expect(stats.totals.humans.clicks).toBe(0);
  });

  it('does not let recount drop below the raw clicks still held after a failed rollup write', async () => {
    const { h, link } = await setup({}, 'rc');
    await hit(h, '/go/rc', '203.0.113.1');
    await h.shorty.drain();
    beforeExec(h.shorty.models.Daily, 'updateOne', async () => { throw new Error('rollup write failed'); });
    await hit(h, '/go/rc', '203.0.113.2');
    await h.shorty.drain();

    const linkId = oid(link.id);
    const raw = await h.shorty.models.Click.countDocuments({ linkId });
    const [daily] = await h.shorty.models.Daily.aggregate<{ clicks: number }>([
      { $match: { linkId } }, { $group: { _id: null, clicks: { $sum: '$clicks' } } },
    ]);
    expect(raw, 'raw clicks ≤ daily (pipeline writes Daily before Click)').toBeLessThanOrEqual(daily?.clicks ?? 0);

    const after = await h.shorty.recount(link.id);
    expect(after.clicks).toBe(daily?.clicks ?? 0);
    expect(after.clicks).toBeGreaterThanOrEqual(raw);
  });
});

describe('write version (wv) and key mode (ck)', () => {
  it('does not bump wv on clicks, and bumps it exactly once per link write', async () => {
    const { h, link } = await setup({}, 'wv');
    const wv = async () => (await h.shorty.models.Link.findById(link.id).lean())?.wv;
    const doc0 = await h.shorty.models.Link.findById(link.id).lean();
    expect(doc0?.wv).toBe(1);
    expect(doc0?.ck).toBe(false);

    await h.shorty.updateLink(link.id, { title: 'T' });
    expect(await wv()).toBe(2);
    await h.shorty.archiveLink(link.id);
    expect(await wv()).toBe(3);
    await h.shorty.archiveLink(link.id); // already archived: no write
    expect(await wv()).toBe(3);
    await h.shorty.unarchiveLink(link.id);
    expect(await wv()).toBe(4);
    await hit(h, '/go/wv');
    await h.shorty.drain();
    expect(await wv()).toBe(4);
    await h.shorty.updateLink(link.id, { slug: 'wv2' });
    const doc = await h.shorty.models.Link.findById(link.id).lean();
    expect(doc?.wv).toBe(5);
    expect(doc?.ck).toBe(false);
  });
});

describe('case-only slug changes', () => {
  it('does not ignore a case-only slug change under caseSensitive: false', async () => {
    const { h, link } = await setup({}, 'spring');

    const out = await h.shorty.updateLink(link.id, { slug: 'Spring' });

    expect(out.slug).toBe('Spring');
    expect(out.aliases).toEqual([]);
    expect((await h.shorty.history(link.id)).filter((e) => e.kind === 'slug')).toEqual([]);
    const claims = await h.shorty.models.Slug.find({ linkId: oid(link.id) }).lean();
    expect(claims.map((c) => [c._id, c.current])).toEqual([['spring', true]]);
    expect((await hit(h, '/go/spring')).status).toBe(302);
    expect((await hit(h, '/go/SPRING')).status).toBe(302);
  });

  it('does not lock a case-only slug change in never or clicked untilClicked mode', async () => {
    const never = await setup({ config: { slug: { rename: 'never' } } }, 'spring');
    expect((await never.h.shorty.updateLink(never.link.id, { slug: 'SPRING' })).slug).toBe('SPRING');

    const until = await setup({ config: { slug: { rename: 'untilClicked' } } }, 'spring');
    await hit(until.h, '/go/spring');
    await until.h.shorty.drain();
    expect((await until.h.shorty.updateLink(until.link.id, { slug: 'Spring' })).slug).toBe('Spring');
  });
});

describe('ready() re-key', () => {
  it('does not overwrite a rename that lands during a ready() re-key', async () => {
    const { h, link } = await setup({}, 'Old'); // instance A: insensitive
    const s2 = sibling(h, true); // instance B booting with the flipped mode
    let fired = false;
    const rename = async (): Promise<void> => {
      if (fired) return;
      fired = true;
      await h.shorty.updateLink(link.id, { slug: 'New' });
    };
    // The rename lands after B's scan, before B's first re-key write.
    beforeCall(h.shorty.models.Slug, 'bulkWrite', rename);
    beforeCall(h.shorty.models.Link, 'bulkWrite', rename);

    await s2.ready();

    expect(fired, 'the rename was forced').toBe(true);
    const doc = await h.shorty.models.Link.findById(link.id).lean();
    expect(doc?.slug).toBe('New');
    expect(doc?.slugKey).toBe('New');
    expect(doc?.ck).toBe(true);
    expect((await s2.link('New'))?.id).toBe(link.id);
    expect((await s2.link('Old'))?.id).toBe(link.id);
    await expectClaimsMatchKeys(h, link.id);
  });

  it('does not strand links written by an other-mode instance after the next ready()', async () => {
    const h = await harness(); // A: insensitive, booted first
    const b = sibling(h, true);
    await b.ready(); // B flips to sensitive
    const a = await h.shorty.createLink({ url: DEST, slug: 'AbC' }); // A still writes under its mode

    await sibling(h, true).ready(); // B restarts: last to boot

    const doc = await h.shorty.models.Link.findById(a.id).lean();
    expect(doc?.slugKey).toBe('AbC');
    expect(doc?.ck).toBe(true);
    expect((await b.link('AbC'))?.id).toBe(a.id);
    await expectClaimsMatchKeys(h, a.id);
  });

  it('does not skip re-keying when Meta is missing but links exist', async () => {
    const { h, link } = await setup({}, 'AbC');
    await h.shorty.models.Meta.deleteMany({});
    const s2 = sibling(h, true);

    await s2.ready();

    expect((await s2.link('AbC'))?.id).toBe(link.id);
    const doc = await h.shorty.models.Link.findById(link.id).lean();
    expect(doc?.slugKey).toBe('AbC');
    expect(doc?.ck).toBe(true);
    await expectClaimsMatchKeys(h, link.id);
  });
});
