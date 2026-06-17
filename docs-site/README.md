# cast-docs

Static documentation site for [Cast](https://github.com/scott/castagent).
Built with [Astro](https://astro.build), deployed to GitHub Pages.

## What this site is

Two kinds of pages:

1. **Reference** — auto-generated from the Cast source code.
   - `/cli/reference` — every `cast <command>`, parsed from `typescript/cast-cli/src/commands/`.
   - `/tui/slash-commands` — every `/command`, parsed from `typescript/cast-tui/src/commands/slash-registry.ts`.
   - `/deployment/providers` — every provider, parsed from `typescript/cast-cli/src/commands/deploy.ts`.
   - `/changelog` — every release, parsed from `CHANGELOG.md`.

   These regenerate on every build and cannot drift from the code.

2. **Prose** — hand-written Markdown in `content/`. Cross-links use `{% ref "..." %}` tags that resolve against the manifest.

## Local development

```bash
# From this directory:
npm install
npm run dev      # starts Astro dev server with extraction run first
```

Or from the repo root:

```bash
npm --prefix docs-site install
npm --prefix docs-site run dev
```

## Build

```bash
npm run build
# outputs to dist/ — deploy this to GitHub Pages
```

The `prebuild` script runs all `extract-*` scripts first, then the snapshot script writes `data/manifest.json` and validates the previous manifest.

## CI sync

`scripts/validate-manifest.ts` exits non-zero when:

- the regenerated manifest differs from the committed one (intentional — surfaces added/removed commands in PRs),
- a `{% ref %}` tag in a prose page targets a command that no longer exists.

The `.github/workflows/docs.yml` workflow runs `npm run check` on every PR and on pushes to `master`. It comments the manifest diff on the PR and deploys `dist/` to GitHub Pages on `master`.

## Adding a new docs page

1. **Reference page for a new command** — nothing to do; the extraction picks it up. Just make sure the prose `{% ref %}` link resolves (manifest will be updated on the next build).
2. **Prose page** — drop a `.md` (or `.mdx`) file in `content/<section>/<slug>.md`. Add a `title` and `description` to the frontmatter; the sidebar nav picks it up automatically via the collection schema.
3. **New top-level section** — add a new content collection in `src/content.config.ts`, add a sidebar entry in `src/components/Sidebar.astro`.

## Layout

```
docs-site/
├── astro.config.mjs
├── package.json
├── tsconfig.json
├── public/                 # static assets (logo, etc.)
├── src/
│   ├── components/         # CommandRef, SlashRef, ProviderCard, Sidebar, …
│   ├── content.config.ts   # content collection schemas
│   ├── layouts/Docs.astro  # sidebar + content + TOC
│   ├── lib/                # manifest loader, link resolver
│   ├── pages/              # /, /cli/reference, /tui/slash-commands, …
│   └── styles/global.css
├── content/                # hand-written prose (Markdown/MDX)
├── scripts/                # extract-cli, extract-slash, extract-providers, extract-changelog, snapshot-manifest, validate-manifest
└── data/                   # generated JSON (gitignored except manifest.json)
```
