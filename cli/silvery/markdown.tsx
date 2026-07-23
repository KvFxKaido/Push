/**
 * markdown.tsx — inline + block markdown → silvery `<Text>` for the stream.
 *
 * The stream is the product (Visual Language v2, law 1); raw `**asterisks**`,
 * `[label](url)` brackets, and list syntax in the transcript undercut every
 * other law that landed. This renders assistant prose as styled cells under
 * the semantic palette (law 2): structure remains legible through weight,
 * glyph, underline/strike, and position while color reinforces the meaning.
 * Emoji are stripped in the render path (#1433): their uncontrolled palette
 * cannot participate in the theme or grayscale fallback.
 *
 * Two invariants keep the transcript height math (`countVisualLines` in
 * `surface.tsx`) honest:
 *
 *  1. **Line-oriented.** One source line renders to exactly one row; newlines
 *     (LF or CRLF) are never added or removed. Fenced code keeps its ``` markers
 *     (dimmed) rather than stripping them, so the line count equals `item.text`.
 *  2. **Width-contained.** Stripping markers (`**`, `##`, brackets) only ever
 *     shortens ordinary lines, and a horizontal rule is rendered at its source
 *     length. Tables are the one width-increasing construct: they render as
 *     padded columns only when the shared table layout fits the known body
 *     width; otherwise each source row falls back to ordinary raw text.
 *
 * The parse layer is pure and unit-tested; the component only maps its output
 * onto silvery nodes.
 */
import React, { useMemo } from 'react';
import { Box, Link, Text, displayWidth } from 'silvery';

import { safeTerminalUrl } from '../citation-format.js';
import { type CodeSpan, highlightToSpans } from '../tui-highlight.js';
import { detectUnicode } from '../tui-theme.js';
import { VL_COLOR, type VlColor } from './visual-language.js';

// ── Emoji stripping (law 2 / #1433) ──────────────────────────────────
//
// Decorative pictographs in model prose bypass the theme's semantic palette.
// The strip targets *emoji-presentation* glyphs, not every pictograph:
// a character is emoji only if it defaults to emoji rendering
// (`\p{Emoji_Presentation}`) or is explicitly forced to it with VS16 (U+FE0F).
// Text-default pictographs — arrows (↔ ↩ ➡), ▶, ✓ — are meaningful prose and
// are kept. Push's own chrome glyphs (▪ ▫ ⬡ ░ — geometric, not pictographic) are
// never pictographic at all, so they are always safe.
//
// One emoji unit = a base (default-emoji, or pictograph+VS16) + an optional
// skin-tone modifier; a grapheme is one unit or a ZWJ-joined run of them, or a
// regional-indicator flag pair.

const EMOJI_UNIT =
  '(?:\\p{Emoji_Presentation}\\uFE0F?|\\p{Extended_Pictographic}\\uFE0F)\\p{Emoji_Modifier}?';
// Keycap sequences (1️⃣ #️⃣) are an ASCII base + optional VS16 + U+20E3 — the
// base isn't pictographic, so they need their own alternative.
const KEYCAP = '[0-9#*]\\uFE0F?\\u20E3';
const EMOJI = new RegExp(
  `\\p{Regional_Indicator}{2}|${KEYCAP}|${EMOJI_UNIT}(?:\\u200D${EMOJI_UNIT})*`,
  'gu',
);

// Cheap pre-check: only run the emoji regex (and space-collapse) when a
// plausible emoji-plane codepoint, a VS16 selector, or the keycap combiner is
// present. VS16 matters because a base like ▶ (U+25B6) sits outside the SMP
// ranges but becomes emoji when followed by U+FE0F; U+20E3 catches keycaps.
const MAYBE_EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{FE0F}\u{20E3}]/u;

/**
 * Remove decorative emoji and collapse the internal whitespace the removal
 * orphans. Edge whitespace is left intact on purpose: this runs per-span inside
 * `parseInline`, where a trailing space connects to the next styled run —
 * line-edge trimming is `parseInline`'s job, not this function's.
 */
export function stripDecorativeEmoji(text: string): string {
  if (!text || !MAYBE_EMOJI.test(text)) return text;
  const stripped = text.replace(EMOJI, '');
  // Nothing matched (e.g. a text-presentation arrow) — leave the string exactly
  // as-is; do not collapse spacing the author intended.
  if (stripped === text) return text;
  return stripped.replace(/ {2,}/g, ' ').replace(/ +([,.;:!?])/g, '$1');
}

