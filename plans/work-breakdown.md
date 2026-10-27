# shorty — work breakdown (Stage 4)

Per `foundry/standards/working-style.md` → Execution tiers. PR 0 (this contract)
is frontier-authored. PRs 1–6 are Sonnet, one agent per PR, worktree-isolated,
branched from and merged into `build/0.1`. `main` receives `build/0.1` once the
end reviews pass.

**Rules for every implementation PR**

- The contract is `types/`, `src/shared/`, `src/server/models.ts`,
  `src/server/config.ts`, `test/`. **Do not edit any of them.** If a test or a
  type looks wrong, stop and report — do not "fix" it.
- Make the named tests green. Do not skip, loosen, or delete a test.
- `npm run typecheck && npm run build && npm test` before handing back; report
  which test files are green and which are still red *only* because a later PR
  owns them.
- No new runtime dependency beyond the ones named in your task.
- Never `git stash` in a worktree. Commit on your branch; open a PR into
  `build/0.1`.

**Per-PR review (Sonnet, once):** scope creep · contract files touched · tests
weakened/skipped · untested paths added · docs/CHANGELOG · `console.log`/TODO.

---

## PR 1 — slugs, link service, lifecycle

- **Files:** `src/server/slug.ts` (normalize, validate, reserved, generate,
  claim/release against `models.Slug`), `src/server/links.ts` (create, update,
  archive, delete, link, links, history, tags, recount, checkSlug,
  generateSlug), `src/server/lifecycle.ts` (`ready()`: `syncIndexes` on every
  model, click/seen TTL reconcile via `collMod`, case-mode re-key with
  `case_collision`), `src/server/hooks.ts` (awaited-and-caught hook + track
  runner, `hookFailures` counter), wire into `src/server/index.ts`.
- **Contract:** `types/index.d.ts` — `Link`, `LinkInput`, `LinkPatch`,
  `HistoryEntry`, `SlugCheck`, `RenameMode`, `ShortyError` codes; plan §7.1,
  §7.3.
- **Tests green:** `test/url.test.ts`, `test/config.test.ts`,
  `test/links.test.ts` (except cases that click through `redirect` — those go
  green in PR 2), `test/ui.test.ts`.
- **Invariants:** `models.Slug` is the only uniqueness authority — claim by
  insert, duplicate-key = taken, release on delete / `always` rename. `keys` on
  the link always equals current key + alias keys. A history entry is written
  only when the composed destination string changes. Every write that fails
  half-way (slug claimed, link insert fails) releases what it claimed.
- **Non-goals:** redirect, clicks, inspect, HTTP routes.

## PR 2 — redirect router + click pipeline

- **Files:** `src/server/redirect.ts`, `src/server/clicks.ts` (classify, hash,
  seen, insert, rollup, counters), `src/server/ua.ts`, `drain()` / `health()`
  in `src/server/index.ts`.
- **Deps:** `isbot` (MIT), `ua-parser-js@^1` (**pinned < 2** — v2 is AGPL).
- **Contract:** plan §7.2, §7.5; `Click`, `ClickEvent`, `RedirectConfig`,
  `ClickConfig`, `ShortyHealth`.
- **Tests green:** `test/redirect.test.ts`, `test/clicks.test.ts`, remaining
  `test/links.test.ts`.
- **Invariants:** the response is sent before any tracking work starts;
  nothing in the pipeline can change the response; no IP is persisted in any
  form other than the HMAC; uniqueness is decided by `at` against the window,
  never by waiting for TTL deletion; a non-slug path (has `.`, empty, too long,
  reserved) calls `next()` without a query. The router is `router.use` + an
  explicit GET/HEAD check — `router.get` would let Express auto-answer OPTIONS.
  `ua-parser-js@1` and `isbot('')` behaviour must be verified against the
  device/bot tests (an empty UA is a bot even though `isbot('')` is false).
- **Non-goals:** stats aggregation, routes.

## PR 3 — inspect (safe fetch, OG, warnings)

- **Files:** `src/server/inspect/safe-fetch.ts`, `src/server/inspect/og.ts`,
  `src/server/inspect/index.ts`.
