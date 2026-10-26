import { randomInt } from 'node:crypto';
import type mongoose from 'mongoose';
import type { SlugCheck, SlugUnavailableReason } from '../../types/index.js';
import { ShortyError } from '../shared/errors.js';
import { MAX_SLUG_LENGTH } from './config.js';
import type { ResolvedContext } from './config.js';

/**
 * Slugs: grammar, normalization, reserved names, generation, and the claim
 * protocol against `models.Slug` — the ONLY uniqueness authority. A claim is an
 * insert keyed by the slug key; a duplicate-key error means taken. Nothing in
 * this file (or anywhere) checks-then-writes.
 */

const GRAMMAR = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;

/** How many times a generator is asked before `slug_generation_exhausted`. */
export const GENERATE_ATTEMPTS = 10;

export interface ParsedSlug {
  /** NFKD accent-stripped, slashes trimmed, case KEPT. */
  display: string;
  /** What the slugs collection and `keys` use. */
  key: string;
}

export interface SlugInspection extends ParsedSlug {
  problem?: Exclude<SlugUnavailableReason, 'taken'>;
}

export function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}

/** NFKD, drop combining marks, trim leading/trailing `/`. No case change. */
export function stripSlug(raw: string): string {
  return raw.normalize('NFKD').replace(/\p{M}/gu, '').replace(/^\/+|\/+$/g, '');
}

export interface SlugService {
  keyOf(display: string): string;
  /** Never throws: reports the first problem found (invalid → too_long → reserved). */
  inspect(raw: unknown): SlugInspection;
  /** Like `inspect`, but throws the matching `ShortyError`. */
  parse(raw: unknown): ParsedSlug;
  /** Key for a lookup, or null when the input can't be a slug at all. */
  lookupKey(raw: unknown): string | null;
  /** Insert-claim `key` for `linkId`. Throws `slug_taken` on a duplicate key. */
  claim(parsed: ParsedSlug, linkId: mongoose.Types.ObjectId, current: boolean, at: Date): Promise<void>;
  /** Delete the claim on `key` only if `linkId` holds it. */
  release(key: string, linkId: mongoose.Types.ObjectId): Promise<void>;
  /**
   * Run `attempt` with generated candidates until it returns a value; a
   * candidate that is invalid, reserved, or for which `attempt` returns null
   * (taken) is retried. Exhaustion → `slug_generation_exhausted`.
   */
  generate<T>(attempt: (candidate: ParsedSlug) => Promise<T | null>): Promise<T>;
  /** A fresh slug nobody holds right now. */
  fresh(): Promise<string>;
  check(raw: string, linkId?: string): Promise<SlugCheck>;
}

export function createSlugService(ctx: ResolvedContext): SlugService {
  const { Slug } = ctx.models;
  const { caseSensitive } = ctx.slug;
  const chars = Array.from(ctx.slug.alphabet);

  const keyOf = (display: string): string => (caseSensitive ? display : display.toLowerCase());

  const isReserved = (key: string): boolean =>
    ctx.slug.reserved.some((rule) => {
      if (typeof rule === 'string') return rule === key || (!caseSensitive && rule.toLowerCase() === key);
      rule.lastIndex = 0;
      return rule.test(key);
    });

  function inspect(raw: unknown): SlugInspection {
    const display = typeof raw === 'string' ? stripSlug(raw) : '';
    const key = keyOf(display);
    if (typeof raw !== 'string' || !GRAMMAR.test(display)) return { display, key, problem: 'invalid' };
    if (display.length > MAX_SLUG_LENGTH) return { display, key, problem: 'too_long' };
    if (isReserved(key)) return { display, key, problem: 'reserved' };
    return { display, key };
  }

  const CODES = { invalid: 'slug_invalid', too_long: 'slug_too_long', reserved: 'slug_reserved' } as const;

  function parse(raw: unknown): ParsedSlug {
    const { display, key, problem } = inspect(raw);
    if (problem) throw new ShortyError(CODES[problem], undefined, { slug: display });
    return { display, key };
  }

  function lookupKey(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const display = stripSlug(raw);
    if (display.length > MAX_SLUG_LENGTH || !GRAMMAR.test(display)) return null;
    return keyOf(display);
  }

  function candidate(): unknown {
    if (ctx.slug.generate) return ctx.slug.generate();
    let out = '';
    for (let i = 0; i < ctx.slug.length; i += 1) out += chars[randomInt(chars.length)];
    return out;
  }

  async function generate<T>(attempt: (c: ParsedSlug) => Promise<T | null>): Promise<T> {
    for (let i = 0; i < GENERATE_ATTEMPTS; i += 1) {
      const { display, key, problem } = inspect(candidate());
      if (problem) continue;
      const result = await attempt({ display, key });
      if (result !== null) return result;
    }
    throw new ShortyError('slug_generation_exhausted');
  }

  return {
    keyOf,
    inspect,
    parse,
    lookupKey,

    async claim({ display, key }, linkId, current, at) {
      try {
        await Slug.create({ _id: key, linkId, current, at });
      } catch (err) {
        if (isDuplicateKey(err)) throw new ShortyError('slug_taken', undefined, { slug: display });
        throw err;
      }
    },

    async release(key, linkId) {
      await Slug.deleteOne({ _id: key, linkId });
    },

    generate,

    async fresh() {
      return generate(async ({ display, key }) => ((await Slug.exists({ _id: key })) ? null : display));
    },

    async check(raw, linkId) {
      const { display, key, problem } = inspect(raw);
      if (problem) return { slug: display, available: false, reason: problem };
      const held = await Slug.findById(key).lean();
      if (held && !(linkId && String(held.linkId) === linkId)) {
        return { slug: display, available: false, reason: 'taken' };
      }
      return { slug: display, available: true };
    },
  };
}
