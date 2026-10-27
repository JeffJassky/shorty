# Hooks & telemetry

## Hooks

All hooks are optional and **awaited and caught**: a throw is logged, counted
in `health().hookFailures`, and never fails a write or a redirect.

| Hook | When | Payload |
|---|---|---|
| `onClick` | after the redirect is sent; bots included, flagged | `{ link, click, req }` |
| `onCreate` | before `createLink` resolves | `{ link, actor?, req? }` |
| `onUpdate` | before `updateLink` resolves | `{ link, prev, history, actor?, req? }` (only the history entries this update wrote) |
| `onArchive` | archive and unarchive | `{ link, archived, actor?, req? }` |
| `onDelete` | before `deleteLink` resolves | `{ link, summary, actor?, req? }` |
| `onMiss` | an unknown slug was requested | `{ path, req }` |

`onClick` is not called when recording is off or the hit was expired (no click
exists). `onMiss` fires for every `redirect.onMiss` mode; paths that cannot be
slugs are not misses.

```js
createShorty({
  // ...
  onClick: ({ link, click }) => warehouse.insert({ slug: link.slug, bot: click.bot }),
  onCreate: ({ link, actor }) => audit.log('link.created', link.id, actor?.id),
});
```

Use hooks to send your own webhooks; there is no built-in signed transport.

## `track`

`track(name, { attrs, data, subjects })` is structurally the `track` of a
[`@jeffjassky/telemetry`](https://github.com/JeffJassky/telemetry) client, so
you can pass `telemetry.track` directly, or any function with that shape. It
is a no-op by default, and not a peer dependency.

Event names, each with `subjects: [{ type: 'shorty_link', id }]`:

`shorty.link_created`, `shorty.link_updated`, `shorty.link_archived`,
`shorty.link_unarchived`, `shorty.link_deleted`, `shorty.clicked`.

## `health()` and `drain()`

```js
shorty.health();
// { clickFailures, hookFailures, misses, inFlight, clicksEnabled }
```

| Field | Meaning |
|---|---|
| `clickFailures` | Click pipelines that failed after the redirect was sent. |
| `hookFailures` | Hooks and `track` calls that threw or rejected. |
| `misses` | Unknown-slug requests. |
| `inFlight` | Click pipelines still running. |
| `clicksEnabled` | False with no pepper or `clicks: false`. |
| `dropped` | **0.1.** Hits not recorded because `clicks.maxInFlight` was reached. |

Export these to your own metrics. A rising `clickFailures` means analytics are
losing data while redirects keep working.

`await shorty.drain()` resolves when every in-flight click and miss pipeline
has finished, including your `onClick` and `onMiss`. Call it on shutdown and
in tests. A hook that never settles keeps `drain()` waiting.
