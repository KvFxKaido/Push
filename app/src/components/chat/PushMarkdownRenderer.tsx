import { cloneElement, isValidElement, type ReactElement } from 'react';
import { Streamdown, type Components } from 'streamdown';
import { createCodePlugin } from '@streamdown/code';

// Shiki code-highlighting plugin (the supported Streamdown integration — base
// Streamdown does NOT highlight on its own; it needs this plugin passed via
// `plugins.code`). Push is dark-only, so both slots of Shiki's [light, dark]
// tuple use the same dark theme. The plugin (and Shiki) load lazily as part of
// the already-lazy adapter chunk; highlighting resolves asynchronously, so the
// first paint shows the code text immediately and colors fill in when ready.
const codePlugin = createCodePlugin({ themes: ['github-dark-default', 'github-dark-default'] });

/**
 * Push's markdown renderer, adapting Vercel's Streamdown to Push's chat styling
 * and streaming model. This is the flagged replacement for the hand-rolled
 * `formatContent`/`formatInline` parser in MessageBubble.
 *
 * Design decisions (see PR notes):
 *  - **Push-styled elements; Shiki code highlighting on by default.** Prose
 *    elements are overridden with Push-styled components. Fenced code blocks use
 *    Streamdown's CodeBlock with the `@streamdown/code` (Shiki) plugin, themed
 *    through Push's existing shadcn tokens. Highlighting can be turned off per
 *    call (`enableCodeHighlight={false}`) to render plain Push monospace with no
 *    Shiki cost. Mermaid and math (KaTeX) plugins are NOT wired, so those
 *    components never render and their chunks never load.
 *  - **No Streamdown animation.** `animated={false}` so its staggered reveal
 *    never runs alongside Push's own cadence (`useSmoothStreamedText`) or the
 *    per-word shimmer. The reveal is driven entirely by the growing `text`.
 *  - **No control chrome.** `controls={false}` removes copy/download/fullscreen
 *    buttons; Push has its own copy affordance on the bubble.
 *  - **Sanitation stays upstream.** Tool-call JSON stripping and malformed /
 *    tool-call message hiding happen in MessageBubble's `displayContentText`
 *    before any text reaches this component, so the adapter is pure rendering.
 *  - **Security.** Streamdown's default sanitization (rehype-harden) stays on;
 *    images are disallowed entirely to match Push's current behavior (the
 *    legacy parser never rendered images) and avoid loading remote content.
 */

const linkClass =
  'text-push-accent hover:text-push-link underline underline-offset-2 decoration-push-accent/30 hover:decoration-push-link/50 transition-colors wrap-anywhere';

