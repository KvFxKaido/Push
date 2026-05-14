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
}

export function renderAssistantEntryLines(
  out: string[],
  text: string,
  width: number,
  theme: Theme,
  opts: AssistantRenderOptions = {},
): void {
  const { expandToolJsonPayloads = false, entryKey = null, payloadUI = null } = opts;

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
  let canUseFirstPrefix = true;
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

  const pushCodeLine = (line: string): void => {
    pushAssistant(line, (s) => theme.style('fg.secondary', s));
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
          for (const codeLine of fenceBuf) {
            pushCodeLine(codeLine);
          }
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

    if (body) {
      const label = lang ? `code (${lang})` : 'code';
      pushAssistant(label, (s) => theme.style('fg.dim', s));
      for (const codeLine of fenceBuf) {
        pushCodeLine(codeLine);
      }
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
      pushAssistant(`${indent}${bullet[2]} ${bullet[3]}`, (s) => theme.style('fg.primary', s));
      continue;
    }

    if (/^\s*>\s+/.test(line)) {
      pushAssistant(line.replace(/^\s*>\s+/, ''), (s) => theme.style('fg.secondary', s));
      continue;
    }

    pushAssistant(line, (s) => theme.style('fg.primary', s));
  }

  if (fenceLang != null) flushFence();
}

// ── Per-role framers ────────────────────────────────────────────────

export type Role =
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'status'
  | 'error'
  | 'warning'
  | 'reasoning'
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

const statusFramer: EntryFramer = {
  render(out, entry, width, theme) {
    const firstPrefix = `${theme.style('fg.dim', '*')} `;
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
    out.push(`${theme.style('fg.dim', '*')} ${theme.style('fg.muted', 'thinking')}`);
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
  status: statusFramer,
  error: errorFramer,
  warning: warningFramer,
  reasoning: reasoningFramer,
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
