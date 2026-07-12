/**
 * markdown.tsx — inline + block markdown → silvery `<Text>` for the stream.
 *
 * The stream is the product (Visual Language v2, law 1); raw `**asterisks**`,
 * `[label](url)` brackets, and list syntax in the transcript undercut every
 * other law that landed. This renders assistant prose as styled cells under
 * the one-accent budget (law 2): **bold** via weight, `code` via `muted`,
 * links as the single accent — never a rainbow. Emoji are stripped in the
 * render path (law 2 side door / #1433): a full-color glyph that can't be
 * dimmed is an unbudgeted accent.
 *
 * Two invariants keep the transcript height math (`countVisualLines` in
 * `surface.tsx`) honest:
 *
 *  1. **Line-oriented.** One source line renders to exactly one row; newlines
 *     are never added or removed. Fenced code keeps its ``` markers (dimmed)
 *     rather than stripping them, so the line count is identical to `item.text`.
 *  2. **Width-non-increasing.** Stripping markers (`**`, `##`, brackets) only
 *     ever shortens a line, so the raw-text height estimate is an upper bound —
 *     it can over-reserve a row, never clip one.
 *
 * The parse layer is pure and unit-tested; the component only maps its output
 * onto silvery nodes.
 */
import React, { useMemo } from 'react';
import { Box, Text } from 'silvery';

import { detectUnicode } from '../tui-theme.js';
import { VL_COLOR, type VlColor } from './visual-language.js';

// ── Emoji stripping (law 2 / #1433) ──────────────────────────────────
//
// Decorative pictographs in model prose bypass the grayscale-plus-one-accent
// posture. Strip Extended_Pictographic runs plus their ZWJ joiners, skin-tone
// modifiers, regional indicators, and emoji variation selector. Push's own
// chrome glyphs (◆ ⬡ ░ — geometric/block, not pictographic) never appear in
// `item.text`, so this only touches model-emitted decoration.

const EMOJI =
  /(?:\p{Regional_Indicator}\p{Regional_Indicator})|\p{Extended_Pictographic}(?:️|︎|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️|︎|\p{Emoji_Modifier})?)*/gu;

/**
 * Remove decorative emoji and collapse the internal whitespace the removal
 * orphans. Edge whitespace is left intact on purpose: this runs per-span inside
 * `parseInline`, where a trailing space connects to the next styled run —
 * line-edge trimming is `parseInline`'s job, not this function's.
 */
export function stripDecorativeEmoji(text: string): string {
  if (!text) return text;
  if (!/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}⬀-⯿←-⇿]/u.test(text)) {
    // Fast path: no plausible emoji-plane codepoint present.
    return text;
  }
  return text
    .replace(EMOJI, '')
    .replace(/ {2,}/g, ' ')
    .replace(/ +([,.;:!?])/g, '$1');
}

// ── Inline spans ──────────────────────────────────────────────────────

export interface InlineSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** Inline `code` — rendered muted. */
  code?: boolean;
  /** Link label — rendered in the accent; `url` trails dim when informative. */
  link?: boolean;
  url?: string;
}