// ── Inline spans ──────────────────────────────────────────────────────

export interface InlineSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** GFM `~~strikethrough~~`. */
  strike?: boolean;
  /** Inline `code` — rendered on a subtle surface plus the theme's code hue. */
  code?: boolean;
  /** Link label — rendered in the link role; `url` trails dim when informative. */
  link?: boolean;
  /** Image alt text — terminal fallback for an image destination. */
  image?: boolean;
  url?: string;
}

export type TableAlignment = 'left' | 'center' | 'right';
export type TableRowRole = 'header' | 'divider' | 'body';

export interface MdTableLayout {
  columnWidths: number[];
  alignments: TableAlignment[];
  formattedWidth: number;
}

// Anchored (sticky) matchers, tried in this order at each scan position so the
// longest emphasis wins (`***` before `**` before `*`). Underscore emphasis is
// deliberately unsupported — `snake_case` / `__dunder__` identifiers make it
// lossy, and asterisk forms cover the common case unambiguously.
const RE = {
  code: /`([^`\n]+)`/y,
  imageStart: /!\[([^\]\n]*)\]\(/y,
  linkStart: /\[([^\]\n]+)\]\(/y,
  boldItalic: /\*\*\*([^*\n]+?)\*\*\*/y,
  strike: /~~([^~\n]+?)~~/y,
  bold: /\*\*([^*\n]+?)\*\*/y,
  italic: /\*(\S|\S[^*\n]*?\S)\*/y,
};

// The active streaming tail gets a deliberately smaller, terminal-shaped
// equivalent of Streamdown's incomplete-markdown repair. These matchers only
// accept a construct that runs to the end of the source line. A longer opened
// emphasis run wins before a completed lower-precedence form so partial closing
// delimiters cannot make bold or bold-italic flicker to italic while streaming.
// Keeping this in the parser (rather than rewriting the source string) makes the
// width/line invariants explicit: synthetic closing markers never become cells.
const STREAMING_RE = {
  code: /`([^`\n]+)$/y,
  link: /\[([^\]\n]+)\]\([^)\n]*$/y,
  strike: /~~([^\s~\n][^~\n]*?)?~?$/y,
  boldItalic: /\*\*\*([^\s*\n][^*\n]*?)(?:\*{1,2})?$/y,
  bold: /\*\*([^\s*\n][^*\n]*?)\*?$/y,
  italic: /\*([^\s*\n][^*\n]*)$/y,
};

export interface ParseInlineOptions {
  /** Style supported half-open syntax at the end of a live source line. */
  streamingTail?: boolean;
}

function canOpenStreamingEmphasis(line: string, index: number): boolean {
  if (index === 0) return true;
  const previous = line[index - 1];
  // Be more conservative than the settled parser while the closing marker is
  // still hypothetical: do not transiently restyle identifiers, arithmetic,
  // or glob/path fragments such as `2*3` and `src/**generated`.
  return !(
    /[\p{L}\p{N}_]/u.test(previous) ||
    previous === '/' ||
    previous === '\\' ||
    previous === '*'
  );
}

interface InlineDestination {
  url: string;
  end: number;
}

/** Parse a Markdown destination through its balanced closing parenthesis. */
function parseInlineDestination(line: string, start: number): InlineDestination | null {
  let depth = 1;
  let url = '';
  for (let index = start; index < line.length; index += 1) {
    const char = line[index];
    if (char === '\n') return null;
    if (char === '\\' && index + 1 < line.length) {
      const escaped = line[index + 1];
      if (escaped === '(' || escaped === ')' || escaped === '\\') {
        url += escaped;
        index += 1;
        continue;
      }
    }
    if (char === '(') {
      depth += 1;
      url += char;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return url ? { url, end: index + 1 } : null;
      url += char;
      continue;
    }
    url += char;
  }
  return null;
}

/**
 * Split one line into styled spans. Plain runs are emoji-stripped; `code`
 * content is preserved verbatim (identifiers may legitimately hold any char).
 */
export function parseInline(line: string, options: ParseInlineOptions = {}): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let buf = '';
  // Track whether emoji removal actually touched this line — the edge-space trim
  // below must only run when a boundary emoji orphaned a space, never on plain
  // indented content (stack traces, ASCII tables) that carries meaningful
  // leading/trailing whitespace.
  let didStrip = false;
  const flush = (): void => {
    if (buf) {
      const cleaned = stripDecorativeEmoji(buf);
      if (cleaned !== buf) didStrip = true;
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
    RE.imageStart.lastIndex = i;
    const image = RE.imageStart.exec(line);
    const imageDestination = image ? parseInlineDestination(line, RE.imageStart.lastIndex) : null;
    if (image && image.index === i && imageDestination) {
      flush();
      spans.push({ text: stripDecorativeEmoji(image[1]), image: true, url: imageDestination.url });
      i = imageDestination.end;
      continue;
    }
    RE.linkStart.lastIndex = i;
    const link = RE.linkStart.exec(line);
    const linkDestination = link ? parseInlineDestination(line, RE.linkStart.lastIndex) : null;
    if (link && link.index === i && linkDestination) {
      flush();
      spans.push({ text: stripDecorativeEmoji(link[1]), link: true, url: linkDestination.url });
      i = linkDestination.end;
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
    RE.strike.lastIndex = i;
    const strike = RE.strike.exec(line);
    if (strike && strike.index === i) {
      flush();
      spans.push({ text: stripDecorativeEmoji(strike[1]), strike: true });
      i = RE.strike.lastIndex;
      continue;
    }
    if (options.streamingTail) {
      STREAMING_RE.code.lastIndex = i;
      const partialCode = STREAMING_RE.code.exec(line);
      if (partialCode && partialCode.index === i) {
        flush();
        spans.push({ text: partialCode[1], code: true });
        i = STREAMING_RE.code.lastIndex;
        continue;
      }
      STREAMING_RE.link.lastIndex = i;
      const partialLink = STREAMING_RE.link.exec(line);
      if (partialLink && partialLink.index === i && (i === 0 || line[i - 1] !== '!')) {
        flush();
        // A partial destination is not a usable link target.
        // Keep only the label until the closing `)` makes this a real link.
        spans.push({ text: stripDecorativeEmoji(partialLink[1]) });
        i = STREAMING_RE.link.lastIndex;
        continue;
      }
      STREAMING_RE.strike.lastIndex = i;
      const partialStrike = STREAMING_RE.strike.exec(line);
      if (partialStrike && partialStrike.index === i) {
        flush();
        spans.push({ text: stripDecorativeEmoji(partialStrike[1] ?? ''), strike: true });
        i = STREAMING_RE.strike.lastIndex;
        continue;
      }
      STREAMING_RE.boldItalic.lastIndex = i;
      const partialBoldItalic = STREAMING_RE.boldItalic.exec(line);
      if (partialBoldItalic && partialBoldItalic.index === i && canOpenStreamingEmphasis(line, i)) {
        flush();
        spans.push({
          text: stripDecorativeEmoji(partialBoldItalic[1]),
          bold: true,
          italic: true,
        });
        i = STREAMING_RE.boldItalic.lastIndex;
        continue;
      }
      STREAMING_RE.bold.lastIndex = i;
      const partialBold = STREAMING_RE.bold.exec(line);
      if (partialBold && partialBold.index === i && canOpenStreamingEmphasis(line, i)) {
        flush();
        spans.push({ text: stripDecorativeEmoji(partialBold[1]), bold: true });
        i = STREAMING_RE.bold.lastIndex;
        continue;
      }
      STREAMING_RE.italic.lastIndex = i;
      const partialItalic = STREAMING_RE.italic.exec(line);
      if (partialItalic && partialItalic.index === i && canOpenStreamingEmphasis(line, i)) {
        flush();
        spans.push({ text: stripDecorativeEmoji(partialItalic[1]), italic: true });
        i = STREAMING_RE.italic.lastIndex;
        continue;
      }
    }
    RE.bold.lastIndex = i;
    const bold = RE.bold.exec(line);
    if (bold && bold.index === i) {
      flush();
      spans.push({ text: stripDecorativeEmoji(bold[1]), bold: true });
      i = RE.bold.lastIndex;
      continue;
    }
    // Streaming partials run before completed lower-precedence emphasis so a
    // tail such as `***both**` keeps its opened bold-italic kind throughout.
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
  // Trim the space an edge emoji orphaned at the true line boundary — only when
  // emoji were actually removed (else plain indentation is significant), and
  // only on plain runs (code/link edges are meaningful). Interior plain spans
  // are never empty (flush only pushes non-empty), so an empty edge span means
  // the trim consumed it; drop those.
  if (didStrip) {
    const first = spans[0];
    if (first && !first.code && !first.link && !first.image) {
      first.text = first.text.replace(/^ +/, '');
    }
    const last = spans[spans.length - 1];
    if (last && !last.code && !last.link && !last.image) {
      last.text = last.text.replace(/ +$/, '');
    }
  }
  const kept = spans.filter((span) => span.text !== '' || span.code || span.link || span.image);
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
  | 'table'
  | 'blank';

export interface MdLine {
  kind: MdLineKind;
  /** Inline spans for text-bearing kinds. */
  spans?: InlineSpan[];
  /** Leading marker rendered dim (bullet glyph, `N.`, quote rail). */
  marker?: string;
  /** ATX heading depth (1–6). */
  depth?: number;
  /** GFM task-list item. */
  task?: boolean;
  checked?: boolean;
  /** Verbatim content for code/fence lines. */
  raw?: string;
  /** Fence language tag, when present. */
  lang?: string;
  /**
   * Syntax-highlighted spans for a `code` line, stamped on fence close when the
   * language has a lexer. Absent → render the raw line flat-muted (the look
   * before highlighting, and the fallback for unsupported languages). Whitespace
   * is preserved: concatenating `codeSpans[*].text` reproduces `raw` exactly.
   */
  codeSpans?: CodeSpan[];
  role?: TableRowRole;
  cells?: InlineSpan[][];
  table?: MdTableLayout;
}

const HR = /^\s*([-*_])\1{2,}\s*$/;
const FENCE = /^\s*```(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const STREAMING_TASK = /^\[([ xX])\]?$/;
const TABLE_DELIMITER = /^:?-{3,}:?$/;

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function structuralPipeIndexes(line: string): number[] {
  const indexes: number[] = [];
  let inCode = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '`' && !isEscaped(line, i)) {
      inCode = !inCode;
      continue;
    }
    if (ch === '|' && !inCode && !isEscaped(line, i)) indexes.push(i);
  }
  return indexes;
}

function splitTableCells(raw: string): string[] | null {
  const line = raw.trim();
  const pipes = structuralPipeIndexes(line);
  if (pipes.length === 0) return null;

  const boundaries = pipes.filter((index) => index !== 0 && index !== line.length - 1);
  const cells: string[] = [];
  let start = pipes[0] === 0 ? 1 : 0;
  for (const boundary of boundaries) {
    cells.push(line.slice(start, boundary).trim().replace(/\\\|/g, '|'));
    start = boundary + 1;
  }
  const end = pipes[pipes.length - 1] === line.length - 1 ? line.length - 1 : line.length;
  cells.push(line.slice(start, end).trim().replace(/\\\|/g, '|'));
  return cells;
}

function parseTableDelimiter(raw: string, columnCount: number): TableAlignment[] | null {
  const cells = splitTableCells(raw);
  if (!cells || cells.length !== columnCount) return null;
  const alignments: TableAlignment[] = [];
  for (const cell of cells) {
    const trimmed = cell.trim();
    if (!TABLE_DELIMITER.test(trimmed)) return null;
    const left = trimmed.startsWith(':');
    const right = trimmed.endsWith(':');
    alignments.push(left && right ? 'center' : right ? 'right' : 'left');
  }
  return alignments;
}

function spanDisplayWidth(spans: InlineSpan[]): number {
  let width = 0;
  for (const span of spans) {
    width += displayWidth(span.text);
    if ((span.link || span.image) && span.url && span.url !== span.text) {
      width += (span.text ? 1 : 0) + displayWidth(span.url);
    }
  }
  return width;
}

function normalizeBodyCells(cells: string[], columnCount: number): string[] {
  if (cells.length === columnCount) return cells;
  if (cells.length > columnCount) return cells.slice(0, columnCount);
  return [...cells, ...Array.from({ length: columnCount - cells.length }, () => '')];
}

// A pipe-containing line can still be a heading / quote / list / rule; those
// block constructs outrank table recognition (GFM precedence). Used to stop a
// table from swallowing its own header line or absorbing a following block row.
function isBlockConstruct(line: string): boolean {
  return (
    HEADING.test(line) ||
    QUOTE.test(line) ||
    ORDERED.test(line) ||
    BULLET.test(line) ||
    HR.test(line)
  );
}

function tryParseTable(
  rawLines: string[],
  start: number,
  streamingTailIndex: number,
): { lines: MdLine[]; next: number } | null {
  // A header that is itself a block construct (e.g. `# A | B`) stays that block,
  // never a table header.
  if (isBlockConstruct(rawLines[start] ?? '')) return null;
  const headerCells = splitTableCells(rawLines[start] ?? '');
  if (!headerCells || headerCells.length < 2) return null;

  const alignments = parseTableDelimiter(rawLines[start + 1] ?? '', headerCells.length);
  if (!alignments) return null;

  const parseCells = (
    cells: string[],
    rowIndex: number,
    raw: string,
    tailColumn = cells.length - 1,
  ): InlineSpan[][] => {
    const hasOpenTailCell = rowIndex === streamingTailIndex && !raw.trimEnd().endsWith('|');
    return cells.map((cell, column) =>
      parseInline(cell, {
        streamingTail: hasOpenTailCell && column === tailColumn,
      }),
    );
  };

  const rows: Array<{
    role: TableRowRole;
    raw: string;
    spans: InlineSpan[];
    cells: InlineSpan[][];
  }> = [
    {
      role: 'header',
      raw: rawLines[start],
      spans: parseInline(rawLines[start], { streamingTail: start === streamingTailIndex }),
      cells: parseCells(headerCells, start, rawLines[start]),
    },
    {
      role: 'divider',
      raw: rawLines[start + 1],
      spans: parseInline(rawLines[start + 1], {
        streamingTail: start + 1 === streamingTailIndex,
      }),
      cells: headerCells.map(() => [{ text: '' }]),
    },
  ];

  let next = start + 2;
  while (next < rawLines.length && rawLines[next].trim() !== '') {
    // A block-construct row (heading/quote/list/rule with a pipe) ends the
    // table and is reclassified by the caller, rather than absorbed as a body row.
    if (isBlockConstruct(rawLines[next])) break;
    const cells = splitTableCells(rawLines[next]);
    if (!cells) break;
    // An overfull row would lose cells under GFM's ignore-excess rule; the
    // whole candidate falls back to lossless raw text instead (no content is
    // silently dropped — the fit-or-raw promise).
    if (cells.length > headerCells.length) return null;
    const normalizedCells = normalizeBodyCells(cells, headerCells.length);
    rows.push({
      role: 'body',
      raw: rawLines[next],
      spans: parseInline(rawLines[next], { streamingTail: next === streamingTailIndex }),
      cells: parseCells(normalizedCells, next, rawLines[next], cells.length - 1),
    });
    next += 1;
  }

  const columnWidths = Array.from({ length: headerCells.length }, (_, column) =>
    Math.max(
      ...rows
        .filter((row) => row.role !== 'divider')
        .map((row) => spanDisplayWidth(row.cells[column] ?? [])),
    ),
  );
  const formattedWidth =
    columnWidths.reduce((sum, width) => sum + width, 0) + Math.max(0, headerCells.length - 1) * 3;
  const table: MdTableLayout = Object.freeze({
    columnWidths: Object.freeze(columnWidths) as number[],
    alignments: Object.freeze(alignments) as TableAlignment[],
    formattedWidth,
  });

  return {
    lines: rows.map((row) => ({
      kind: 'table',
      role: row.role,
      raw: row.raw,
      spans: row.spans,
      cells: row.cells,
      table,
    })),
    next,
  };
}

/**
 * Parse `text` into one `MdLine` per source line (line count preserved).
 * Fenced blocks toggle on ``` and render verbatim; everything else is
 * classified and inline-parsed.
 */
export interface ParseMarkdownOptions {
  /** Apply incomplete-inline repair to the active final source line. */
  streaming?: boolean;
}

export function parseMarkdown(text: string, options: ParseMarkdownOptions = {}): MdLine[] {
  const out: MdLine[] = [];
  const rawLines = text.split(/\r?\n/);
  const streamingTailIndex = options.streaming ? rawLines.length - 1 : -1;
  let inFence = false;
  // Open fence's language + the code-line objects collected so far, so the
  // whole block can be highlighted at once on close. Block-level, not
  // line-level, is required: a multi-line string or block comment is only
  // tokenized correctly with the lines above it in hand.
  let fenceLang = '';
  let fenceCodeLines: MdLine[] = [];
  const closeFence = () => {
    stampHighlight(fenceLang, fenceCodeLines);
    fenceCodeLines = [];
    fenceLang = '';
  };
  // Split on CRLF as well as LF so a stray `\r` never lands in a rendered cell
  // (it would carriage-return the terminal). Count is unchanged either way.
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index];
    const fence = FENCE.exec(raw);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceLang = fence[1].trim();
        out.push({ kind: 'fence', lang: fenceLang });
        continue;
      }
      // Inside a fence, only a bare ``` (nothing but whitespace after the
      // backticks) closes it. A ```-prefixed line carrying an info string is
      // verbatim code content — treating it as a close drops the rest of the
      // block (CommonMark closing-fence rule).
      if (fence[1].trim() === '') {
        inFence = false;
        closeFence();
        out.push({ kind: 'fence', lang: '' });
        continue;
      }
    }
    if (inFence) {
      const codeLine: MdLine = { kind: 'code', raw };
      fenceCodeLines.push(codeLine);
      out.push(codeLine);
      continue;
    }
    const table = tryParseTable(rawLines, index, streamingTailIndex);
    if (table) {
      out.push(...table.lines);
      index = table.next - 1;
      continue;
    }
    if (raw.trim() === '') {
      out.push({ kind: 'blank' });
      continue;
    }
    if (HR.test(raw)) {
      // Keep the rule's visible length so the render stays width-non-increasing
      // (an 8-cell rule from `---` could add a wrap row on a narrow terminal).
      out.push({ kind: 'hr', raw: raw.trim() });
      continue;
    }
    const heading = HEADING.exec(raw);
    if (heading) {
      out.push({
        kind: 'heading',
        depth: heading[1].length,
        spans: parseInline(heading[2], { streamingTail: index === streamingTailIndex }),
      });
      continue;
    }
    const quote = QUOTE.exec(raw);
    if (quote) {
      out.push({
        kind: 'quote',
        spans: parseInline(quote[1], { streamingTail: index === streamingTailIndex }),
      });
      continue;
    }
    const ordered = ORDERED.exec(raw);
    if (ordered) {
      out.push({
        kind: 'ordered',
        marker: `${ordered[1]}${ordered[2]}. `,
        spans: parseInline(ordered[3], { streamingTail: index === streamingTailIndex }),
      });
      continue;
    }
    const bullet = BULLET.exec(raw);
    if (bullet) {
      const streamingTail = index === streamingTailIndex;
      const task = TASK.exec(bullet[2]);
      const partialTask = streamingTail ? STREAMING_TASK.exec(bullet[2]) : null;
      const partialTaskStart = streamingTail && bullet[2] === '[';
      const taskState = task?.[1] ?? partialTask?.[1];
      out.push({
        kind: 'bullet',
        marker: bullet[1],
        ...(taskState ? { task: true, checked: taskState.toLowerCase() === 'x' } : {}),
        // Once `[` can only be growing into a task marker, keep its literal
        // cells out of the active tail. The state glyph appears as soon as the
        // state cell arrives; settled malformed bullets remain untouched.
        spans: parseInline(task?.[2] ?? (partialTask || partialTaskStart ? '' : bullet[2]), {
          streamingTail,
        }),
      });
      continue;
    }
    out.push({
      kind: 'text',
      spans: parseInline(raw, { streamingTail: index === streamingTailIndex }),
    });
  }
  // An unterminated fence (streaming mid-block, or a missing close) still gets
  // highlighted — the collected lines are valid code, just without a trailing
  // ```. Nothing calls closeFence() for it otherwise.
  if (inFence) closeFence();
  return out;
}

