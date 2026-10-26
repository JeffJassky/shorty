# Types & payloads

Hand-written declarations in `types/`, shipped in the published package and
checked by `tsc --noEmit` in CI.

```ts
import type { CreateShortyConfig, ShortyInstance, PackageUser } from '@jeffjassky/shorty';
import type { ShortyClient, ClientOptions } from '@jeffjassky/shorty/client';
```

## Why hand-written

The source is TypeScript, so declarations *could* be generated — and are not, on
purpose. Generated `.d.ts` files publish whatever the internals happen to infer:
every widened union, every incidental `Omit<>`, every private helper's shape
leaking into the public surface. A curated declaration is a decision about what
shorty promises; an inferred one is a description of what it currently does.

The two are kept in step by the direction of the imports: `src/` imports these
types rather than exporting its own. `createLinkModel` returns
`Model<LinkDoc>` *because this file says so*, so a schema field with no
declaration here fails `npm run typecheck` in the source. `types/test-d.ts` then
exercises the same surface from outside, the way you consume it.

They also rot instantly — which is why `types/test-d.ts` exercises every
exported symbol and runs in CI. On the package this template came from, that
file caught four features missing from `types/` on the afternoon they were
added. If you add an export, add it there in the same commit.

## Core

| Type | |
|---|---|
| `CreateShortyConfig` | Everything you can pass to the factory |
| `ShortyInstance` | What it returns |
| `PackageUser` | `{ id, email, displayName?, isAdmin? }` |
| `ResolveUser` | `(req) => PackageUser \| null` |
| `UserAdapter` | `{ resolveUser }` |
| `StorageAdapter` | `{ put, get, delete, signUrl }` |
| `UiOptions` | Options for `ui()` / `adminUi()` |
| `Logger` | `{ debug?, info?, warn?, error? }` |
| `PurgeSummary` | `{ removed }` |
| `HttpError` | `status`, `code`, `details?` |

## Client

| Type | |
|---|---|
| `ShortyClient` | `me`, `list`, `get`, `call` |
| `ShortyAdminClient` | the above plus `summary` |
| `ClientOptions` | `{ baseUrl?, request?, onUnauthenticated? }` |
| `RequestFn` | `(method, url, body?) => Promise<any>` |
| `MeResponse` / `ListResponse<T>` / `ItemResponse<T>` | payload shapes |

## `id` is a string or an ObjectId

`PackageUser['id']` accepts both, so a host storing ids as strings doesn't have
to cast at every call site.
