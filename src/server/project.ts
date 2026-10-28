import type { HistoryEntry, Link, LinkDoc } from '../../types/index.js';
import type { ResolvedContext } from './config.js';

/**
 * Storage → API. A `Link` never carries `_id`, `__v`, `slugKey` or `keys`;
 * absent optionals are absent, not `null` or `undefined`.
 */

export function toLink(ctx: ResolvedContext, doc: LinkDoc): Link {
  const link: Link = {
    id: String(doc._id),
    slug: doc.slug,
    aliases: (doc.aliases ?? []).map((a) => a.slug),
    origin: doc.origin,
    shortUrl: `${ctx.publicBaseUrl}/${doc.slug}`,
    baseUrl: doc.baseUrl,
    utm: { ...doc.utm },
    params: (doc.params ?? []).map((p) => ({ key: p.key, value: p.value ?? '' })),
    destination: doc.destination,
    tags: [...(doc.tags ?? [])],
    redirect: {},
    rev: doc.rev,
    clicks: doc.clicks,
    uniqueClicks: doc.uniqueClicks,
    botClicks: doc.botClicks,
    archived: doc.archived,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
  if (doc.hash) link.hash = doc.hash;
  if (doc.title) link.title = doc.title;
  if (doc.notes) link.notes = doc.notes;
  if (doc.redirect?.status != null) link.redirect.status = doc.redirect.status;
  if (doc.redirect?.forwardQuery != null) link.redirect.forwardQuery = doc.redirect.forwardQuery;
  if (doc.expiresAt) link.expiresAt = doc.expiresAt;
  if (doc.maxClicks != null) link.maxClicks = doc.maxClicks;
  if (doc.expiredUrl) link.expiredUrl = doc.expiredUrl;
  if (doc.social) link.social = { ...doc.social };
  if (doc.og) link.og = { ...doc.og };
  if (doc.lastClickedAt) link.lastClickedAt = doc.lastClickedAt;
  return link;
}

interface StoredHistory {
  kind: HistoryEntry['kind'];
  at: Date;
  rev?: number;
  destination?: string;
  previous?: string;
  slug?: string;
  from?: string;
  to?: string;
  mode?: string;
}

export function toHistoryEntry(doc: StoredHistory): HistoryEntry {
  switch (doc.kind) {
    case 'created':
      return { kind: 'created', at: doc.at, rev: 1, destination: doc.destination ?? '', slug: doc.slug ?? '' };
    case 'destination':
      return {
        kind: 'destination', at: doc.at, rev: doc.rev ?? 0,
        destination: doc.destination ?? '', previous: doc.previous ?? '',
      };
    default:
      return {
        kind: 'slug', at: doc.at, from: doc.from ?? '', to: doc.to ?? '',
        mode: (doc.mode ?? 'alias') as Extract<HistoryEntry, { kind: 'slug' }>['mode'],
      };
  }
}