/**
 * Highlight a fenced block's collected `code` lines in place. A no-op when the
 * language has no lexer (`highlightToSpans` returns null) — those lines keep
 * `codeSpans` unset and render flat-muted. The highlighter preserves line
 * count, so spans zip onto lines by index.
 */
function stampHighlight(lang: string, codeLines: MdLine[]): void {
  if (codeLines.length === 0) return;
  const spanLines = highlightToSpans(codeLines.map((l) => l.raw ?? '').join('\n'), lang);
  if (!spanLines) return;
  for (let i = 0; i < codeLines.length; i += 1) {
    const spans = spanLines[i];
    if (spans && spans.length > 0) codeLines[i].codeSpans = spans;
  }
}

// ── Render ────────────────────────────────────────────────────────────

interface Marks {
  bullet: string;
  taskOpen: string;
  taskDone: string;
  headingStrong: string;
  headingMedium: string;
  headingSubtle: string;
  quoteRail: string;
  /** Single rule cell, repeated to the source rule's visible length. */
  hrCell: string;
  tableRail: string;
  tableDivider: string;
  tableJunction: string;
}

function marksFor(unicode: boolean): Marks {
  return unicode
    ? {
        bullet: '• ',
        // Force text presentation so terminals do not promote these generated
        // chrome glyphs to two-cell, full-color emoji.
        taskOpen: '☐\uFE0E ',
        taskDone: '☑\uFE0E ',
        headingStrong: '▌ ',
        headingMedium: '▪\uFE0E ',
        headingSubtle: '· ',
        quoteRail: '│ ',
        hrCell: '─',
        tableRail: '│',
        tableDivider: '─',
        tableJunction: '┼',
      }
    : {
        bullet: '- ',
        taskOpen: '[ ] ',
        taskDone: '[x] ',
        headingStrong: '# ',
        headingMedium: '## ',
        headingSubtle: '### ',
        quoteRail: '| ',
        hrCell: '-',
        tableRail: '|',
        tableDivider: '-',
        tableJunction: '+',
      };
}

