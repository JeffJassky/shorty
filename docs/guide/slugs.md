# Slugs & renaming

## Grammar

After accent stripping (NFKD, so `Café` becomes `Cafe`) and trimming leading
and trailing `/`, a slug is one or more segments of `[A-Za-z0-9_-]+` joined by
a single `/`, at most 190 characters. Slashes are allowed (`spring/ig`).
Anything else (dots, spaces, `?`, `#`, `//`, empty) is `slug_invalid`; over
190 is `slug_too_long`.

Omit `slug` on create to get a generated one: 7 characters from
`23456789abcdefghjkmnpqrstuvwxyz` (no `0 1 i l o`). Tune with `slug.length`,
`slug.alphabet`, or replace with `slug.generate` (still validated and
collision-checked).

## Case

`slug.caseSensitive` defaults to `false`: `/Spring` and `/spring` are one
link, and the display form keeps the case as entered. Set it before your first
link. Flipping it later re-keys existing links in `ready()`, and a flip that
would merge two links throws `case_collision` naming both and changes nothing.

::: warning Rolling deploys across a flip
Every link records the mode its keys were written under, and every `ready()`
re-keys links written under the other mode. During a rolling deploy, links
written by the other mode are unreachable by lookups until the next boot, and
the fleet converges on the mode of the *last instance to boot*. Flip the mode
with a short maintenance window, or restart every instance after the rollout.
:::

## Renaming: four modes

`slug.rename` is operator config, not an end-user choice.

| Mode | Behaviour |
|---|---|
| `alias` (default) | Rename any time. Every old slug keeps redirecting forever. History lists each rename. |
| `untilClicked` | Rename until the first human click, then `409 slug_locked`. |
| `always` | Rename any time. The old slug is freed and **breaks** anything that used it. The UI asks for confirmation. |
| `never` | Fixed at creation. Every rename is `slug_locked`. |

`alias` is the only mode that cannot break a printed or posted link, hence the
default. A "rename" to the same key is not a rename, and a case-only change
(`spring` to `Spring`, under case-insensitive mode) just updates the display
slug in every mode.

Uniqueness is decided by a claim collection (`shorty_slugs`) across current
slugs *and* aliases, so a race between two creators or renamers cannot give
two links one slug. Deleting a link frees all its keys.

## Checking

`shorty.checkSlug(slug)` returns `{ slug, available, reason? }` where the
reason is `invalid`, `too_long`, `reserved` or `taken`. The UI uses it live.
