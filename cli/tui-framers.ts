/**
 * tui-framers.ts — Per-role transcript entry framing.
 *
 * Each transcript entry (user / assistant / tool_call / status / error /
 * warning / reasoning / verdict / divider) gets a small `EntryFramer` that
 * pushes display lines into a caller-owned array. `renderEntryLines`
 * dispatches by role through the `framers` table.
 *
 * Reserved, bullet-led shape inspired by Claude Code's transcript: no
 * colored-background badges, single-glyph role markers, indented branch
 * line for tool-call result previews. The intent is a flowing
 * conversational read instead of a sequence of labels.
 *
 * (Earlier versions of this file carried a second "standard" framer
 * table with boxed badges + a `LayoutMode` dispatch. That alternative
 * was dropped when we committed to the reserved look as the only
 * rendering — see git history for the prior shape if needed.)
 */
import type { Theme, TokenName } from './tui-theme.js';
import { truncate, visibleWidth, wordWrap } from './tui-renderer.js';
import { highlightCode } from './tui-highlight.js';
import { renderInline } from './tui-inline.js';
import { safeCitations, citationHost, sanitizeCitationText } from './citation-format.js';
import type { UrlCitation } from '../lib/provider-contract.ts';
import {
  createEditDiffGapTracker,
  isEditDiff,
  type EditDiff,
  type EditDiffLine,
} from '../lib/edit-diff.ts';

// ── Helpers ─────────────────────────────────────────────────────────

export interface BadgeOptions {
  fg?: TokenName;
  bg?: TokenName;
  bold?: boolean;
}

export function makeBadge(theme: Theme, label: string, opts: BadgeOptions = {}): string {
  const { fg = 'fg.primary', bg = 'border.default', bold = true } = opts;
  const text = ` ${label} `;
  const styled = theme.styleFgBg(fg, bg, text);
  return bold ? theme.bold(styled) : styled;
}

export function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

export function summarizeToolArgs(args: unknown, maxWidth: number): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  let preview = '';
  if (typeof a.command === 'string' && a.command) preview = a.command;
  else if (typeof a.path === 'string' && a.path) preview = a.path;
  else if (typeof a.file === 'string' && a.file) preview = a.file;
  else preview = safeJsonStringify(args);
  return truncate(preview, Math.max(1, maxWidth));
}

export interface ToolCallSpec {
  tool: string;
  args: unknown;
}

export function parseJsonToolCalls(text: string): ToolCallSpec[] | null {
  try {
    const parsed = JSON.parse(text);
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as { tool?: unknown }).tool === 'string'
    ) {
      const p = parsed as { tool: string; args?: unknown };
      return [{ tool: p.tool, args: p.args ?? null }];
    }
    if (Array.isArray(parsed)) {
      const calls = parsed
        .filter(
          (item): item is { tool: string; args?: unknown } =>
            !!item &&
            typeof item === 'object' &&
            typeof (item as { tool?: unknown }).tool === 'string',
        )
        .map((item) => ({ tool: item.tool, args: item.args ?? null }));
      return calls.length ? calls : null;
    }
  } catch {
    // fall through
  }
  return null;
}

export interface PushWrappedOptions {
  firstPrefix?: string;
  nextPrefix?: string;
  styleFn?: (s: string) => string;
}

export function pushWrappedLines(
  out: string[],
  text: string,
  width: number,
  opts: PushWrappedOptions = {},
): void {
  const { firstPrefix = '', styleFn = (s) => s } = opts;
  // Match the original `{ nextPrefix = firstPrefix }` destructure default:
  // only fall back when the caller did not provide a nextPrefix at all.
  const nextPrefix = opts.nextPrefix ?? firstPrefix;
  const raw = String(text ?? '');
  const rawLines = raw.split('\n');
  let firstRendered = false;

  for (const rawLine of rawLines) {
    const wrapWidth = Math.max(1, width - visibleWidth(firstRendered ? nextPrefix : firstPrefix));
    const wrapped = wordWrap(rawLine, wrapWidth);
    const segments = wrapped.length ? wrapped : [''];
    for (const segment of segments) {
      const prefix = firstRendered ? nextPrefix : firstPrefix;
      out.push(prefix + styleFn(segment));
      firstRendered = true;
    }
  }

  if (!firstRendered) {
    out.push(firstPrefix);
  }
}

