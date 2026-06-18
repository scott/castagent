/**
 * proseLoader.ts
 *
 * Custom Astro content loader that wraps the stock `glob` loader and
 * post-processes each entry's rendered HTML to resolve `{% ref "..." %}`
 * tags against the manifest.
 *
 * Why a custom loader?
 *   Astro's `glob` loader does not expose a `transform` hook in 5.18
 *   (the public surface is just `name`, `load`, and `schema`).
 *   Markdown `remarkPlugins` from `astro.config.mjs` only apply to
 *   standalone .md files, not to content collections loaded with the
 *   Content Layer API. So the supported way to pre-process a
 *   glob-loaded collection is to wrap the loader.
 *
 * The wrapper delegates file discovery and the initial markdown-to-HTML
 * render to `glob`, then walks the populated data store and rewrites
 * each entry's rendered HTML in place. Tags wrapped in backticks in the
 * source become `<code>{% ref "..." %}</code>` in the rendered output;
 * we transform those into `<a href="..."><code>label</code></a>` so the
 * code styling is preserved AND the link is clickable. Tags written
 * without backticks become plain text and are transformed into
 * `<a href="...">label</a>`.
 */

import { glob, type Loader } from 'astro/loaders'
import { ANCHOR_RE, anchorLabel, resolveAnchor } from './links.ts'

/**
 * Replace `{% ref "anchor" %}` substrings in rendered HTML with proper
 * anchor tags. The two contexts we care about:
 *
 *   1. Inside a <code>...</code> element (the source used backticks):
 *        <code>{% ref "cli:edit" %}</code>
 *      becomes
 *        <a href="cli/reference#edit"><code>edit</code></a>
 *      The link wraps the code tag so the visual style is preserved.
 *
 *   2. As bare text in the document:
 *        {% ref "cli:edit" %}
 *      becomes
 *        <a href="cli/reference#edit">edit</a>
 */
function resolveRefTagsInHtml(html: string): { html: string; missing: string[] } {
  const missing: string[] = []
  // Pattern 1: inside <code>...</code> (most common — the source used
  // backticks). Capture the anchor and the rest of the closing tag so
  // we don't have to worry about trailing whitespace differences.
  const CODE_RE = /<code>\{%\s*ref\s+["']([^"']+)["']\s*%\}<\/code>/g
  const out = html.replace(CODE_RE, (_, anchor: string) => {
    const url = resolveAnchor(anchor)
    if (!url) {
      missing.push(anchor)
      return `<code>[missing: ${anchor}]</code>`
    }
    return `<a href="${url}"><code>${anchorLabel(anchor)}</code></a>`
  })

  // Pattern 2: bare text. Walk any remaining occurrences and turn
  // them into plain links.
  const out2 = out.replace(ANCHOR_RE, (_, anchor: string) => {
    const url = resolveAnchor(anchor)
    if (!url) {
      // Don't double-report tags we already saw in code form.
      if (!missing.includes(anchor)) missing.push(anchor)
      return `[missing: ${anchor}]`
    }
    return `<a href="${url}">${anchorLabel(anchor)}</a>`
  })

  return { html: out2, missing }
}

export function proseLoader(): Loader {
  const inner = glob({ pattern: '**/*.{md,mdx}', base: './content' })
  return {
    name: 'prose-loader',
    async load(context) {
      // 1. Let the stock glob loader populate the store, including the
      //    pre-rendered HTML for every entry.
      await inner.load(context)

      // 2. Walk every entry and rewrite its rendered HTML in place to
      //    resolve {% ref %} tags. The body stays untouched; the
      //    Content component reads `rendered.html` at render time, so
      //    mutating the body would have no effect on output.
      //
      //    Unresolved anchors are surfaced as a build-time warning and
      //    a visible `[missing: <anchor>]` marker in the rendered
      //    page. `npm run check` (validate-manifest) is the
      //    authoritative enforcement — it exits non-zero on missing
      //    targets — but a warning during `astro build` makes
      //    authoring-time breakage impossible to ignore.
      for (const [id, entry] of context.store.entries()) {
        const renderedHtml = entry.rendered?.html
        if (!renderedHtml) continue
        const { html, missing } = resolveRefTagsInHtml(renderedHtml)
        for (const anchor of missing) {
          context.logger.warn(`prose: unresolved {% ref "${anchor}" %} in ${id}`)
        }
        if (html === renderedHtml) continue
        // Preserve every field the upstream glob loader set; only
        // the rendered HTML changes.
        //
        // We pass a *fresh* digest rather than `entry.digest` because
        // the scoped `store.set` short-circuits when the new digest
        // matches the existing one (see MutableDataStore.scopedStore
        // in astro/dist/content/mutable-data-store.js). The file
        // hasn't changed on disk, so its original digest is still in
        // the store; the bail-out would prevent our `rendered` update
        // from taking effect. Using `context.generateDigest(html)`
        // produces a digest for the transformed HTML that the bail-out
        // won't match, so the update lands.
        context.store.set({
          id,
          data: entry.data,
          body: entry.body,
          filePath: entry.filePath,
          digest: context.generateDigest(html),
          rendered: { ...entry.rendered, html },
          assetImports: entry.assetImports,
          legacyId: entry.legacyId,
          deferredRender: entry.deferredRender,
        })
      }
    },
  }
}
