# Streamdown migration (flagged)

Status: Draft / experimental — behind a feature flag, **off by default**.

Replaces the hand-rolled `formatContent`/`formatInline` markdown parser in
`MessageBubble` with [Streamdown](https://github.com/vercel/streamdown) (Vercel's
streaming-markdown renderer) for assistant message bodies, while keeping every
Push-specific behavior around it.

## What changed

| Piece | File |
|---|---|
| Feature flag | `app/src/lib/feature-flags.ts` (`isStreamdownEnabled()`) |
| Adapter component | `app/src/components/chat/PushMarkdownRenderer.tsx` |
| Integration (lazy, flag-gated) | `app/src/components/chat/MessageBubble.tsx` |
| Fixture tests | `app/src/components/chat/PushMarkdownRenderer.test.tsx`, `MessageBubble.test.tsx` |
| Default-off env | `app/.env.production` (`VITE_USE_STREAMDOWN=0`) |

## Enabling it

- **Build flag:** `VITE_USE_STREAMDOWN=1`
- **Runtime override (no rebuild):** `localStorage['push:streamdown'] = '1'` (or `'0'` to force off)

The flag is read at render time, so the localStorage override takes effect on
the next render without a reload.

## What is preserved (unchanged)

- **Cadence:** `useSmoothStreamedText` still produces `revealedContentText`; the
  adapter renders that growing string. The reveal pacing is identical.
