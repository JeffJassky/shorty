import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Vite defines `__dirname` when it bundles a config file, but this package is
// `"type": "module"` and the same file is read by `tsc` for the typecheck,
// where it is genuinely absent. Derive it instead of relying on the shim.
const here = path.dirname(fileURLToPath(import.meta.url));

// `base: './'` keeps every asset reference relative. The server injects a
// `<base href="<mountPath>/">` into index.html at request time, so one build
// works at any mount path — unlike a baked-in absolute base, which forces a
// rebuild per host. See standards/traps.md #8.
export default defineConfig({
  root: here,
  plugins: [react()],
  base: './',
  build: {
    outDir: path.resolve(here, '../../dist/ui'),
    emptyOutDir: true,
    assetsDir: '_assets',
    sourcemap: true,
  },
  server: {
    port: 5174,
    proxy: {
      '/api/shorty': 'http://localhost:3000',
    },
  },
});