// Each override pulls only the props it needs (`children`, plus `href` / the
// rest for the few that branch on it). We deliberately do not forward
// react-markdown's `node`/`className` onto the DOM: `node` is a non-DOM prop
// that would trip a React warning, and forwarding `className` would let
// Streamdown's defaults override Push's styling.
//
// `code`/`pre` are intentionally NOT in this base map. With highlighting on we
// let Streamdown's own CodeBlock (driven by the Shiki plugin) render them; with
// highlighting off, the plain Push overrides below are merged in.
const BASE_COMPONENTS: Components = {
  // Paragraphs — modest separation; the bubble container owns size/leading.
  p: ({ children }) => <p className="break-words [&:not(:last-child)]:mb-2">{children}</p>,

  // Headings (mirror formatContent's four levels; h5/h6 reuse the h4 treatment).
  h1: ({ children }) => (
    <div className="text-[18px] font-semibold text-push-fg mt-4 mb-1.5">{children}</div>
  ),
  h2: ({ children }) => (
    <div className="text-[16px] font-semibold text-push-fg mt-3 mb-1">{children}</div>
  ),
  h3: ({ children }) => (
    <div className="text-push-lg font-medium text-push-fg-soft mt-2.5 mb-0.5">{children}</div>
  ),
  h4: ({ children }) => (
    <div className="text-[14px] font-medium text-push-fg-muted mt-2 mb-0.5 uppercase tracking-wide">
      {children}
    </div>
  ),
  h5: ({ children }) => (
    <div className="text-[14px] font-medium text-push-fg-muted mt-2 mb-0.5">{children}</div>
  ),
  h6: ({ children }) => (
    <div className="text-push-base font-medium text-push-fg-dim mt-2 mb-0.5">{children}</div>
  ),

  // Inline emphasis.
  strong: ({ children }) => <strong className="font-semibold text-push-fg">{children}</strong>,
  em: ({ children }) => <em className="italic text-push-fg-soft">{children}</em>,

  // Links — open in a new tab, hardened rel. Streamdown's sanitization still
  // runs on the href upstream of this component.
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className={linkClass}>
      {children}
    </a>
  ),

  // Lists — real list semantics (the legacy regex parser couldn't nest).
  ul: ({ children }) => (
    <ul className="my-1 list-disc list-outside pl-5 marker:text-push-fg-dim space-y-0.5">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1 list-decimal list-outside pl-5 marker:text-push-fg-dim marker:font-mono space-y-0.5">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="[&>p]:m-0 [&>p]:inline">{children}</li>,

  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-push-edge pl-3 my-1 text-push-fg-muted italic">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-0 border-t border-push-edge" />,

  // Tables — wrap in a horizontal scroller so wide tables and long cells don't
  // blow out the mobile viewport (fixture case 8).
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-push-edge">
      <table className="w-full border-collapse text-left text-push-base">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="border-b border-push-edge text-push-fg">{children}</thead>
  ),
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr className="border-b border-push-edge/50 last:border-0">{children}</tr>,
  th: ({ children }) => (
    <th className="px-2.5 py-1.5 font-semibold text-push-fg whitespace-nowrap">{children}</th>
  ),
  td: ({ children }) => <td className="px-2.5 py-1.5 align-top text-push-fg-soft">{children}</td>,
};

// Plain, un-highlighted code rendering (used when `enableCodeHighlight` is off).
// Streamdown's default `pre` tags the block child with `data-block`; we replicate
// that so a single `code` override can distinguish inline from block without
// pulling in Shiki.
const PLAIN_CODE_COMPONENTS: Components = {
  code: ({ children, ...props }) => {
    if ('data-block' in props) {
      return (
        <code className="block whitespace-pre font-mono text-push-base text-push-fg-soft leading-relaxed">
          {children}
        </code>
      );
    }
    return (
      <code className="rounded border border-push-edge bg-push-surface px-1.5 py-0.5 font-mono text-push-base text-push-fg-soft">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-lg border border-push-edge bg-push-surface px-3 py-2.5">
      {isValidElement(children)
        ? cloneElement(children as ReactElement<Record<string, unknown>>, { 'data-block': true })
        : children}
    </pre>
  ),
};

const COMPONENTS_PLAIN: Components = { ...BASE_COMPONENTS, ...PLAIN_CODE_COMPONENTS };

export interface PushMarkdownRendererProps {
  /** The (already-sanitized, possibly partially-revealed) markdown text. */
  text: string;
  /** When streaming, parse incomplete markdown so half-open tokens render cleanly. */
  isStreaming: boolean;
  /**
   * Syntax-highlight fenced code blocks via Streamdown's `@streamdown/code`
   * (Shiki) plugin. On by default. When false, code blocks render as plain
   * Push-styled monospace with no Shiki cost.
   */
  enableCodeHighlight?: boolean;
}

export function PushMarkdownRenderer({
  text,
  isStreaming,
  enableCodeHighlight = true,
}: PushMarkdownRendererProps) {
  return (
    <Streamdown
      mode={isStreaming ? 'streaming' : 'static'}
      parseIncompleteMarkdown={isStreaming}
      animated={false}
      // Streamdown renders the streaming caret as an inline `::after` on the
      // last block (gated internally to `mode="streaming"`), so it never wraps
      // to its own line the way a sibling element would. MessageBubble omits its
      // own caret on this path to avoid two carets.
      caret={isStreaming ? 'block' : undefined}
      controls={true}
      lineNumbers={false}
      disallowedElements={['img']}
      components={enableCodeHighlight ? BASE_COMPONENTS : COMPONENTS_PLAIN}
      plugins={enableCodeHighlight ? { code: codePlugin } : undefined}
      className="push-markdown"
    >
      {text}
    </Streamdown>
  );
}

export default PushMarkdownRenderer;