- **No double animation:** Streamdown's own staggered animation is disabled
  (`animated={false}`). When the flag is on we also skip the legacy per-word
  shimmer (it wraps `formatContent` output, which isn't used). The two never run
  together.
- **Sanitation / hiding:** tool-call JSON stripping, malformed-message hiding,
  and tool-call message clearing all happen in `displayContentText` **upstream**
  of the renderer, so they are renderer-agnostic. The adapter only ever sees
  already-clean text (often `''`, which renders nothing).
- **Cards:** `JobCard`/`CommitCard`/tool cards render in their own container via
  `CardRenderer`, completely independent of the text path. Untouched.
- **Theme:** all overrides use Push tokens (`text-push-*`, `bg-push-surface`,
  `border-push-edge`, `--repo-theme-accent-*`), so repo-theme overrides apply.
- **Security:** Streamdown's default sanitization (`rehype-harden`) stays on;
  images are disallowed (`disallowedElements={['img']}`) to match the legacy
  parser (which never rendered images) and avoid loading remote content. Links
  open in a new tab with `rel="noopener noreferrer"`.

## Fixture coverage

| # | Case | Where |
|---|---|---|
| 1 | plain paragraphs | `PushMarkdownRenderer.test.tsx` |
| 2 | nested lists | `PushMarkdownRenderer.test.tsx` (legacy parser could **not** nest) |
| 3 | tables | `PushMarkdownRenderer.test.tsx` (legacy parser had **no** table support) |
| 4 | unclosed code fence mid-stream | `PushMarkdownRenderer.test.tsx` (`parseIncompleteMarkdown`) |
| 5 | inline code | `PushMarkdownRenderer.test.tsx` (both highlight on/off) |
| 6 | links | `PushMarkdownRenderer.test.tsx` |
| 7 | malformed tool JSON | `MessageBubble.test.tsx` (hidden upstream; renderer-agnostic) |
| 8 | long code lines on mobile | `PushMarkdownRenderer.test.tsx` (horizontal scroller, both modes) |

> Note: cases 2 and 3 are genuine capability *upgrades* — the legacy regex
> parser rendered neither nested lists nor tables.

## Bundle impact

Measured with `npm run build` (Vite 7 / Rollup), gzip sizes.

### Default (flag off)
- **Zero added JS.** The adapter is `lazyWithRecovery(() => import('./PushMarkdownRenderer'))`,
  and with the flag off the dynamic import never fires. Streamdown is **not** in
  the eager entry chunk (verified: entry has no `data-streamdown`).
- **Small always-on CSS bump.** Streamdown's Tailwind v3 setup requires
  `./node_modules/streamdown/dist/*.js` and `./node_modules/@streamdown/code/dist/*.js`
  in `tailwind.config.js` `content` (else its code-block classes are purged and
  highlighted blocks render unstyled when the flag is on). Tailwind content
  scanning is build-time and unconditional, so those utility classes land in the
  CSS bundle **regardless of flag state** — a few KB of extra CSS even with the
  flag off. The lazy JS chunks stay flag-gated; only the CSS is unconditional.

### Flag on (per session, after first paint)
- **Base markdown chunk: ~458 KB raw / ~140 KB gzip**, loaded once when the
  first assistant bubble renders. This is base Streamdown + the unified/remark/
  rehype/micromark pipeline + the adapter. Its only **static** imports are
  `vendor-react` and the app entry chunk — it does **not** statically pull
  mermaid, cytoscape, or KaTeX.
- **Syntax highlighting: on, via `@streamdown/code` (Shiki) — heavy and lazy.**
  Fenced code blocks render through Streamdown's CodeBlock with the
  `@streamdown/code` plugin (base Streamdown does **not** highlight on its own —
  the plugin must be installed and passed via `plugins.code`; the earlier
  attempt shipped uncolored output precisely because it wasn't). Real colors are
  verified in `code-highlight.test.ts` (calls the plugin's `highlight()` and
  asserts concrete hex tokens). **Cost:** Shiki lazily loads its oniguruma WASM
  engine (`shiki-wasm`, ~622 KB raw) on the **first** highlighted block, plus a
  **per-language grammar chunk** for each language that appears (e.g. TypeScript
  ~181 KB raw, TSX ~175 KB, C++ ~626 KB) and the theme. All of these are
  lazy/code-split — fetched only when a code block of that language renders, then
  cached — but they are substantial on mobile. Highlighting can be turned off
  per call (`enableCodeHighlight={false}`) to render plain monospace with no
  Shiki cost. A lighter Shiki JS engine (no WASM) is a possible follow-up.
- **No Mermaid / KaTeX at runtime.** Those plugins are not wired (`plugins` only
  carries `code`), so their components never render and `mermaid-*` / KaTeX
  chunks are **never requested**.

### Mermaid is not duplicated
- The app already depends on `mermaid@11.14.0` (used by artifact diagrams).
  Streamdown wants `mermaid@^11.12.2`, satisfied by the same install — **one
  copy, deduped**. The large `mermaid.core` / `cytoscape` / `wardley` chunks in
  the build pre-date this change and are unrelated to Streamdown rendering.

### Capacitor / mobile note
- The runtime flag means the Streamdown chunks are still **emitted to `dist/`**
  (≈458 KB raw for the base chunk) and therefore ship inside the Android APK
  even when the flag is off — they just aren't downloaded/parsed at runtime.
  If a zero-footprint-when-off build is required for mobile, gate the dynamic
  `import()` behind a **build-time** env check (so Rollup tree-shakes it out
  when `VITE_USE_STREAMDOWN!=1`). Left as a runtime flag here for QA flexibility.

## Plugin recommendation

Streamdown's heavy capabilities are opt-in. Recommendation for each:

| Plugin | Default | Recommendation | Rationale |
|---|---|---|---|
| **Code highlighting (Shiki)** | **enabled** via `@streamdown/code` (lazy, per-language) | **keep enabled; consider a lighter engine** | Base Streamdown does not highlight — the `@streamdown/code` plugin must be installed and passed via `plugins.code` (the earlier "on by default" attempt shipped uncolored because it wasn't). Real colors verified in `code-highlight.test.ts`. Heavy: lazily loads a ~622 KB oniguruma WASM engine on first block + per-language grammars. A Shiki JS engine (no WASM) would cut the largest cost. Toggle off per-surface via `enableCodeHighlight={false}`. |
| **Math (KaTeX)** | disabled (no math plugin) | **stay disabled** unless a math use-case appears | KaTeX is ~77 KB gzip and Push has no current math surface. Enable per-surface, lazily, only on demand. |
| **Mermaid diagrams** | disabled (never rendered) | **stay disabled** in chat; keep diagrams in the existing artifact path | Mermaid + cytoscape are very heavy. Push already renders Mermaid via `MermaidArtifact`; duplicating it inline isn't worth the weight. |
| **GFM (tables, strikethrough, task lists)** | **enabled** (Streamdown default) | **keep enabled** | Pure-JS, already in the base chunk, and a real upgrade over the legacy parser. |
| **Incomplete-markdown parsing** | enabled while streaming | **keep enabled** | Core reason to adopt Streamdown; pairs with our cadence. |
| **Controls (copy/download/fullscreen)** | disabled | **keep disabled** | Push has its own copy affordance; avoids UI chrome and extra listeners. |

### Net recommendation
Ship with GFM + incomplete-markdown parsing + Shiki code highlighting (via
`@streamdown/code`) enabled behind the flag. Keep math and inline Mermaid **off**
in chat. Revisit the Shiki engine choice (WASM → JS) if the per-block weight is a
problem on mobile.