function spanColor(
  span: InlineSpan,
  base: VlColor | undefined,
  interactive = span.link || span.image,
): VlColor | undefined {
  if (span.code) return VL_COLOR.code;
  if (interactive) return VL_COLOR.link;
  return base;
}

function Spans({
  spans,
  base,
  strike = false,
}: {
  spans: InlineSpan[];
  base: VlColor | undefined;
  strike?: boolean;
}) {
  return (
    <>
      {spans.map((span, index) => {
        const href = span.url ? safeTerminalUrl(span.url)?.href : null;
        const isLinkLike = span.link || span.image;
        const label = !span.text ? null : href ? (
          <Link
            href={href}
            bold={span.bold}
            italic={span.italic}
            strikethrough={strike || span.strike}
            color={spanColor(span, base, true)}
          >
            {span.text}
          </Link>
        ) : (
          <Text
            bold={span.bold}
            backgroundColor={span.code ? '$bg-surface-subtle' : undefined}
            italic={span.italic}
            strikethrough={strike || span.strike}
            color={spanColor(span, base, false)}
          >
            {span.text}
          </Text>
        );
        return (
          <React.Fragment key={index}>
            {label}
            {isLinkLike && span.url && span.url !== span.text ? (
              href ? (
                <Link href={href} color={VL_COLOR.muted}>
                  {span.text ? ' ' : ''}
                  {span.url}
                </Link>
              ) : (
                <Text color={VL_COLOR.muted}>
                  {span.text ? ' ' : ''}
                  {span.url}
                </Text>
              )
            ) : null}
          </React.Fragment>
        );
      })}
    </>
  );
}

