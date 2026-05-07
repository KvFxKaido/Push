/**
 * tui-framers.ts — Per-role transcript entry framing.
 *
 * Each transcript entry (user / assistant / tool_call / status / error /
 * warning / reasoning / verdict / divider) gets a small `EntryFramer` that
 * pushes display lines into a caller-owned array. `renderEntryLines`
 * dispatches by role through the `standardFramers` table.
 *
 * Adding a new layout (e.g. a quiet/reserved variant) means defining a
 * second framer table and selecting between them at the dispatch site —
 * no new branching inside the renderer.
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
  streaming?: boolean;
  expandToolJsonPayloads?: boolean;
  entryKey?: string | null;
  payloadUI?: PayloadUI | null;
  /**
   * Override the leading prefix and continuation indent. Defaults to the
   * standard ` AI ` badge. Quiet layout passes a bullet here so the
   * assistant framer reads as a flowing line of prose instead of a label.
   */
  prefixOverride?: { firstPrefix: string; nextPrefix: string };
}

export function renderAssistantEntryLines(
  out: string[],
  text: string,
  width: number,
  theme: Theme,
  opts: AssistantRenderOptions = {},
): void {
  const {
    streaming = false,
    expandToolJsonPayloads = false,
    entryKey = null,
    payloadUI = null,
    prefixOverride = null,
  } = opts;

  let firstPrefix: string;
  let nextPrefix: string;
  if (prefixOverride) {
    firstPrefix = prefixOverride.firstPrefix;
    nextPrefix = prefixOverride.nextPrefix;
  } else {
    const badge = makeBadge(theme, streaming ? 'AI *' : 'AI', {
      fg: 'bg.base',
      bg: 'accent.primary',
    });
    firstPrefix = `${badge} `;
    nextPrefix = ' '.repeat(Math.max(2, visibleWidth(firstPrefix)));
  }
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

// ── Layout modes ────────────────────────────────────────────────────

/**
 * Visual layout mode for the transcript. `standard` is the default
 * badge-led rendering; `quiet` is a reserved bullet-led variant aimed at
 * a less-robotic feel. Layouts diverge only in the framer table; all
 * downstream wrapping/scrolling logic is the same.
 */
export type LayoutMode = 'standard' | 'quiet';

export function isLayoutMode(value: unknown): value is LayoutMode {
  return value === 'standard' || value === 'quiet';
}

/**
 * Resolve layout mode from `PUSH_TUI_LAYOUT`, falling back to standard.
 * Mirrors `detectThemeName` so the env-then-config-then-default
 * precedence is consistent across UI knobs.
 */
export function detectLayoutMode(): LayoutMode {
  const env = (process.env.PUSH_TUI_LAYOUT || '').toLowerCase().trim();
  if (isLayoutMode(env)) return env;
  return 'standard';
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
  /**
   * Selects the framer table. Defaults to 'standard'. Set per-render so
   * the transcript can change layout without rebuilding the cache.
   */
  layout?: LayoutMode;
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

const userFramer: EntryFramer = {
  render(out, entry, width, theme) {
    const prefix = makeBadge(theme, 'YOU', { fg: 'bg.base', bg: 'accent.secondary' }) + ' ';
    const nextPrefix = ' '.repeat(Math.max(2, visibleWidth(prefix)));
    const wrapped = wordWrap(String(entry.text ?? ''), Math.max(1, width - visibleWidth(prefix)));
    for (let i = 0; i < wrapped.length; i++) {
      out.push(
        i === 0
          ? prefix + theme.style('fg.primary', wrapped[i])
          : nextPrefix + theme.style('fg.primary', wrapped[i]),
      );
    }
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
    const badge = makeBadge(theme, 'TOOL', { fg: 'bg.base', bg: 'border.hover', bold: false });
    const dur = entry.duration ? theme.style('fg.dim', ` ${entry.duration}ms`) : '';
    const prefix = `${badge} `;
    const argsHint = summarizeToolArgs(entry.args, Math.max(10, width - 40));
    const argsStr = argsHint ? theme.style('fg.dim', ` ${argsHint}`) : '';
    const base = `${status} ${entry.text ?? ''}${argsStr}${dur}`;
    pushWrappedLines(out, base, width, {
      firstPrefix: prefix,
      nextPrefix: ' '.repeat(Math.max(2, visibleWidth(prefix))),
      styleFn: (s) => theme.style('fg.secondary', s),
    });
    if (entry.resultPreview && !pending) {
      const nextPad = ' '.repeat(Math.max(2, visibleWidth(prefix)));
      const previewLine = String(entry.resultPreview).split('\n')[0].trim();
      if (previewLine) {
        const previewStr = truncate(previewLine, Math.max(10, width - visibleWidth(nextPad) - 4));
        pushWrappedLines(out, previewStr, width, {
          firstPrefix: nextPad,
          nextPrefix: nextPad,
          styleFn: (s) => theme.style('fg.dim', s),
        });
      }
    }
  },
};

const statusFramer: EntryFramer = {
  render(out, entry, width, theme) {
    const badge = makeBadge(theme, 'INFO', {
      fg: 'bg.base',
      bg: 'border.default',
      bold: false,
    });
    const prefix = `${badge} `;
    pushWrappedLines(out, String(entry.text ?? ''), width, {
      firstPrefix: prefix,
      nextPrefix: ' '.repeat(Math.max(2, visibleWidth(prefix))),
      styleFn: (s) => theme.style('fg.dim', s),
    });
  },
};

const errorFramer: EntryFramer = {
  render(out, entry, width, theme) {
    const badge = makeBadge(theme, 'ERR', { fg: 'fg.primary', bg: 'state.error' });
    const prefix = `${badge} `;
    pushWrappedLines(out, String(entry.text ?? ''), width, {
      firstPrefix: prefix,
      nextPrefix: ' '.repeat(Math.max(2, visibleWidth(prefix))),
      styleFn: (s) => theme.style('state.error', s),
    });
  },
};

const warningFramer: EntryFramer = {
  render(out, entry, width, theme) {
    const badge = makeBadge(theme, 'WARN', { fg: 'bg.base', bg: 'state.warn' });
    const prefix = `${badge} `;
    pushWrappedLines(out, String(entry.text ?? ''), width, {
      firstPrefix: prefix,
      nextPrefix: ' '.repeat(Math.max(2, visibleWidth(prefix))),
      styleFn: (s) => theme.style('state.warn', s),
    });
  },
};

const reasoningFramer: EntryFramer = {
  render(out, _entry, _width, theme) {
    out.push(
      `${makeBadge(theme, 'THINK', { fg: 'bg.base', bg: 'border.default', bold: false })} ` +
        theme.style('fg.dim', 'thinking'),
    );
  },
};

const verdictFramer: EntryFramer = {
  render(out, entry, width, theme) {
    const { glyphs } = theme;
    const isApproved = entry.verdict === 'APPROVED';
    const icon = isApproved ? glyphs.check : glyphs.cross_mark;
    const label = isApproved
      ? makeBadge(theme, `${icon} APPROVED`, { fg: 'fg.primary', bg: 'state.success' })
      : makeBadge(theme, `${icon} DENIED`, { fg: 'fg.primary', bg: 'state.error' });
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

export const standardFramers: Record<Role, EntryFramer> = {
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

// ── Quiet layout framers ────────────────────────────────────────────
// Reserved, bullet-led shapes inspired by Claude Code's transcript:
// no colored-background badges, single-glyph role markers, indented
// branch line for tool-call result previews. The intent is a flowing
// conversational read instead of a sequence of labels.

function quietBullet(theme: Theme): string {
  return theme.unicode ? '•' : '*';
}

function quietBranch(theme: Theme): string {
  return theme.unicode ? '└─ ' : 'L  ';
}

const quietUserFramer: EntryFramer = {
  render(out, entry, width, theme) {
    const bullet = quietBullet(theme);
    const firstPrefix = `${theme.style('accent.primary', bullet)} `;
    const nextPrefix = '  ';
    pushWrappedLines(out, String(entry.text ?? ''), width, {
      firstPrefix,
      nextPrefix,
      styleFn: (s) => theme.style('fg.primary', s),
    });
  },
};

const quietAssistantFramer: EntryFramer = {
  render(out, entry, width, theme, ctx) {
    const bullet = quietBullet(theme);
    const firstPrefix = `${theme.style('fg.muted', bullet)} `;
    const nextPrefix = '  ';
    renderAssistantEntryLines(out, String(entry.text ?? ''), width, theme, {
      expandToolJsonPayloads: ctx.expandToolJsonPayloads,
      entryKey: ctx.entryKey,
      payloadUI: ctx.payloadUI,
      prefixOverride: { firstPrefix, nextPrefix },
    });
  },
};

const quietToolCallFramer: EntryFramer = {
  render(out, entry, width, theme) {
    const { glyphs } = theme;
    const pending = entry.error !== true && !entry.duration;
    const status = pending
      ? theme.style('accent.secondary', '…')
      : entry.error
        ? theme.style('state.error', glyphs.cross_mark || 'ERR')
        : theme.style('state.success', glyphs.check || 'OK');
    const bullet = quietBullet(theme);
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
      const branch = quietBranch(theme);
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

const quietStatusFramer: EntryFramer = {
  render(out, entry, width, theme) {
    const firstPrefix = `${theme.style('fg.dim', '*')} `;
    pushWrappedLines(out, String(entry.text ?? ''), width, {
      firstPrefix,
      nextPrefix: '  ',
      styleFn: (s) => theme.style('fg.muted', s),
    });
  },
};

const quietErrorFramer: EntryFramer = {
  render(out, entry, width, theme) {
    const bullet = quietBullet(theme);
    const firstPrefix = `${theme.style('state.error', bullet)} `;
    pushWrappedLines(out, String(entry.text ?? ''), width, {
      firstPrefix,
      nextPrefix: '  ',
      styleFn: (s) => theme.style('state.error', s),
    });
  },
};

const quietWarningFramer: EntryFramer = {
  render(out, entry, width, theme) {
    const bullet = quietBullet(theme);
    const firstPrefix = `${theme.style('state.warn', bullet)} `;
    pushWrappedLines(out, String(entry.text ?? ''), width, {
      firstPrefix,
      nextPrefix: '  ',
      styleFn: (s) => theme.style('state.warn', s),
    });
  },
};

const quietReasoningFramer: EntryFramer = {
  render(out, _entry, _width, theme) {
    out.push(`${theme.style('fg.dim', '*')} ${theme.style('fg.muted', 'thinking')}`);
  },
};

const quietVerdictFramer: EntryFramer = {
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

export const quietFramers: Record<Role, EntryFramer> = {
  user: quietUserFramer,
  assistant: quietAssistantFramer,
  tool_call: quietToolCallFramer,
  status: quietStatusFramer,
  error: quietErrorFramer,
  warning: quietWarningFramer,
  reasoning: quietReasoningFramer,
  verdict: quietVerdictFramer,
  divider: dividerFramer, // shared — divider is already minimal
};

const FRAMER_TABLES: Record<LayoutMode, Record<Role, EntryFramer>> = {
  standard: standardFramers,
  quiet: quietFramers,
};

/**
 * Dispatch a transcript entry to its framer. Unknown roles produce no
 * output (matching prior behavior — the transcript renderer treats
 * unrecognized roles as no-ops). Layout selects which framer table to
 * use; default is standard.
 */
export function renderEntryLines(
  out: string[],
  entry: TranscriptEntry,
  width: number,
  theme: Theme,
  ctx: FramerContext = {},
): void {
  const layout: LayoutMode = isLayoutMode(ctx.layout) ? ctx.layout : 'standard';
  const table = FRAMER_TABLES[layout];
  const framer = table[entry.role as Role];
  if (framer) framer.render(out, entry, width, theme, ctx);
}
