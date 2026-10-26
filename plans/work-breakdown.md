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
  reserved) calls `next()` without a query.
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

- **Files:** `src/ui/**`. Copy (do not import) mailery's tokens, `Tip` +
  `place-tip`, icons, shell; accent swap to teal per plan §8.
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
