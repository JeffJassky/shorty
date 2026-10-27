# UTM & parameters

A link's destination is stored as structured parts:

```ts
{
  baseUrl: 'https://acme.com/sale',           // scheme + host + path, no ? or #
  utm: { source: 'instagram', medium: 'social', campaign: 'spring' },
  params: [{ key: 'ref', value: 'bio' }],     // other query params, ordered
  hash: 'offers',                             // without the #
}
```

`destination` is the composed string, kept denormalized because it is what the
redirect reads.

## Parse and compose

Two pure helpers are exported and shared by server and browser:

```js
import { parseUrl, composeUrl } from '@jeffjassky/shorty';

const parts = parseUrl('https://acme.com/sale?utm_source=ig&ref=bio#offers');
composeUrl(parts);   // https://acme.com/sale?utm_source=ig&ref=bio#offers
```

- UTM fields are `source, medium, campaign, term, content, id` (exact,
  lowercase `utm_*` keys). The **first** occurrence fills the field; later
  duplicates stay in `params`, so nothing is lost.
- Compose order is fixed: UTMs, then `params` in array order, then `#hash`.
  Empty UTM fields are omitted. Keys and values use `encodeURIComponent`.
- `parseUrl` throws `invalid_url` for non-URLs or URLs with credentials, and
  `unsupported_scheme` for anything but http(s).

When creating a link, give the destination either as `url` **or** as
`baseUrl` + `utm` + `params` + `hash`. Both is `ambiguous_destination`.

## Revisions

Changing the composed destination bumps `rev` and writes a history entry.
Retyping the same UTM is not a revision. Each click records the `rev` it was
served under, so clicks per destination period is a group-by.

## Suggestions

`shorty.paramValues()` (`GET /params`) returns a live catalog:

```ts
[{ key: 'utm_source', count: 41, truncated: false,
   values: [{ value: 'instagram', count: 41, lastUsedAt }] }]
```

It is one aggregation over all links (archived included), with `maxTimeMS` and
at most 50 values per key. The admin form fetches it once per open and uses it
for dropdowns and for the near-duplicate lint: typing `Instagram` when
`instagram` is already used by 41 links offers a one-click fix. That drift is
the main way UTM data rots.

The catalog needs MongoDB 5.2+ (`$firstN`).

## Forwarding incoming parameters

With `redirect.forwardQuery` (default true), parameters on the short URL are
appended to the destination before the `#hash`. An incoming key replaces every
occurrence of that key in the destination, repeated incoming keys all
forward, and `qr` is stripped. Per-link `redirect.forwardQuery` overrides.
