# cast-docs

Static documentation site for [Cast Agent](https://github.com/scott/castagent). The public site is [castagent.dev](https://castagent.dev).
Built with [Astro](https://astro.build), deployed to GitHub Pages.

## What this site is

The site root (`/`) is a one-page landing page: what Cast Agent is, the install
command, and every deployment provider. It links to the GitHub repo and to
the docs. The docs overview that used to live at `/` is at `/overview`,
linked from the sidebar.

Two kinds of pages:

1. **Reference** — auto-generated from the Cast Agent source code.
   - `/cli/reference` — every `cast <command>`, parsed from `typescript/cast-cli/src/commands/`.
   - `/tui/slash-commands` — every `/command`, parsed from `typescript/cast-tui/src/commands/slash-registry.ts`.
   - `/deployment/providers` — every built-in provider, read from `typescript/cast-cli/src/lib/deploy/providers.manifest.json`.
   - `/changelog` — every release, parsed from `CHANGELOG.md`.

   These regenerate on every build and cannot drift from the code.

2. **Prose** — hand-written Markdown in `content/`. Cross-links use `{% ref "..." %}` tags that resolve against the manifest. Both single- and double-quoted forms are accepted (``{% ref "cli:edit" %}`` and ``{% ref 'cli:edit' %}``); the build resolves them to clickable links pointing at the matching reference page. Tags written in backticks keep their code styling — the link wraps the `<code>` element.

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

### Deploying

The public site is [castagent.dev](https://castagent.dev). GitHub Pages serves
that custom domain from the site root, so the build uses base `/`. Two env
vars control this:

| Env var             | Default              | Purpose                                                                |
|---------------------|----------------------|------------------------------------------------------------------------|
| `PUBLIC_SITE_URL`   | `https://castagent.dev` | The full site origin. Used for canonical / og: URLs.                |
| `PUBLIC_SITE_BASE`  | `/`                  | The URL sub-path the site is served from. Sets Astro's `base` config.  |

The `docs` workflow in `.github/workflows/docs.yml` sets both for production:

```yaml
env:
  PUBLIC_SITE_BASE: /
  PUBLIC_SITE_URL: https://castagent.dev
```

`docs-site/public/CNAME` contains `castagent.dev`, which GitHub Pages reads
from the deployed files and keeps as the custom domain. `CNAME` stays only at
the site root. Snapshot archives do not include it.

`/` is the current docs, built from `master` and labeled with the version in
the root `package.json`. `/vX.Y.Z/` is a frozen snapshot of a published product
release (`vX.Y.Z`, not `cast-cli@*` or `cast-tui@*`). The snapshot is built
once when that GitHub release is published, attached as `docs-vX.Y.Z.tar.gz`,
and copied back into the site on every docs deploy. Later deploys do not
rebuild it. While a version is still the latest package version, it is served
at `/` and is not also copied to `/vX.Y.Z/`.

Every master deploy also writes two files at the site root, not under a
version prefix:

- `/versions.json` — the current version, then frozen releases newest first
- `/version-picker.js` — the version control next to the logo

The picker reads `/versions.json` at runtime and navigates with the absolute
`href` values in that file. Archived pages load the script from
`/version-picker.js` for the same reason: a relative URL would be rewritten by
`<base href="/vX.Y.Z/">`.

`.github/workflows/docs-snapshot.yml` runs when a release is published. For a
tag matching `vX.Y.Z` whose commit contains `docs-site/`, it checks out the
tag, builds with `PUBLIC_SITE_URL=https://castagent.dev` and
`PUBLIC_SITE_BASE=/vX.Y.Z/`, drops `CNAME`, and uploads `docs-vX.Y.Z.tar.gz`.
That workflow needs `contents: write` so it can attach the asset. The master
docs workflow only reads those assets. After it builds the current site into
`dist/`, it downloads every retained `docs-v*.tar.gz` and unpacks it to
`dist/vX.Y.Z/`, skipping the version that is currently latest. A docs-only
push still deploys the current site and the frozen snapshots. Dropping the
unpack step would erase history.

The layout (`src/layouts/Docs.astro`) emits a `<base href={BASE_URL}>` tag and
all internal links are written as **base-relative** paths (e.g.
`href="getting-started/install"`, not `href="/getting-started/install"`).
Keep new links base-relative. A sub-path deploy still works by setting
`PUBLIC_SITE_BASE` to that path, for example `/castagent/`. The version picker
is the exception: its script and its version links are absolute site paths.

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
│   ├── components/         # CommandRef, SlashRef, ProviderCard, Sidebar, VersionPicker, …
│   ├── content.config.ts   # content collection schemas
│   ├── layouts/Docs.astro  # sidebar + content + footer
│   ├── lib/                # manifest loader, link resolver, proseLoader
│   │   ├── links.ts        # `{% ref %}` resolution (regex + anchor → URL)
│   │   ├── manifest.ts     # data/manifest.json accessors
│   │   └── proseLoader.ts  # custom content loader that resolves refs
│   ├── pages/              # /, /cli/reference, /tui/slash-commands, …
│   └── styles/global.css
├── content/                # hand-written prose (Markdown/MDX)
├── scripts/                # extract-cli, extract-slash, extract-providers, extract-changelog, snapshot-manifest, validate-manifest
└── data/                   # generated JSON (gitignored except manifest.json)
```

### `{% ref %}` resolution

The `proseLoader` (in `src/lib/proseLoader.ts`) is a thin wrapper around
Astro's stock `glob` loader. It populates the data store normally, then
walks every entry and rewrites `{% ref "anchor" %}` tags in the rendered
HTML to `<a href="..."><code>label</code></a>` (when the tag was in
backticks) or `<a href="...">label</a>` (when it wasn't). Anchor types
supported:

- `cli:<command>` → `/cli/reference#<command>`
- `slash:<name>` → `/tui/slash-commands#<name>`
- `provider:<key>` → `/deployment/providers#<key>`
- `page:<section>/<slug>` → `/<section>/<slug>`

Unresolvable anchors are surfaced as `[missing: <anchor>]` in the
rendered page and as a `[WARN]` line in the build log. `npm run check`
exits non-zero on any missing target.

The custom loader is needed because Astro's `glob` loader does not
honor `markdown.remarkPlugins` for content collections, and there is
no public `transform` hook on loaders in 5.18 — wrapping is the
supported way to pre-process glob-loaded bodies.
