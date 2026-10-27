---
layout: home

hero:
  name: shorty
  text: Short links, inside your app
  tagline: "Self-hosted short links for Express + MongoDB: UTM builder, click analytics, React admin UI"
  actions:
    - theme: brand
      text: Quickstart
      link: /guide/quickstart
    - theme: alt
      text: Introduction
      link: /guide/introduction
    - theme: alt
      text: GitHub
      link: https://github.com/JeffJassky/shorty

features:
  - title: Embedded, not external
    details: Install the package, mount three routers, done. Links, clicks and rollups live in your MongoDB. Nobody signs in to a third-party service.
  - title: Your auth, not ours
    details: The admin API and UI are plain Express routers. You put your own guard in front of them; shorty never authenticates anyone.
  - title: A form that helps
    details: Paste a URL and it splits into UTM fields and parameters. Suggestions come from your existing links, near-duplicates are flagged, and previews show how the link will look.
  - title: Honest analytics
    details: No raw IPs, a visitor hash that rotates daily, and bots counted apart from people so you can hide, separate or include them.
---
