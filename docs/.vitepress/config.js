import { defineConfig } from 'vitepress';

// THIS FILE IS THE ONE THAT DISAPPEARS.
//
// A bare `config.js` in a global gitignore silently excluded this from
// featureboard's first push. VitePress builds fine without it, so the site
// deployed with no nav and the workflow reported success. Nothing caught it.
// `npm run check-tracked` is what catches it now — see standards/traps.md #1.

export default defineConfig({
  title: 'shorty',
  description: 'Self-hosted short links for Express + MongoDB: UTM builder, click analytics, React admin UI',
  base: '/shorty/',
  lastUpdated: true,
  cleanUrls: true,
  head: [
    ['meta', { name: 'theme-color', content: '#0d9488' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'shorty' }],
    ['meta', { property: 'og:description', content: 'Self-hosted short links for Express + MongoDB: UTM builder, click analytics, React admin UI' }],
  ],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/introduction' },
      { text: 'Reference', link: '/reference/factory' },
      { text: 'GitHub', link: 'https://github.com/JeffJassky/shorty' },
    ],
    // Every link below must resolve to a real page — VitePress fails the build
    // on a dead link, which is the feature. traps #13.
    sidebar: {
      '/guide/': [
        {
          text: 'Getting started',
          items: [
            { text: 'Introduction', link: '/guide/introduction' },
            { text: 'Quickstart', link: '/guide/quickstart' },
            { text: 'Requirements', link: '/guide/requirements' },
          ],
        },
        {
          text: 'Using shorty',
          items: [
            { text: 'Mounting & route order', link: '/guide/mounting' },
            { text: 'Configuration', link: '/guide/configuration' },
            { text: 'Slugs & renaming', link: '/guide/slugs' },
            { text: 'UTM & parameters', link: '/guide/utm' },
            { text: 'Admin UI', link: '/guide/ui' },
          ],
        },
        {
          text: 'Going deeper',
          items: [
            { text: 'Click analytics & privacy', link: '/guide/analytics' },
            { text: 'Hooks & telemetry', link: '/guide/hooks' },
            { text: 'Link previews & SSRF', link: '/guide/inspect' },
            { text: 'Scaling notes', link: '/guide/scaling' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'API',
          items: [
            { text: 'Factory & instance', link: '/reference/factory' },
            { text: 'HTTP API', link: '/reference/http' },
            { text: 'Client', link: '/reference/client' },
            { text: 'Types', link: '/reference/types' },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/JeffJassky/shorty' }],
    editLink: {
      pattern: 'https://github.com/JeffJassky/shorty/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Jeff Jassky',
    },
    search: { provider: 'local' },
  },
});
