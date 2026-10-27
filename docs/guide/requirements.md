# Requirements

| | Supported |
|---|---|
| Node.js | 20 or later |
| MongoDB | 5.2 or later (the parameter catalog uses `$firstN`) |
| mongoose | 7, 8 or 9 (peer dependency; CI runs the full suite on all three) |
| Express | 4.18+ or 5 (peer dependency) |

Runtime dependencies: `isbot` (MIT) and `ua-parser-js` pinned to 1.x (2.x is
AGPL). The admin UI is a prebuilt bundle; React and the QR library are not
runtime dependencies of your app.

shorty ships ESM and CommonJS builds and typed declarations
(`@jeffjassky/shorty` and `@jeffjassky/shorty/client`).