- **Deps:** none beyond Node (`node:http`, `node:https`, `node:net`). A small
  `<head>` tokenizer is in scope; `htmlparser2` allowed if it saves real code.
- **Contract:** plan §7.6; `InspectResult`, `InspectWarning*`, `InspectConfig`,
  `ScreenshotAdapter`.
- **Tests green:** `test/inspect.test.ts`.
- **Invariants:** every hop resolves DNS once and connects to the checked
  address (custom `lookup` on the agent), never re-resolving; fail closed on DNS
  error; stop reading at `</head>` or `maxBytes`; one overall deadline; never
  throws for network reasons.
- **Non-goals:** caching OG on links (PR 4 stores `og` when the form saves).

## PR 4 — admin routes, stats, params catalog

- **Files:** `src/server/routes.ts`, `src/server/stats.ts`,
  `src/server/params.ts`.
- **Contract:** route table in `types/client.d.ts`; `Stats`, `StatsQuery`,
  `ParamKeyStat`; plan §7.4, §8 analytics.
- **Tests green:** `test/routes.test.ts`, `test/stats.test.ts`. Whole suite
  green after this PR.
- **Invariants:** literal routes declared before `/:id`; every handler wrapped
  (JSON on failure); no body parser; every aggregation has `maxTimeMS` and a
  cap; humans and bots never summed server-side.

## PR 5 — SPA: list, create/edit form, anatomy, previews

- **Spec:** [ui-spec.md](./ui-spec.md) §0–2, §4–8 — every screen, copy line,
  tooltip and test is settled there.
- **Files:** `src/ui/**`, `test/e2e/**`. Copy (do not import) mailery's tokens,
  `Tip` + `place-tip`, icons; accent swap to teal per plan §8.
- **Tests:** Playwright happy paths (create auto/custom slug, paste URL splits
  into fields, combobox suggestions, rename confirm per mode, archive).
- **Non-goals:** analytics screens.

## PR 6 — SPA analytics + overview; docs; CHANGELOG

- **Files:** `src/ui/**` analytics, `docs/**`, `README.md`, `CHANGELOG.md`.
- **Done when:** `/audit shorty` passes.

## End reviews (frontier, on integrated `build/0.1`)

1. Redirect hot path — never fails, never leaks, root-mount safety.
2. Safe-fetch SSRF.
3. Rename modes + slug claims under concurrency, revisions, human/bot counter
   integrity.

## PR 9 — inspect hardening (end review (b) follow-ups)

- **Files:** `src/server/inspect/safe-fetch.ts`, `src/server/inspect/index.ts`
  only. Do not touch `types/` or `test/` — the contract is settled.
- **Contract:** `InspectConfig.isAllowedAddress` doc (the default table) and
  `ScreenshotAdapter` in `types/index.d.ts`.
- **Tests green:** `test/inspect.test.ts` › "End review (b) follow-ups" (18 red
  now), whole suite green, `npm run typecheck` green. Today typecheck fails at
  exactly one place, `src/server/inspect/index.ts` (the adapter call passes
  one argument); fixing item 3 fixes it.
- **Work:**
  1. **Head-stop re-parse must be linear.** In `requestHop`'s `data` handler,
     keep the cheap `</head`/`<body` pre-filter, but call `parseHead` only when
     the buffered size has at least doubled since the last parse
     (`let parsedAt = 0; … && size >= parsedAt * 2) { parsedAt = size; … }`).
     `index.ts` parses the full head at the end anyway, so nothing is lost.
     Without this, one destination freezes the event loop for 6–100 s.
  2. **Default address table.**
     - v4: also refuse 192.88.99.0/24.
     - v6: after the `::ffff:0:0/96` (v4-mapped) check, refuse everything
       outside 2000::/3 except 64:ff9b::/96 (judged by its embedded v4) —
       this also refuses `::a.b.c.d` (drop the "deprecated v4-compatible"
       branch), `::ffff:0:a.b.c.d`, 100:0:0:1::/64, 5f00::/16 and unallocated
       space. Inside 2000::/3 also refuse 2001:2::/48, 2001:10::/28,
       2001:20::/28 and 3fff::/20 (keep Teredo, 2001:db8::/32, 6to4 rules).
  3. **Screenshot adapter context.** `safeFetch` returns the final hop's
     checked `addresses`; `index.ts` calls `shoot(final.url, { addresses })`.