// Conservative unified-diff sniff for untagged fences: a real hunk header, or
// both file headers present. Tight enough that prose containing a stray `+`/`-`
// line won't trip it — only fenced bodies that are unambiguously a patch.
export function looksLikeUnifiedDiff(body: string): boolean {
  if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(body)) return true;
  return /^--- /m.test(body) && /^\+\+\+ /m.test(body);
}

// ── Assistant rendering (markdown-aware) ────────────────────────────

export interface PayloadBlock {
  id: string;
  startLine: number;
  endLine: number;
  expanded: boolean;
  selected: boolean;
  visible: boolean;
  toolCount: number;
}

export interface PayloadUI {
  blocks?: PayloadBlock[];
  cursorId?: string | null;
  expandedIds?: Set<string> | null;
  inspectorOpen?: boolean;
}

export interface AssistantRenderOptions {
  expandToolJsonPayloads?: boolean;
  entryKey?: string | null;
  payloadUI?: PayloadUI | null;
  /**
   * When true, the leading bullet glyph is suppressed and the first line uses
   * the continuation prefix instead. Used by the streaming settle-and-freeze
   * path (tui-stream-frame.ts) when framing a chunk that is *not* the start of
   * the message — the bullet was already emitted by an earlier settled chunk.
   */
  firstPrefixConsumed?: boolean;
}

