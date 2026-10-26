import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createShorty } from '../src/server/index.js';
import type { CreateShortyConfig, RedirectStatus, RenameMode, ShortyInstance } from '../types/index.js';

/**
 * createShorty config resolution (§3, CreateShortyConfig). createShorty only
 * compiles models; nothing here needs a running database. Every instance gets
 * its own model + collection prefix so the mongoose registry never collides.
 */

let n = 0;
function make(overrides: Partial<CreateShortyConfig> = {}): ShortyInstance {
  n += 1;
  return createShorty({
    connection: mongoose,
    publicBaseUrl: 'https://acme.com/go',
    pepper: 'p',
    modelPrefix: `Cfg${n}`,
    collectionPrefix: `cfg${n}_`,
    ...overrides,
  });
}

let savedPepper: string | undefined;
beforeEach(() => {
  savedPepper = process.env.SHORTY_PEPPER;
  delete process.env.SHORTY_PEPPER;
});
afterEach(() => {
  if (savedPepper === undefined) delete process.env.SHORTY_PEPPER;
  else process.env.SHORTY_PEPPER = savedPepper;
});

describe('required keys', () => {
  it('does not start without a connection', () => {
    expect(() => make({ connection: undefined as unknown as CreateShortyConfig['connection'] }))
      .toThrow(TypeError);
    expect(() => make({ connection: undefined as unknown as CreateShortyConfig['connection'] }))
      .toThrow(/connection/);
  });

  it('does not start without publicBaseUrl', () => {
    const { publicBaseUrl: _omit, ...rest } = {
      connection: mongoose, publicBaseUrl: 'x', modelPrefix: 'CfgMissing', collectionPrefix: 'cfgmissing_',
    };
    expect(() => createShorty(rest as CreateShortyConfig)).toThrow(TypeError);
    expect(() => createShorty(rest as CreateShortyConfig)).toThrow(/publicBaseUrl/);
  });

  it.each([
    ['relative', '/go'],
    ['host-only', 'acme.com/go'],
    ['non-http', 'ftp://acme.com/go'],
    ['with a query', 'https://acme.com/go?x=1'],
    ['with a fragment', 'https://acme.com/go#x'],
  ])('does not accept a %s publicBaseUrl', (_label, publicBaseUrl) => {
    expect(() => make({ publicBaseUrl })).toThrow(TypeError);
    expect(() => make({ publicBaseUrl })).toThrow(/publicBaseUrl/);
  });
});

describe('publicBaseUrl', () => {
  it('does not double the slash when publicBaseUrl ends in one', () => {
    expect(make({ publicBaseUrl: 'https://acme.com/go/' }).shortUrl('x')).toBe('https://acme.com/go/x');
    expect(make({ publicBaseUrl: 'https://go.acme.com/' }).shortUrl('x')).toBe('https://go.acme.com/x');
  });

  it('does not alter a publicBaseUrl without a trailing slash', () => {
    expect(make({ publicBaseUrl: 'https://go.acme.com' }).shortUrl('spring/ig')).toBe('https://go.acme.com/spring/ig');
    expect(make({ publicBaseUrl: 'http://localhost:3000/l' }).shortUrl('x')).toBe('http://localhost:3000/l/x');
  });
});

describe('invalid values throw a TypeError naming the key', () => {
  it.each([0, -1, 2, 2.5, 191, Number.NaN, 1000])('does not accept slug.length %s', (length) => {
    expect(() => make({ slug: { length } })).toThrow(TypeError);
    expect(() => make({ slug: { length } })).toThrow(/slug\.length/);
  });

  it('does not accept an unknown slug.rename', () => {
    const slug = { rename: 'sometimes' as RenameMode };
    expect(() => make({ slug })).toThrow(TypeError);
    expect(() => make({ slug })).toThrow(/slug\.rename/);
  });

  it('does not accept a redirect.status outside 301/302/307/308', () => {
    for (const status of [200, 303, 304, 404]) {
      const redirect = { status: status as RedirectStatus };
      expect(() => make({ redirect })).toThrow(TypeError);
      expect(() => make({ redirect })).toThrow(/redirect\.status/);
    }
  });

  it('does not accept a clicks.timezone that is not an IANA zone', () => {
    const clicks = { timezone: 'Mars/Olympus_Mons' };
    expect(() => make({ clicks })).toThrow(TypeError);
    expect(() => make({ clicks })).toThrow(/clicks\.timezone/);
  });

  it.each(['aaa', 'a', ''])('does not accept slug.alphabet %j (fewer than 2 distinct chars)', (alphabet) => {
    expect(() => make({ slug: { alphabet } })).toThrow(TypeError);
    expect(() => make({ slug: { alphabet } })).toThrow(/slug\.alphabet/);
  });

  it.each([0, -1])('does not accept clicks.retentionDays %s', (retentionDays) => {
    expect(() => make({ clicks: { retentionDays } })).toThrow(TypeError);
    expect(() => make({ clicks: { retentionDays } })).toThrow(/clicks\.retentionDays/);
  });

  it.each([0, -1])('does not accept clicks.uniqueWindowMinutes %s', (uniqueWindowMinutes) => {
    expect(() => make({ clicks: { uniqueWindowMinutes } })).toThrow(TypeError);
    expect(() => make({ clicks: { uniqueWindowMinutes } })).toThrow(/clicks\.uniqueWindowMinutes/);
  });

  it('does not reject the valid edge values', () => {
    expect(() => make({
      slug: { length: 3, alphabet: 'ab', rename: 'never' },
      redirect: { status: 308 },
      clicks: { timezone: 'America/New_York' },
    })).not.toThrow();
    expect(() => make({ slug: { length: 190 } })).not.toThrow();
  });
});

