---
"cast-cli": patch
"cast-tui": patch
---

fix(docs): site renders at the GitHub Pages project URL with working links

The static documentation site at `https://<owner>.github.io/<repo>/` was
deploying with `base: '/'`, so every URL Astro produced (CSS, sidebar
nav, card links, in-content cross-links) pointed at the *host* root
instead of `/<repo>/`. The result on the live site: unstyled content,
CSS 404s, and broken navigation.

What changed:

- **Base path now flows into the build.** The `docs` workflow sets
  `PUBLIC_SITE_BASE=/${{ github.event.repository.name }}/` and
  `PUBLIC_SITE_URL=https://${{ github.repository_owner }}.github.io/${{ github.event.repository.name }}`
  from the GitHub context, so renames don't require code changes. Astro's
  `base` config picks them up via the existing `process.env` defaults in
  `astro.config.mjs`.
- **`<base>` tag in the layout.** `src/layouts/Docs.astro` emits
  `<base href={import.meta.env.BASE_URL}>`, so authors can write
  `href="getting-started/install"` (base-relative) and the browser
  rewrites it against the configured base. Absolute paths in HTML,
  external links, and anchors are unaffected.
- **All internal links are now base-relative.** The sidebar, the home
  page, the 404 page, the CLI reference page, the `ManifestBadge`
  component, the `{% ref %}` resolver in `src/lib/links.ts`, and all
  cross-links in `content/**/*.md` (21 hand-written links) drop the
  leading slash. The sidebar's `isCurrent` check is base-aware.
- **Docs README updated** with a "Deploying to a sub-path" section
  explaining `PUBLIC_SITE_BASE` / `PUBLIC_SITE_URL` and the `<base>`
  convention, so future contributors don't reintroduce absolute paths.

Verified locally with a static server mimicking the `/<repo>/` URL
prefix: all 12 representative pages return 200, the active sidebar item
highlights correctly on every page, and 404s are returned for pages
that don't exist.