// Anchored (sticky) matchers, tried in this order at each scan position so the
// longest emphasis wins (`***` before `**` before `*`). Underscore emphasis is
// deliberately unsupported — `snake_case` / `__dunder__` identifiers make it
// lossy, and asterisk forms cover the common case unambiguously.
const RE = {
  code: /`([^`\n]+)`/y,
  link: /\[([^\]\n]+)\]\(([^)\n]+)\)/y,
  boldItalic: /\*\*\*([^*\n]+?)\*\*\*/y,
  bold: /\*\*([^*\n]+?)\*\*/y,
  italic: /\*(\S|\S[^*\n]*?\S)\*/y,
};

/**
 * Split one line into styled spans. Plain runs are emoji-stripped; `code`
 * content is preserved verbatim (identifiers may legitimately hold any char).
 */
export function parseInline(line: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf) {
      const cleaned = stripDecorativeEmoji(buf);
      if (cleaned) spans.push({ text: cleaned });
      buf = '';
    }
  };
  let i = 0;
  while (i < line.length) {
    RE.code.lastIndex = i;
    const code = RE.code.exec(line);
    if (code && code.index === i) {
      flush();
      spans.push({ text: code[1], code: true });
      i = RE.code.lastIndex;
      continue;
    }
    RE.link.lastIndex = i;
    const link = RE.link.exec(line);
    if (link && link.index === i) {
      flush();
      spans.push({ text: stripDecorativeEmoji(link[1]), link: true, url: link[2] });
      i = RE.link.lastIndex;
      continue;
    }
    RE.boldItalic.lastIndex = i;
    const bi = RE.boldItalic.exec(line);
    if (bi && bi.index === i) {
      flush();
      spans.push({ text: stripDecorativeEmoji(bi[1]), bold: true, italic: true });
      i = RE.boldItalic.lastIndex;
      continue;
    }
    RE.bold.lastIndex = i;
    const bold = RE.bold.exec(line);
    if (bold && bold.index === i) {
      flush();
      spans.push({ text: stripDecorativeEmoji(bold[1]), bold: true });
      i = RE.bold.lastIndex;
      continue;
    }
    RE.italic.lastIndex = i;
    const italic = RE.italic.exec(line);
    if (italic && italic.index === i) {
      flush();
      spans.push({ text: stripDecorativeEmoji(italic[1]), italic: true });
      i = RE.italic.lastIndex;
      continue;
    }
    buf += line[i];
    i += 1;
  }
  flush();
  // Trim the space an edge emoji orphaned at the true line boundary — only on
  // plain runs (code/link edges are meaningful). Interior plain spans are never
  // empty (flush only pushes non-empty), so an empty edge span means the trim
  // consumed it; drop those.
  const first = spans[0];
  if (first && !first.code && !first.link) first.text = first.text.replace(/^ +/, '');
  const last = spans[spans.length - 1];
  if (last && !last.code && !last.link) last.text = last.text.replace(/ +$/, '');
  const kept = spans.filter((span) => span.text !== '' || span.code || span.link);
  // A line that was pure emoji (or emptied by trimming) survives as a blank
  // cell so the row — and the height estimate — is preserved.
  return kept.length === 0 ? [{ text: '' }] : kept;
}

// ── Block lines ───────────────────────────────────────────────────────

export type MdLineKind =
  | 'text'
  | 'heading'
  | 'bullet'
  | 'ordered'
  | 'quote'
  | 'code'
  | 'fence'
  | 'hr'
  | 'blank';

export interface MdLine {
  kind: MdLineKind;
  /** Inline spans for text-bearing kinds. */
  spans?: InlineSpan[];
  /** Leading marker rendered dim (bullet glyph, `N.`, quote rail). */
  marker?: string;
  /** Verbatim content for code/fence lines. */
  raw?: string;
  /** Fence language tag, when present. */
  lang?: string;
}

const HR = /^\s*([-*_])\1{2,}\s*$/;
const FENCE = /^\s*```(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;

/**
 * Parse `text` into one `MdLine` per source line (line count preserved).
 * Fenced blocks toggle on ``` and render verbatim; everything else is
 * classified and inline-parsed.
 */
export function parseMarkdown(text: string): MdLine[] {
  const out: MdLine[] = [];
  let inFence = false;
  for (const raw of text.split('\n')) {
    const fence = FENCE.exec(raw);
    if (fence) {
      inFence = !inFence;
      out.push({ kind: 'fence', lang: inFence ? fence[1].trim() : '' });
      continue;
    }
    if (inFence) {
      out.push({ kind: 'code', raw });
      continue;
    }
    if (raw.trim() === '') {
      out.push({ kind: 'blank' });
      continue;
    }
    if (HR.test(raw)) {
      out.push({ kind: 'hr' });
      continue;
    }
    const heading = HEADING.exec(raw);
    if (heading) {
      out.push({ kind: 'heading', spans: parseInline(heading[2]) });
      continue;
    }
    const quote = QUOTE.exec(raw);
    if (quote) {
      out.push({ kind: 'quote', spans: parseInline(quote[1]) });
      continue;
    }
    const ordered = ORDERED.exec(raw);
    if (ordered) {
      out.push({
        kind: 'ordered',
        marker: `${ordered[1]}${ordered[2]}. `,
        spans: parseInline(ordered[3]),
      });
      continue;
    }
    const bullet = BULLET.exec(raw);
    if (bullet) {
      out.push({ kind: 'bullet', marker: bullet[1], spans: parseInline(bullet[2]) });
      continue;
    }
    out.push({ kind: 'text', spans: parseInline(raw) });
  }
  return out;
}

// ── Render ────────────────────────────────────────────────────────────

interface Marks {
  bullet: string;
  quoteRail: string;
  hr: string;
}

function marksFor(unicode: boolean): Marks {
  return unicode
    ? { bullet: '• ', quoteRail: '│ ', hr: '────────' }
    : { bullet: '- ', quoteRail: '| ', hr: '--------' };
}

function spanColor(span: InlineSpan, base: VlColor | undefined): VlColor | undefined {
  if (span.code) return VL_COLOR.muted;
  if (span.link) return VL_COLOR.accent;
  return base;
}

function Spans({ spans, base }: { spans: InlineSpan[]; base: VlColor | undefined }) {
  return (
    <>
      {spans.map((span, index) => (
        <React.Fragment key={index}>
          <Text bold={span.bold} italic={span.italic} color={spanColor(span, base)}>
            {span.text}
          </Text>
          {span.link && span.url && span.url !== span.text ? (
            <Text color={VL_COLOR.muted}> {span.url}</Text>
          ) : null}
        </React.Fragment>
      ))}
    </>
  );
}

function LineView({
  line,
  base,
  marks,
}: {
  line: MdLine;
  base: VlColor | undefined;
  marks: Marks;
}) {
  switch (line.kind) {
    case 'blank':
      return <Text> </Text>;
    case 'hr':
      return <Text color={VL_COLOR.muted}>{marks.hr}</Text>;
    case 'fence':
      return <Text color={VL_COLOR.muted}>```{line.lang}</Text>;
    case 'code':
      return <Text color={VL_COLOR.muted}>{line.raw || ' '}</Text>;
    case 'heading':
      return (
        <Text bold color={base}>
          <Spans spans={line.spans ?? []} base={base} />
        </Text>
      );
    case 'quote':
      return (
        <Text color={VL_COLOR.muted}>
          {marks.quoteRail}
          <Spans spans={line.spans ?? []} base={VL_COLOR.muted} />
        </Text>
      );
    case 'bullet':
      return (
        <Text color={base}>
          {line.marker}
          <Text color={VL_COLOR.muted}>{marks.bullet}</Text>
          <Spans spans={line.spans ?? []} base={base} />
        </Text>
      );
    case 'ordered':
      return (
        <Text color={base}>
          <Text color={VL_COLOR.muted}>{line.marker}</Text>
          <Spans spans={line.spans ?? []} base={base} />
        </Text>
      );
    default:
      return (
        <Text color={base}>
          <Spans spans={line.spans ?? []} base={base} />
        </Text>
      );
  }
}

/**
 * Render assistant/independent-voice prose as styled markdown under the
 * one-accent budget. `base` is the inherited body color (undefined = default
 * stream text); code/link spans override it per law 2.
 */
export function MarkdownBody({ text, base }: { text: string; base?: VlColor }) {
  const unicode = useMemo(() => detectUnicode(), []);
  const lines = useMemo(() => parseMarkdown(text), [text]);
  const marks = useMemo(() => marksFor(unicode), [unicode]);
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <LineView key={index} line={line} base={base} marks={marks} />
      ))}
    </Box>
  );
}