- **Invariants:** unchanged — resolve once per hop, connect only to checked
  addresses, `agent: false` (the proxy-env regression test pins this), one
  deadline, never throws for network reasons.
- **Reference:** a scratch implementation of exactly items 1–3 turned all 128
  inspect tests and typecheck green.

## PR 7 — integrity fixes (from end review (c))

Contract and red tests are already on `pr7-integrity`; this PR makes them green
without editing them.

- **Files:** `src/server/links.ts`, `src/server/lifecycle.ts`,
  `src/server/clicks.ts`, `src/server/slug.ts` (only if a helper is needed),
  `src/server/stats.ts` (overview must not count orphans, if the re-check
  below is not enough). Do NOT edit `types/`, `src/server/models.ts` or `test/`.
- **Contract:** `types/index.d.ts` — `LinkDoc.wv`, `LinkDoc.ck`, `MetaDoc`
  (advisory), `SlugConfig.caseSensitive`, `LinkPatch` (case-only slug change),
  `ShortyInstance.ready` / `updateLink` / `deleteLink` / `recount` docs. Schema
  fields are in `models.ts` (`wv` default 1, `ck` no default).
- **Tests green:** `test/integrity.test.ts` (17; 16 red at hand-off, 1 guard
  green). Whole suite stays green.
- **Invariants:**
  1. **`wv` pin.** Every write to a link's own fields `$inc`s `wv` (create
     sets 1 and stamps `ck` from config; update; archive/unarchive when the
     state actually changes; re-key). `updateLink` filters on
     `{ _id, wv: doc.wv }` (replacing the slugKey/destination pin); a
     zero-match releases its claim and re-plans. For an `untilClicked` rename
     also pin `clicks: 0`, so the first human click (which never bumps `wv`)
     still locks. History `rev` then equals the rev written (doc.rev + 1 under
     the pin). Clicks never touch `wv`.
  2. **Ownership-confirmed release.** On ANY error after a claim (create or
     rename), release the claim only after confirming the link does not hold
     the key (`Link.exists({ _id, keys: key })` is null). A network error /
     timeout may mean the write landed. In create's cleanup, delete the Link
     first and release only if that delete succeeded (no parallel
     `allSettled`).
  3. **Case-only slug change** (`caseSensitive: false`, same key, different
     display): `$set slug` only — no claim change, no alias, no history entry,
     never `slug_locked` in any mode. Still bumps `wv`.
  4. **`ck` re-key filter with snapshot-matched writes.** `ready()` re-keys
     `{ ck: { $ne: configured } }` on EVERY boot, ignoring Meta for the
     decision (still write Meta, advisory). The collision check must consider
     ALL links' keys under the target mode (links already at the target mode
     included), not only the re-keyed ones. Each Link re-key write filters on
     the scanned snapshot (`_id`, `wv`) and `$inc`s `wv` and sets `ck`; a
     zero-match link is re-read and recomputed (loop until it matches or is
     gone). Upsert new claims before dropping old ones, and run the stale-claim
     `deleteMany` only for links whose write matched. Re-running after a crash
     converges.
  5. **Pipeline order `Link $inc → Daily → Click`, with a post-write existence
     re-check.** After the Click row is written, if `Link.exists({ _id })` is
     null, delete that Click row and every Daily row for the linkId. So a
     partial failure leaves `raw ≤ daily ≤ link counter`, and `recount` (from
     Daily) never drops below raw rows.
  6. **deleteLink final sweep / writers re-check.** An update whose link
     vanished after its write removes the history (and claim) rows it wrote,
     i.e. re-check existence after the history insert and clean up; deleteLink
     keeps its existing order (Link → Slug → the rest).
  7. **Dotted `$set` for `redirect`.** Patch `redirect.status` /
     `redirect.forwardQuery` as dotted paths (`$unset` for `null`), never the
     whole object from a stale read. The `wv` pin also covers this; do both.
- **Non-goals:** transactions / replica-set requirements; changing the redirect
  hot path; known deferred items beyond those above (post-swap demotion and the
  history insert remain separate steps, now protected by the re-check).
