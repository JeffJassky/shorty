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
    ['meta', { name: 'theme-color', content: '#2563eb' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'shorty — Shorty' }],
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
            { text: 'Configuration', link: '/guide/configuration' },
          ],
        },
        {
          text: 'Integrating',
          items: [
            { text: 'The user adapter', link: '/guide/user-adapter' },
            { text: 'The UI', link: '/guide/ui' },
            { text: 'Data model', link: '/guide/data-model' },
          ],
        },
        {
          text: 'Operating',
          items: [
            { text: 'Account deletion', link: '/guide/account-deletion' },
            { text: 'Testing', link: '/guide/testing' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'API',
          items: [
            { text: 'createShorty', link: '/reference/factory' },
            { text: 'Routers', link: '/reference/routers' },
            { text: 'UI routers', link: '/reference/ui-routers' },
            { text: 'Client', link: '/reference/client' },
            { text: 'Model factory', link: '/reference/model' },
          ],
        },
        {
          text: 'HTTP',
          items: [
            { text: 'Public API', link: '/reference/http-public' },
            { text: 'Admin API', link: '/reference/http-admin' },
          ],
        },
        {
          text: 'Types',
          items: [{ text: 'Types & payloads', link: '/reference/types' }],
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
      copyright: 'Copyright © __YEAR__ Jeff Jassky',
    },
    search: { provider: 'local' },
  },
});