function padFor(width: number, contentWidth: number, alignment: TableAlignment): [string, string] {
  const total = Math.max(0, width - contentWidth);
  if (alignment === 'right') return [' '.repeat(total), ''];
  if (alignment === 'center') {
    const left = Math.floor(total / 2);
    return [' '.repeat(left), ' '.repeat(total - left)];
  }
  return ['', ' '.repeat(total)];
}

function TableCell({
  spans,
  width,
  alignment,
  base,
  header,
}: {
  spans: InlineSpan[];
  width: number;
  alignment: TableAlignment;
  base: VlColor | undefined;
  header: boolean;
}) {
  const [before, after] = padFor(width, spanDisplayWidth(spans), alignment);
  const cellBase = header ? VL_COLOR.info : base;
  return (
    <Text bold={header} color={cellBase}>
      {before}
      <Spans spans={spans} base={cellBase} />
      {after}
    </Text>
  );
}

function RawTextLine({ line, base }: { line: MdLine; base: VlColor | undefined }) {
  return (
    <Text color={base}>
      <Spans spans={line.spans ?? parseInline(line.raw ?? '')} base={base} />
    </Text>
  );
}

function TableLineView({
  line,
  base,
  marks,
  availableWidth,
}: {
  line: MdLine;
  base: VlColor | undefined;
  marks: Marks;
  availableWidth: number | undefined;
}) {
  const table = line.table;
  if (
    !table ||
    !line.role ||
    !line.cells ||
    !availableWidth ||
    table.formattedWidth > availableWidth
  ) {
    return <RawTextLine line={line} base={base} />;
  }
  if (line.role === 'divider') {
    return (
      <Text color={VL_COLOR.muted}>
        {table.columnWidths
          .map((width) => marks.tableDivider.repeat(width))
          .join(`${marks.tableDivider}${marks.tableJunction}${marks.tableDivider}`)}
      </Text>
    );
  }
  return (
    <Text color={base}>
      {line.cells.map((cell, index) => (
        <React.Fragment key={index}>
          {index > 0 ? <Text color={VL_COLOR.muted}> {marks.tableRail} </Text> : null}
          <TableCell
            spans={cell}
            width={table.columnWidths[index] ?? 0}
            alignment={table.alignments[index] ?? 'left'}
            base={base}
            header={line.role === 'header'}
          />
        </React.Fragment>
      ))}
    </Text>
  );
}