export function renderAssistantEntryLines(
  out: string[],
  text: string,
  width: number,
  theme: Theme,
  opts: AssistantRenderOptions = {},
): void {
  const {
    expandToolJsonPayloads = false,
    entryKey = null,
    payloadUI = null,
    firstPrefixConsumed = false,
  } = opts;

  // Single bullet prefix — same shape `assistantFramer` and the
  // streaming render path use. Earlier versions accepted a
  // `prefixOverride` so the badge-led layout could pass an `AI` badge
  // instead; that layout was dropped in PR #552. Inlining the prefix
  // here keeps the renderer honest and prevents a future caller from
  // accidentally re-introducing the deleted styling by omitting the
  // override.
  const bullet = bulletGlyph(theme);
  const firstPrefix = `${theme.style('fg.muted', bullet)} `;
  const nextPrefix = '  ';
  let canUseFirstPrefix = !firstPrefixConsumed;
  let jsonFenceOrdinal = 0;

  const pushAssistant = (
    lineText: string,
    styleFn: (s: string) => string = (s) => theme.style('fg.primary', s),
  ): void => {
    pushWrappedLines(out, lineText, width, {
      firstPrefix: canUseFirstPrefix ? firstPrefix : nextPrefix,
      nextPrefix,
      styleFn,
    });
    canUseFirstPrefix = false;
  };

  const pushToolSummary = (summary: string): void => {
    pushAssistant(summary, (s) => theme.style('accent.secondary', s));
  };

  // Render inline markdown (bold / code / links) for a prose-like line: the
  // result is pre-styled per-word ANSI, so push with an identity styleFn exactly
  // like the code-fence path. `linePrefix` carries any already-styled leading
  // text (e.g. a list marker) that should sit on the same line. Per-line link
  // footnotes are pushed beneath, indented two spaces under the line.
  const pushInline = (lineText: string, baseToken: TokenName, linePrefix = ''): void => {
    const inlined = renderInline(theme, lineText, baseToken);
    pushAssistant(linePrefix + inlined.text, (s) => s);
    for (const footnote of inlined.footnotes) {
      pushAssistant(`  ${footnote}`, (s) => s);
    }
  };

  // Syntax-highlight a code fence and push it line by line. Lines come back
  // pre-styled into balanced per-word ANSI, so we push with an identity
  // styleFn — wrapping a styled run is safe because no colour is ever left
  // open across a space (see tui-highlight.ts). Highlighting never changes
  // visible width, so the existing wrap/layout math is untouched.
  const pushHighlightedFence = (lang: string): void => {
    for (const hl of highlightCode(theme, fenceBuf.join('\n'), lang)) {
      pushAssistant(hl, (s) => s);
    }
  };

  // Render a unified-diff fence with a colored left gutter bar so the change
  // reads as a scannable block instead of relying on the easily-missed leading
  // +/- char. The bar carries the meaning (green add / red remove / blue hunk),
  // so the marker char is stripped from the content. Degrades cleanly: ascii
  // gutter is `|`; at tier `none` (no color) the gutter falls back to the
  // literal +/- marker so the diff stays legible without color. Lines are
  // truncated (not wrapped) to keep the gutter column flush — the untruncated
  // text is still available via `/copy`.
  const pushDiffFence = (): void => {
    const gutterGlyph = theme.unicode ? '▌' : '|';
    const noColor = theme.tier === 'none';
    let adds = 0;
    let dels = 0;
    for (const l of fenceBuf) {
      if (/^\+(?!\+\+)/.test(l)) adds++;
      else if (/^-(?!--)/.test(l)) dels++;
    }
    const label = noColor
      ? `diff (+${adds} -${dels})`
      : `${theme.style('fg.dim', 'diff ·')} ${theme.style('state.success', `+${adds}`)} ${theme.style('state.error', `-${dels}`)}`;
    pushAssistant(label, (s) => s);

    const avail = Math.max(4, width - visibleWidth(nextPrefix) - 2);
    for (const raw of fenceBuf) {
      let token: TokenName = 'fg.secondary';
      let gutterToken: TokenName = 'fg.dim';
      let marker = ' ';
      let content = raw;
      if (/^@@/.test(raw)) {
        token = 'accent.link';
        gutterToken = 'accent.link';
      } else if (/^(\+\+\+|---|diff |index |new file|deleted file|rename |similarity )/.test(raw)) {
        token = 'fg.dim';
      } else if (raw.startsWith('+')) {
        token = 'state.success';
        gutterToken = 'state.success';
        marker = '+';
        content = raw.slice(1);
      } else if (raw.startsWith('-')) {
        token = 'state.error';
        gutterToken = 'state.error';
        marker = '-';
        content = raw.slice(1);
      } else if (raw.startsWith(' ')) {
        content = raw.slice(1);
      }
      const gutter = noColor ? marker : theme.style(gutterToken, gutterGlyph);
      pushAssistant(`${gutter} ${theme.style(token, truncate(content, avail))}`, (s) => s);
    }
  };

  const lines = String(text ?? '').split('\n');
  let fenceLang: string | null = null;
  let fenceBuf: string[] = [];

  const flushFence = (): void => {
    const body = fenceBuf.join('\n').trim();
    const lang = (fenceLang || '').toLowerCase();
    const jsonFenceIndex = lang === 'json' ? jsonFenceOrdinal++ : null;
    const payloadId =
      lang === 'json' && entryKey != null ? `${entryKey}:json:${jsonFenceIndex}` : null;
    const selected = Boolean(payloadId && payloadUI?.cursorId === payloadId);
    const expandedByBlock = Boolean(payloadId && payloadUI?.expandedIds?.has(payloadId));
    const expanded = expandToolJsonPayloads || expandedByBlock;

    if (lang === 'json' && body) {
      const toolCalls = parseJsonToolCalls(body);
      if (toolCalls) {
        const blockStart = out.length;
        const marker = expanded ? (theme.unicode ? '▾' : 'v') : theme.unicode ? '▸' : '>';
        const countLabel =
          toolCalls.length === 1 ? '1 tool call' : `${toolCalls.length} tool calls`;
        const modeHint = expanded ? 'expanded' : 'collapsed';
        const headerText = `${marker} JSON payload · ${countLabel} · ${modeHint}`;
        pushAssistant(headerText, (s) => {
          if (selected && payloadUI?.inspectorOpen) return theme.inverse(s);
          return theme.style('fg.dim', s);
        });

        if (expanded) {
          pushHighlightedFence('json');
        } else {
          for (const call of toolCalls) {
            const preview = summarizeToolArgs(call.args, Math.max(10, width - 28));
            const summary = preview
              ? `${theme.glyphs.arrow} ${call.tool}  ${theme.style('fg.dim', preview)}`
              : `${theme.glyphs.arrow} ${call.tool}`;
            pushToolSummary(summary);
          }
        }

        if (payloadId && Array.isArray(payloadUI?.blocks)) {
          payloadUI.blocks.push({
            id: payloadId,
            startLine: blockStart,
            endLine: Math.max(blockStart, out.length - 1),
            expanded,
            selected,
            visible: false,
            toolCount: toolCalls.length,
          });
        }

        fenceLang = null;
        fenceBuf = [];
        return;
      }
    }

    if ((lang === 'diff' || lang === 'patch' || (!lang && looksLikeUnifiedDiff(body))) && body) {
      pushDiffFence();
      fenceLang = null;
      fenceBuf = [];
      return;
    }

    if (body) {
      const label = lang ? `code (${lang})` : 'code';
      pushAssistant(label, (s) => theme.style('fg.dim', s));
      pushHighlightedFence(lang);
    }

    fenceLang = null;
    fenceBuf = [];
  };

  for (const rawLine of lines) {
    const fenceMatch = rawLine.match(/^```([A-Za-z0-9_-]+)?\s*$/);
    if (fenceMatch) {
      if (fenceLang == null) {
        fenceLang = fenceMatch[1] || '';
        fenceBuf = [];
      } else {
        flushFence();
      }
      continue;
    }
    if (fenceLang != null) {
      fenceBuf.push(rawLine);
      continue;
    }

    const line = rawLine;
    if (line.trim() === '') {
      pushAssistant('', (s) => s);
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      pushAssistant(
        theme.glyphs.horizontal.repeat(Math.max(6, Math.min(width - visibleWidth(nextPrefix), 24))),
        (s) => theme.style('fg.dim', s),
      );
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (heading) {
      pushAssistant(heading[2], (s) => theme.bold(theme.style('accent.link', s)));
      continue;
    }

    const bullet = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (bullet) {
      const indent = ' '.repeat(Math.min(4, bullet[1].length));
      // Keep the list marker in the base colour; inline-render only the text.
      const marker = `${indent}${theme.style('fg.primary', bullet[2])} `;
      pushInline(bullet[3], 'fg.primary', marker);
      continue;
    }

    if (/^\s*>\s+/.test(line)) {
      pushInline(line.replace(/^\s*>\s+/, ''), 'fg.secondary');
      continue;
    }

    pushInline(line, 'fg.primary');
  }

  if (fenceLang != null) flushFence();
}

// ── Per-role framers ────────────────────────────────────────────────

export type Role =
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'activity_group'
  | 'status'
  | 'error'
  | 'warning'
  | 'reasoning'
  | 'sources'
  | 'verdict'
  | 'divider';

export interface FramerContext {
  expandToolJsonPayloads?: boolean;
  entryKey?: string | null;
  payloadUI?: PayloadUI | null;
}

// Loose shape — each framer reads only the fields it needs. Kept open
// because the transcript queue carries different per-role payloads and
// type-narrowing them across the dispatch boundary buys nothing here.
export interface TranscriptEntry {
  role: string;
  text?: string;
  args?: unknown;
  duration?: number;
  error?: boolean;
  resultPreview?: string;
  /** Structured edit diff from `tool.execution_complete` (`payload.diff`);
   *  validated with `isEditDiff` before rendering. */
  editDiff?: unknown;
  verdict?: 'APPROVED' | 'DENIED' | string;
  kind?: string;
  summary?: string;
  timestamp?: number;
  [k: string]: unknown;
}

export interface EntryFramer {
  render(
    out: string[],
    entry: TranscriptEntry,
    width: number,
    theme: Theme,
    ctx: FramerContext,
  ): void;
}

function bulletGlyph(theme: Theme): string {
  return theme.unicode ? '•' : '*';
}

function branchGlyph(theme: Theme): string {
  // ASCII fallback follows GNU `tree -A`'s corner glyph: `+--`. The
  // earlier `'L  '` sat awkwardly between letter and tree-corner; +--
  // reads unambiguously as a branch in non-Unicode terminals.
  return theme.unicode ? '└─ ' : '+--';
}

const userFramer: EntryFramer = {
  render(out, entry, width, theme) {
    const bullet = bulletGlyph(theme);
    const firstPrefix = `${theme.style('accent.primary', bullet)} `;
    const nextPrefix = '  ';
    pushWrappedLines(out, String(entry.text ?? ''), width, {
      firstPrefix,
      nextPrefix,
      styleFn: (s) => theme.style('fg.primary', s),
    });
  },
};

const assistantFramer: EntryFramer = {
  render(out, entry, width, theme, ctx) {
    renderAssistantEntryLines(out, String(entry.text ?? ''), width, theme, {
      expandToolJsonPayloads: ctx.expandToolJsonPayloads,
      entryKey: ctx.entryKey,
      payloadUI: ctx.payloadUI,
    });
  },
};

// ── Edit-card diff rendering ────────────────────────────────────────

/** Human summary for the edit-card trailer: "Added 3 lines", "Removed 1
 *  line", or "+3 -1" for mixed changes. */
export function summarizeEditDiff(diff: EditDiff): string {
  if (diff.adds > 0 && diff.dels === 0) {
    return `Added ${diff.adds} line${diff.adds === 1 ? '' : 's'}`;
  }
  if (diff.dels > 0 && diff.adds === 0) {
    return `Removed ${diff.dels} line${diff.dels === 1 ? '' : 's'}`;
  }
  return `+${diff.adds} -${diff.dels}`;
}

/** The line number shown in the gutter: new-file number for adds/context,
 *  old-file number for deletions (matching git/GitHub reading habits). */
function editDiffGutterNumber(line: EditDiffLine): number | null {
  if (line.kind === 'del') return line.oldLine ?? null;
  return line.newLine ?? line.oldLine ?? null;
}

/**
 * Render a structured `EditDiff` as a Claude-Code-style edit card under a
 * tool-call entry: right-aligned line-number gutter, `+`/`-` markers, and
 * added/removed lines tinted with the `diff.addBg` / `diff.delBg` tokens
 * (padded to full width so the change reads as a block). Context lines
 * stay dim. A jump in gutter numbers between consecutive lines renders a
 * `⋮` gap row. Long lines truncate (not wrap) to keep the gutter column
 * flush — the full text lives in the file, not the transcript.
 *
 * Degrades cleanly: 16-color terminals have no bg fallback for the diff
 * tokens, so lines fall back to green/red foreground; tier `none` keeps
 * the `+`/`-` markers as the only signal.
 */
export function renderEditDiffLines(
  out: string[],
  diff: EditDiff,
  width: number,
  theme: Theme,
): void {
  const branch = branchGlyph(theme);
  const summaryPrefix = `  ${theme.style('fg.dim', branch)}`;
  out.push(`${summaryPrefix}${theme.style('fg.muted', summarizeEditDiff(diff))}`);

  const numWidth = diff.lines.reduce((w, line) => {
    const num = editDiffGutterNumber(line);
    return Math.max(w, num === null ? 0 : String(num).length);
  }, 1);
  const indent = '     ';
  const gapGlyph = theme.unicode ? '⋮' : ':';
  // indent + number column + space + marker + space
  const contentWidth = Math.max(4, width - indent.length - numWidth - 3);
  // Only pad to a solid block when the tier actually renders a bg — at 16
  // colors / no color the pad would just be trailing whitespace.
  const hasDiffBg = theme.bg('diff.addBg') !== '' || theme.bg('diff.delBg') !== '';

  // Gap row when consecutive hunks skip lines — coordinate-aware tracker
  // shared with renderEditDiffText (lib/edit-diff.ts).
  const startsNewHunk = createEditDiffGapTracker();
  for (const line of diff.lines) {
    const num = editDiffGutterNumber(line);
    if (startsNewHunk(line)) {
      out.push(`${indent}${' '.repeat(numWidth)} ${theme.style('fg.dim', gapGlyph)}`);
    }

    const numStr = (num === null ? '' : String(num)).padStart(numWidth);
    const text = truncate(line.text + (line.textTruncated ? '…' : ''), contentWidth);
    // Pad by *visible* width (not JS length) so wide glyphs don't break the
    // solid bg block.
    const pad = (s: string): string =>
      hasDiffBg ? s + ' '.repeat(Math.max(0, contentWidth + 1 - visibleWidth(s))) : s;
    if (line.kind === 'add') {
      out.push(
        `${indent}${theme.style('state.success', `${numStr} +`)}${theme.styleFgBg('state.success', 'diff.addBg', pad(` ${text}`))}`,
      );
    } else if (line.kind === 'del') {
      out.push(
        `${indent}${theme.style('state.error', `${numStr} -`)}${theme.styleFgBg('state.error', 'diff.delBg', pad(` ${text}`))}`,
      );
    } else {
      out.push(`${indent}${theme.style('fg.dim', numStr)}   ${theme.style('fg.secondary', text)}`);
    }
  }

  if (diff.truncated) {
    out.push(`${indent}${theme.style('fg.dim', `${theme.glyphs.ellipsis} diff truncated`)}`);
  }
}

const toolCallFramer: EntryFramer = {
  render(out, entry, width, theme) {
    const { glyphs } = theme;
    const pending = entry.error !== true && !entry.duration;
    const status = pending
      ? theme.style('accent.secondary', '…')
      : entry.error
        ? theme.style('state.error', glyphs.cross_mark || 'ERR')
        : theme.style('state.success', glyphs.check || 'OK');
    const bullet = bulletGlyph(theme);
    const firstPrefix = `${theme.style('fg.muted', bullet)} `;
    const nextPrefix = '  ';
    const verb = theme.bold(theme.style('fg.primary', String(entry.text ?? '')));
    const argsHint = summarizeToolArgs(entry.args, Math.max(10, width - 24));
    const argsStr = argsHint ? theme.style('fg.dim', `(${argsHint})`) : '';
    const dur = entry.duration ? theme.style('fg.dim', ` ${entry.duration}ms`) : '';
    const head = `${status} ${verb}${argsStr}${dur}`;
    pushWrappedLines(out, head, width, {
      firstPrefix,
      nextPrefix,
      styleFn: (s) => s, // segments already pre-styled
    });
    // A structured edit diff replaces the one-line preview — the card
    // already says what changed, and better.
    if (!pending && !entry.error && isEditDiff(entry.editDiff)) {
      renderEditDiffLines(out, entry.editDiff, width, theme);
      return;
    }
    if (entry.resultPreview && !pending) {
      const branch = branchGlyph(theme);
      const trailerPrefix = `  ${theme.style('fg.dim', branch)}`;
      const trailerCont = ' '.repeat(visibleWidth(trailerPrefix));
      const previewLine = String(entry.resultPreview).split('\n')[0].trim();
      if (previewLine) {
        const previewStr = truncate(
          previewLine,
          Math.max(10, width - visibleWidth(trailerCont) - 4),
        );
        pushWrappedLines(out, previewStr, width, {
          firstPrefix: trailerPrefix,
          nextPrefix: trailerCont,
          styleFn: (s) => theme.style('fg.dim', s),
        });
      }
    }
  },
};

function formatActivityDuration(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function activityToolVerb(name: string): string {
  const normalized = name.toLowerCase();
  if (/(?:edit|write|patch|replace)/.test(normalized)) return 'Edit';
  if (/(?:read|fetch|get_|show)/.test(normalized)) return 'Read';
  if (/(?:search|grep|find)/.test(normalized)) return 'Search';
  if (/(?:exec|run|test|check)/.test(normalized)) return 'Run';
  if (/(?:list)/.test(normalized)) return 'List';
  return name;
}

function renderActivityTool(
  out: string[],
  item: TranscriptEntry,
  width: number,
  theme: Theme,
  showDetails: boolean,
): void {
  const pending = item.error !== true && item.duration === undefined;
  const status = pending
    ? theme.style('accent.secondary', theme.unicode ? '◆' : '*')
    : item.error
      ? theme.style('state.error', theme.glyphs.cross_mark || 'x')
      : theme.style('state.success', theme.unicode ? '◆' : '*');
  const name = String(item.text ?? 'tool');
  const target = summarizeToolArgs(item.args, Math.max(10, width - 28));
  const duration = formatActivityDuration(item.duration);
  const label = theme.bold(theme.style('fg.primary', activityToolVerb(name)));
  const targetText = target ? ` ${theme.style('accent.secondary', target)}` : '';
  const durationText = duration ? theme.style('fg.dim', `  ${duration}`) : '';
  out.push(`  ${status} ${label}${targetText}${durationText}`);

  const important = item.error === true || isEditDiff(item.editDiff);
  if (!showDetails && !important) return;
  if (!pending && !item.error && isEditDiff(item.editDiff)) {
    renderEditDiffLines(out, item.editDiff, width, theme);
    return;
  }
  if (item.resultPreview && !pending) {
    const preview = String(item.resultPreview).split('\n')[0].trim();
    if (preview) out.push(`      ${theme.style('fg.dim', truncate(preview, width - 6))}`);
  }
}

const activityGroupFramer: EntryFramer = {
  render(out, entry, width, theme) {
    const items = Array.isArray(entry.items) ? (entry.items as TranscriptEntry[]) : [];
    if (items.length === 0) return;
    const expanded = entry.expanded !== false;
    const selected = entry.selected === true;
    const marker = expanded ? (theme.unicode ? '▾' : 'v') : theme.unicode ? '▸' : '>';
    const failures = items.filter((item) => item.kind === 'tool' && item.error === true).length;
    const edits = items.filter((item) => item.kind === 'tool' && isEditDiff(item.editDiff)).length;
    const details = [
      `${items.length} step${items.length === 1 ? '' : 's'}`,
      edits ? `${edits} edit${edits === 1 ? '' : 's'}` : '',
      failures ? `${failures} failed` : '',
    ].filter(Boolean);
    const header = `${marker} ${details.join(' · ')}`;
    out.push(selected ? theme.inverse(header) : theme.style('fg.dim', header));
    if (!expanded) return;

    for (const item of items) {
      if (item.kind === 'thought') {
        const duration = formatActivityDuration(item.duration);
        out.push(
          `  ${theme.style('fg.dim', theme.unicode ? '◆' : '*')} ${theme.style('fg.muted', `Thought${duration ? ` for ${duration}` : ''}`)}`,
        );
        continue;
      }
      renderActivityTool(out, item, width, theme, entry.detailsExpanded === true);
    }
  },
};

const statusFramer: EntryFramer = {
  render(out, entry, width, theme) {
    const firstPrefix = `${theme.style('fg.dim', theme.glyphs.hexagon)} `;
    pushWrappedLines(out, String(entry.text ?? ''), width, {
      firstPrefix,
      nextPrefix: '  ',
      styleFn: (s) => theme.style('fg.muted', s),
    });
  },
};

const errorFramer: EntryFramer = {
  render(out, entry, width, theme) {
    const bullet = bulletGlyph(theme);
    const firstPrefix = `${theme.style('state.error', bullet)} `;
    pushWrappedLines(out, String(entry.text ?? ''), width, {
      firstPrefix,
      nextPrefix: '  ',
      styleFn: (s) => theme.style('state.error', s),
    });
  },
};

const warningFramer: EntryFramer = {
  render(out, entry, width, theme) {
    const bullet = bulletGlyph(theme);
    const firstPrefix = `${theme.style('state.warn', bullet)} `;
    pushWrappedLines(out, String(entry.text ?? ''), width, {
      firstPrefix,
      nextPrefix: '  ',
      styleFn: (s) => theme.style('state.warn', s),
    });
  },
};

const reasoningFramer: EntryFramer = {
  render(out, _entry, _width, theme) {
    out.push(
      `${theme.style('fg.dim', theme.glyphs.hexagon)} ${theme.style('fg.muted', 'thinking')}`,
    );
  },
};

const sourcesFramer: EntryFramer = {
  render(out, entry, width, theme) {
    const safe = safeCitations((entry.citations as UrlCitation[] | undefined) ?? []);
    if (safe.length === 0) return;
    out.push(
      `${theme.style('fg.dim', theme.glyphs.hexagon)} ${theme.style('fg.muted', 'sources')}`,
    );
    safe.forEach(({ citation, url }, i) => {
      const host = citationHost(url);
      const title = sanitizeCitationText(citation.title) || host;
      const num = theme.style('fg.dim', `${i + 1}.`);
      // Title line (truncated to width), then the dimmed URL beneath it.
      const titleLine = truncate(title, Math.max(1, width - 6));
      out.push(`  ${num} ${theme.style('fg.muted', titleLine)}`);
      out.push(`     ${theme.style('fg.dim', truncate(url.href, Math.max(1, width - 6)))}`);
    });
  },
};

const verdictFramer: EntryFramer = {
  render(out, entry, width, theme) {
    const { glyphs } = theme;
    const isApproved = entry.verdict === 'APPROVED';
    const icon = isApproved ? glyphs.check : glyphs.cross_mark;
    const tone: TokenName = isApproved ? 'state.success' : 'state.error';
    const label = theme.style(tone, `${icon} ${isApproved ? 'APPROVED' : 'DENIED'}`);
    const kindStr = entry.kind ? theme.style('fg.dim', ` ${entry.kind}`) : '';
    const summaryStr = entry.summary
      ? theme.style('fg.muted', '  ' + truncate(String(entry.summary), width - 20))
      : '';
    out.push(`  ${label}${kindStr}${summaryStr}`);
  },
};

const dividerFramer: EntryFramer = {
  render(out, _entry, width, theme) {
    out.push(theme.style('fg.dim', theme.glyphs.horizontal.repeat(Math.min(width, 40))));
  },
};

export const framers: Record<Role, EntryFramer> = {
  user: userFramer,
  assistant: assistantFramer,
  tool_call: toolCallFramer,
  activity_group: activityGroupFramer,
  status: statusFramer,
  error: errorFramer,
  warning: warningFramer,
  reasoning: reasoningFramer,
  sources: sourcesFramer,
  verdict: verdictFramer,
  divider: dividerFramer,
};

/**
 * Dispatch a transcript entry to its framer. Unknown roles produce no
 * output (matching prior behavior — the transcript renderer treats
 * unrecognized roles as no-ops).
 */
export function renderEntryLines(
  out: string[],
  entry: TranscriptEntry,
  width: number,
  theme: Theme,
  ctx: FramerContext = {},
): void {
  const framer = framers[entry.role as Role];
  if (framer) framer.render(out, entry, width, theme, ctx);
}
