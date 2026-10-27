import type { ParamKeyStat } from '../../types/index.js';
import { UTM_FIELDS } from '../shared/url.js';
import type { ResolvedContext } from './config.js';

/**
 * The param suggestion catalog (§7.4): live, uncached, over EVERY link
 * (archived included). Two aggregations, both capped — per-key counts need
 * "distinct links using this key at all", which a per-value group can't give
 * without collecting link ids.
 */

const MAX_TIME_MS = 2000;
const VALUES_PER_KEY = 50;
/** Distinct keys returned. A catalog with more than this many keys is not a suggestion list. */
const MAX_KEYS = 1000;

/** Every `{ k, v }` pair of a link: non-empty utm fields as `utm_<field>`, then params. */
const PAIRS = [
  {
    $project: {
      updatedAt: 1,
      pairs: {
        $concatArrays: [
          {
            $map: {
              input: {
                $filter: {
                  input: { $objectToArray: { $ifNull: ['$utm', {}] } },
                  as: 'e',
                  cond: {
                    $and: [
                      { $in: ['$$e.k', [...UTM_FIELDS]] },
                      { $eq: [{ $type: '$$e.v' }, 'string'] },
                      { $ne: ['$$e.v', ''] },
                    ],
                  },
                },
              },
              as: 'e',
              in: { k: { $concat: ['utm_', '$$e.k'] }, v: '$$e.v' },
            },
          },
          {
            $map: {
              input: { $ifNull: ['$params', []] },
              as: 'p',
              in: { k: '$$p.key', v: { $ifNull: ['$$p.value', ''] } },
            },
          },
        ],
      },
    },
  },
  { $unwind: '$pairs' },
];

export function createParamValues(ctx: ResolvedContext): () => Promise<ParamKeyStat[]> {
  const { Link } = ctx.models;

  return async function paramValues(): Promise<ParamKeyStat[]> {
    const [keyRows, valueRows] = await Promise.all([
      Link.aggregate<{ _id: string; count: number }>([
        ...PAIRS,
        { $group: { _id: { k: '$pairs.k', l: '$_id' } } },
        { $group: { _id: '$_id.k', count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
        { $limit: MAX_KEYS },
      ]).option({ maxTimeMS: MAX_TIME_MS, allowDiskUse: true }),
      Link.aggregate<{ _id: string; values: Array<{ value: string; count: number; lastUsedAt: Date }> }>([
        ...PAIRS,
        // A link repeating a key=value counts once for that value.
        { $group: { _id: { k: '$pairs.k', v: '$pairs.v', l: '$_id' }, updatedAt: { $first: '$updatedAt' } } },
        { $group: { _id: { k: '$_id.k', v: '$_id.v' }, count: { $sum: 1 }, lastUsedAt: { $max: '$updatedAt' } } },
        { $sort: { count: -1, '_id.v': 1 } },
        {
          $group: {
            _id: '$_id.k',
            values: { $push: { value: '$_id.v', count: '$count', lastUsedAt: '$lastUsedAt' } },
          },
        },
        // One past the cap, so "more exist" is known without returning them.
        { $project: { values: { $slice: ['$values', VALUES_PER_KEY + 1] } } },
        { $limit: MAX_KEYS },
      ]).option({ maxTimeMS: MAX_TIME_MS, allowDiskUse: true }),
    ]);

    const byKey = new Map(valueRows.map((r) => [r._id, r.values]));
    const items: ParamKeyStat[] = [];
    for (const row of keyRows) {
      const values = byKey.get(row._id);
      if (!values) continue;
      items.push({
        key: row._id,
        count: row.count,
        values: values.slice(0, VALUES_PER_KEY),
        truncated: values.length > VALUES_PER_KEY,
      });
    }
    return items;
  };
}