function LineView({
  line,
  base,
  marks,
  availableWidth,
}: {
  line: MdLine;
  base: VlColor | undefined;
  marks: Marks;
  availableWidth: number | undefined;
}) {
  switch (line.kind) {
    case 'blank':
      return <Text> </Text>;
    case 'hr':
      return (
        <Text color={VL_COLOR.muted}>
          {marks.hrCell.repeat(Math.max(1, (line.raw ?? '').length))}
        </Text>
      );
    case 'fence':
      return <Text color={VL_COLOR.code}>```{line.lang}</Text>;
    case 'code':
      // Highlighted when the fence had a known language; flat-muted otherwise
      // (unsupported language, or a whitespace-only line with no spans).
      if (line.codeSpans && line.codeSpans.length > 0) {
        return (
          <Text>
            {line.codeSpans.map((span, index) => (
              <Text key={index} color={span.color}>
                {span.text}
              </Text>
            ))}
          </Text>
        );
      }
      return <Text color={VL_COLOR.code}>{line.raw || ' '}</Text>;
    case 'heading': {
      const depth = line.depth ?? 1;
      const color = depth === 1 ? VL_COLOR.accent : depth === 2 ? VL_COLOR.info : VL_COLOR.muted;
      const marker =
        depth === 1 ? marks.headingStrong : depth === 2 ? marks.headingMedium : marks.headingSubtle;
      return (
        <Text bold={depth <= 2} italic={depth >= 3} underline={depth === 1} color={color}>
          {marker}
          <Spans spans={line.spans ?? []} base={color} />
        </Text>
      );
    }
    case 'quote':
      return (
        <Text color={VL_COLOR.muted}>
          <Text color={VL_COLOR.info}>{marks.quoteRail}</Text>
          <Spans spans={line.spans ?? []} base={VL_COLOR.muted} />
        </Text>
      );
    case 'bullet': {
      if (line.task) {
        const checked = line.checked === true;
        return (
          <Text color={checked ? VL_COLOR.muted : base}>
            {line.marker}
            <Text color={checked ? VL_COLOR.success : VL_COLOR.muted}>
              {checked ? marks.taskDone : marks.taskOpen}
            </Text>
            <Spans
              spans={line.spans ?? []}
              base={checked ? VL_COLOR.muted : base}
              strike={checked}
            />
          </Text>
        );
      }
      return (
        <Text color={base}>
          {line.marker}
          <Text color={VL_COLOR.muted}>{marks.bullet}</Text>
          <Spans spans={line.spans ?? []} base={base} />
        </Text>
      );
    }
    case 'ordered':
      return (
        <Text color={base}>
          <Text color={VL_COLOR.muted}>{line.marker}</Text>
          <Spans spans={line.spans ?? []} base={base} />
        </Text>
      );
    case 'table':
      return (
        <TableLineView line={line} base={base} marks={marks} availableWidth={availableWidth} />
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
 * Render assistant/independent-voice prose as styled Markdown under the
 * semantic palette. `base` is the inherited body color (undefined = default
 * stream text); structural and inline roles may override it per law 2.
 */
export function MarkdownBody({
  text,
  base,
  availableWidth,
  streaming = false,
}: {
  text: string;
  base?: VlColor;
  availableWidth?: number;
  /** True only for the currently growing machine-authored message. */
  streaming?: boolean;
}) {
  const unicode = useMemo(() => detectUnicode(), []);
  const lines = useMemo(() => parseMarkdown(text, { streaming }), [text, streaming]);
  const marks = useMemo(() => marksFor(unicode), [unicode]);
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <LineView
          key={index}
          line={line}
          base={base}
          marks={marks}
          availableWidth={availableWidth}
        />
      ))}
    </Box>
  );
}