describe('pepper', () => {
  it('does not crash without a pepper — it warns exactly once', () => {
    const warn = vi.fn();
    expect(() => make({ pepper: undefined, logger: { warn } })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not claim clicks are enabled without a pepper', () => {
    const s = make({ pepper: undefined, logger: { warn: vi.fn() } });
    expect(s.health().clicksEnabled).toBe(false);
  });

  it('does not warn about a missing pepper when clicks are switched off', () => {
    const warn = vi.fn();
    make({ pepper: undefined, clicks: false, logger: { warn } });
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not record clicks when clicks: false, even with a pepper', () => {
    expect(make({ clicks: false }).health().clicksEnabled).toBe(false);
  });

  it('does not ignore SHORTY_PEPPER when no pepper is passed (no warning)', () => {
    process.env.SHORTY_PEPPER = 'from-env';
    const warn = vi.fn();
    make({ pepper: undefined, logger: { warn } });
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not leave clicks disabled when SHORTY_PEPPER supplies the pepper', () => {
    process.env.SHORTY_PEPPER = 'from-env';
    expect(make({ pepper: undefined }).health().clicksEnabled).toBe(true);
  });
});

describe('models', () => {
  it('does not change the default collection and model names', () => {
    // The only instance in this file on the default prefixes.
    const s = createShorty({ connection: mongoose, publicBaseUrl: 'https://acme.com/go', pepper: 'p' });
    const m = s.models;
    expect(m.Link.collection.collectionName).toBe('shorty_links');
    expect(m.Slug.collection.collectionName).toBe('shorty_slugs');
    expect(m.History.collection.collectionName).toBe('shorty_history');
    expect(m.Click.collection.collectionName).toBe('shorty_clicks');
    expect(m.Daily.collection.collectionName).toBe('shorty_daily');
    expect(m.Seen.collection.collectionName).toBe('shorty_seen');
    expect(m.Miss.collection.collectionName).toBe('shorty_misses');
    expect(m.Meta.collection.collectionName).toBe('shorty_meta');
    expect(m.Link.modelName).toBe('ShortyLink');
  });

  it('does not collide when two instances share one connection with different prefixes', () => {
    const a = createShorty({
      connection: mongoose, publicBaseUrl: 'https://a.com/go', pepper: 'p',
      modelPrefix: 'TwoA', collectionPrefix: 'twoa_', clicks: { retentionDays: 10 },
    });
    const b = createShorty({
      connection: mongoose, publicBaseUrl: 'https://b.com/go', pepper: 'p',
      modelPrefix: 'TwoB', collectionPrefix: 'twob_', clicks: { retentionDays: 20 },
    });
    expect(a.models.Link).not.toBe(b.models.Link);
    expect(a.models.Link.modelName).not.toBe(b.models.Link.modelName);
    expect(a.models.Link.collection.collectionName).toBe('twoa_links');
    expect(b.models.Link.collection.collectionName).toBe('twob_links');
    expect(a.shortUrl('x')).toBe('https://a.com/go/x');
    expect(b.shortUrl('x')).toBe('https://b.com/go/x');

    // Each instance's TTL comes from its own config, not whichever compiled first.
    const ttl = (s: ShortyInstance) => s.models.Click.schema.indexes()
      .map(([, opts]) => opts?.expireAfterSeconds)
      .find((v) => v !== undefined);
    expect(ttl(a)).toBe(10 * 86400);
    expect(ttl(b)).toBe(20 * 86400);
  });

  it('does not throw OverwriteModelError when an instance is created twice with one prefix', () => {
    const cfg: CreateShortyConfig = {
      connection: mongoose, publicBaseUrl: 'https://acme.com/go', pepper: 'p',
      modelPrefix: 'Twice', collectionPrefix: 'twice_',
    };
    const first = createShorty(cfg);
    expect(() => createShorty(cfg)).not.toThrow();
    expect(createShorty(cfg).models.Link).toBe(first.models.Link);
  });
});
