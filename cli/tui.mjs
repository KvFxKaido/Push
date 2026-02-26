/**
 * tui.mjs — Push TUI full-screen terminal interface.
 * Zero dependencies beyond Node built-ins and sibling modules.
 *
 * Entry point: runTUI(options)
 * Reuses the existing engine, session store, and provider system.
 */

import process from 'node:process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { createTheme } from './tui-theme.mjs';
import { renderStatusBar, renderKeybindHints, getCompactGitStatus, estimateTokens } from './tui-status.mjs';
import { filterSessions } from './tui-fuzzy.mjs';
import { applySingleLineEditKey, getListNavigationAction, moveCursorCircular } from './tui-modal-input.mjs';
import { drawModalBoxAt, getCenteredModalRect, getWindowedListRange, renderCenteredModalBox } from './tui-widgets.mjs';
import { parseKey, splitRawInputChunk, createKeybindMap, createComposer, createInputHistory } from './tui-input.mjs';
import {
  ESC, getTermSize, visibleWidth, truncate, wordWrap, padTo,
  drawDivider, createScreenBuffer, createRenderScheduler, computeLayout,
} from './tui-renderer.mjs';
import { PROVIDER_CONFIGS, resolveApiKey, getProviderList } from './provider.mjs';
import { getCuratedModels, fetchModels } from './model-catalog.mjs';
import { makeSessionId, saveSessionState, appendSessionEvent, loadSessionState, listSessions, deleteSession } from './session-store.mjs';
import { buildSystemPromptBase, ensureSystemPromptReady, runAssistantLoop, DEFAULT_MAX_ROUNDS } from './engine.mjs';
import { loadConfig, applyConfigToEnv, saveConfig, maskSecret } from './config-store.mjs';
import { loadSkills, interpolateSkill, getSkillPromptTemplate } from './skill-loader.mjs';
import { matchingRiskPatternIndex } from './tools.mjs';
import { createTabCompleter } from './tui-completer.mjs';
import { appendUserMessageWithFileReferences } from './file-references.mjs';
import { compactContext } from './context-manager.mjs';

// ── TUI state ───────────────────────────────────────────────────────

const MAX_TRANSCRIPT = 2000;   // max lines in transcript buffer
const MAX_TOOL_FEED = 200;     // max items in tool feed

function createTUIState() {
  return {
    // Run state machine: idle | running | awaiting_approval | awaiting_user_question
    runState: 'idle',
    // Transcript: array of { role, text, timestamp }
    transcript: [],
    transcriptVersion: 0,
    transcriptRenderCache: null, // { key, lines, payloadBlocks }
    // Streaming token accumulator (for in-progress assistant response)
    streamBuf: '',
    // Tool feed: array of { type: 'call'|'result', name, args?, duration?, error?, preview?, timestamp }
    toolFeed: [],
    // Approval prompt (when awaiting_approval)
    approval: null,    // { kind, summary, details }
    // User question prompt (when awaiting_user_question)
    userQuestion: null,  // { question: string, choices?: string[] }
    // UI toggles
    toolPaneOpen: false,
    toolJsonPayloadsExpanded: false,
    payloadInspectorOpen: false,
    payloadCursorId: null,
    expandedToolJsonPayloadIds: new Set(),
    payloadBlocks: [],
    reasoningModalOpen: false,
    reasoningBuf: '',
    lastReasoning: '',
    reasoningStreaming: false,
    providerModalOpen: false,
    providerModalCursor: 0,
    resumeModalOpen: false,
    resumeModalState: null,  // { loading, rows[], cursor, error, confirmDeleteId, mode, renameTargetId, renameBuf, renameCursor }
    modelModalOpen: false,
    modelModalState: null,   // { providerId, models[], cursor, loading, source, error }
    configModalOpen: false,
    configModalState: null,  // { mode: 'list'|'edit', cursor: 0, editTarget: '', editBuf: '', editCursor: 0 }
    // Scrollback offset (0 = pinned to bottom, positive = scrolled up by N lines)
    scrollOffset: 0,
    // Dirty flags for selective re-render
    dirty: new Set(['all']),
    // Git status for status bar
    gitStatus: null,  // { branch, dirty, ahead, behind }
  };
}

// ── Transcript management ───────────────────────────────────────────

const DEFAULT_COMPACT_TURNS = 6;

function invalidateTranscriptRenderCache(tuiState) {
  tuiState.transcriptVersion = (tuiState.transcriptVersion || 0) + 1;
  tuiState.transcriptRenderCache = null;
}

function pushTranscriptEntry(tuiState, entry, { autoScroll = true } = {}) {
  tuiState.transcript.push(entry);
  if (tuiState.transcript.length > MAX_TRANSCRIPT) {
    tuiState.transcript.splice(0, tuiState.transcript.length - MAX_TRANSCRIPT);
  }
  invalidateTranscriptRenderCache(tuiState);
  if (autoScroll) tuiState.scrollOffset = 0;
  tuiState.dirty.add('transcript');
}

function addTranscriptEntry(tuiState, role, text) {
  pushTranscriptEntry(tuiState, { role, text, timestamp: Date.now() });
}

function addToolFeedEntry(tuiState, entry) {
  tuiState.toolFeed.push({ ...entry, timestamp: Date.now() });
  if (tuiState.toolFeed.length > MAX_TOOL_FEED) {
    tuiState.toolFeed.splice(0, tuiState.toolFeed.length - MAX_TOOL_FEED);
  }
  tuiState.dirty.add('tools');
}

// ── Pane renderers ──────────────────────────────────────────────────

function makeBadge(theme, label, { fg = 'fg.primary', bg = 'border.default', bold = true } = {}) {
  const text = ` ${label} `;
  const styled = theme.styleFgBg(fg, bg, text);
  return bold ? theme.bold(styled) : styled;
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function summarizeToolArgs(args, maxWidth) {
  if (!args || typeof args !== 'object') return '';
  let preview = '';
  if (typeof args.command === 'string' && args.command) {
    preview = args.command;
  } else if (typeof args.path === 'string' && args.path) {
    preview = args.path;
  } else if (typeof args.file === 'string' && args.file) {
    preview = args.file;
  } else {
    preview = safeJsonStringify(args);
  }
  return truncate(preview, Math.max(1, maxWidth));
}

function parseJsonToolCalls(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.tool === 'string') {
      return [{ tool: parsed.tool, args: parsed.args ?? null }];
    }
    if (Array.isArray(parsed)) {
      const calls = parsed
        .filter((item) => item && typeof item === 'object' && typeof item.tool === 'string')
        .map((item) => ({ tool: item.tool, args: item.args ?? null }));
      return calls.length ? calls : null;
    }
  } catch {
    // fall through
  }
  return null;
}

function pushWrappedLines(out, text, width, {
  firstPrefix = '',
  nextPrefix = firstPrefix,
  styleFn = (s) => s,
} = {}) {
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

function renderAssistantEntryLines(out, text, width, theme, {
  streaming = false,
  expandToolJsonPayloads = false,
  entryKey = null,
  payloadUI = null, // { blocks, cursorId, expandedIds, inspectorOpen }
} = {}) {
  const badge = makeBadge(theme, streaming ? 'AI *' : 'AI', { fg: 'bg.base', bg: 'accent.primary' });
  const firstPrefix = `${badge} `;
  const nextPrefix = ' '.repeat(Math.max(2, visibleWidth(firstPrefix)));
  let canUseFirstPrefix = true;
  let jsonFenceOrdinal = 0;

  const pushAssistant = (lineText, styleFn = (s) => theme.style('fg.primary', s)) => {
    pushWrappedLines(out, lineText, width, {
      firstPrefix: canUseFirstPrefix ? firstPrefix : nextPrefix,
      nextPrefix,
      styleFn,
    });
    canUseFirstPrefix = false;
  };

  const pushToolSummary = (summary) => {
    pushAssistant(summary, (s) => theme.style('accent.secondary', s));
  };

  const pushCodeLine = (line) => {
    pushAssistant(line, (s) => theme.style('fg.secondary', s));
  };

  const lines = String(text ?? '').split('\n');
  let fenceLang = null;
  let fenceBuf = [];

  const flushFence = () => {
    const body = fenceBuf.join('\n').trim();
    const lang = (fenceLang || '').toLowerCase();
    const jsonFenceIndex = lang === 'json' ? jsonFenceOrdinal++ : null;
    const payloadId = (lang === 'json' && entryKey != null)
      ? `${entryKey}:json:${jsonFenceIndex}`
      : null;
    const selected = Boolean(payloadId && payloadUI?.cursorId === payloadId);
    const expandedByBlock = Boolean(payloadId && payloadUI?.expandedIds?.has(payloadId));
    const expanded = expandToolJsonPayloads || expandedByBlock;

    if (lang === 'json' && body) {
      const toolCalls = parseJsonToolCalls(body);
      if (toolCalls) {
        const blockStart = out.length;
        const marker = expanded ? (theme.unicode ? '▾' : 'v') : (theme.unicode ? '▸' : '>');
        const countLabel = toolCalls.length === 1 ? '1 tool call' : `${toolCalls.length} tool calls`;
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
        (s) => theme.style('fg.dim', s)
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

function renderHeader(buf, layout, theme, { provider, model, session, cwd, runState, branch }) {
  const { glyphs } = theme;
  const { top, left, width } = layout.header;

  // Status dot
  const stateDot = runState === 'running'
    ? theme.style('state.warn', glyphs.statusDot)
    : runState === 'awaiting_approval'
      ? theme.style('state.error', glyphs.statusDot)
      : theme.style('state.success', glyphs.statusDot);

  // ── Top border: ┌─ ⬡ Push ──...──┐ ────────────────────────────
  // Fixed chars: ┌─ (2) + space (1) + ⬡ (1) + space (1) + Push (4) + space (1) + fill + ┐ (1) = 11 + fill = width
  const topFill = glyphs.horizontal.repeat(Math.max(0, width - 11));
  const topBorder =
    theme.style('fg.dim', `${glyphs.topLeft}${glyphs.horizontal} `) +
    theme.style('accent.link', '\u2B21') +
    ' ' +
    theme.bold(theme.style('fg.primary', 'Push')) +
    theme.style('fg.dim', ` ${topFill}${glyphs.topRight}`);
  buf.writeLine(top, left, topBorder);

  // ── Content row: │  ● state  provider · model   ~/dir · branch  │ ──
  const sep = theme.style('fg.dim', '·');
  const stateLabel = theme.style('fg.dim', runState);
  const providerStr = theme.style('accent.link', provider);
  const modelStr = theme.bold(theme.style('fg.primary', model));
  const leftInner = `${stateDot} ${stateLabel}  ${providerStr} ${sep} ${modelStr}`;

  const homeDir = process.env.HOME || '';
  const shortCwd = homeDir && cwd.startsWith(homeDir) ? '~' + cwd.slice(homeDir.length) : cwd;
  const branchPart = branch ? ` ${sep} ${theme.style('accent.link', branch)}` : '';
  const rightInner = theme.style('fg.secondary', truncate(shortCwd, Math.floor(width * 0.35))) + branchPart;

  // │  leftInner[gap]rightInner  │  — inner content width = width - 6
  const gapLen = Math.max(1, width - 6 - visibleWidth(leftInner) - visibleWidth(rightInner));
  const contentRow =
    theme.style('fg.dim', glyphs.vertical) +
    `  ${leftInner}${' '.repeat(gapLen)}${rightInner}  ` +
    theme.style('fg.dim', glyphs.vertical);
  buf.writeLine(top + 1, left, contentRow);

  // ── Bottom border: └──...──┘ ─────────────────────────────────
  const bottomBorder = theme.style('fg.dim',
    `${glyphs.bottomLeft}${glyphs.horizontal.repeat(width - 2)}${glyphs.bottomRight}`
  );
  buf.writeLine(top + 2, left, bottomBorder);

  // ── Session line (indented to align with box inner content) ───
  const sessLabel = theme.style('fg.dim', `session: ${session}`);
  const hint = theme.style('accent.link', '/model');
  buf.writeLine(top + 3, left, padTo(`  ${sessLabel}  ${hint}`, width));
}

function findFirstIntersectingTranscriptBlock(entryBlocks, targetLine) {
  let lo = 0;
  let hi = entryBlocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((entryBlocks[mid]?.endLine ?? 0) <= targetLine) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function findFirstTranscriptBlockStartingAtOrAfter(entryBlocks, targetLine) {
  let lo = 0;
  let hi = entryBlocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((entryBlocks[mid]?.startLine ?? 0) < targetLine) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function renderTranscript(buf, layout, theme, tuiState) {
  const { top, left, width, height } = layout.transcript;
  const { glyphs } = theme;

  const expandedPayloadIdsKey = tuiState.toolJsonPayloadsExpanded
    ? 'all'
    : Array.from(tuiState.expandedToolJsonPayloadIds).sort().join('|');
  const transcriptCacheKey = [
    width,
    tuiState.transcriptVersion,
    tuiState.toolJsonPayloadsExpanded ? 1 : 0,
    tuiState.payloadInspectorOpen ? 1 : 0,
    tuiState.payloadCursorId || '',
    expandedPayloadIdsKey,
  ].join('::');

  let cached = tuiState.transcriptRenderCache;
  if (!cached || cached.key !== transcriptCacheKey) {
    // Build per-entry rendered blocks and cache them. This lets us only
    // assemble the visible window on each frame.
    const entryBlocks = [];
    let totalLines = 0;

    for (let entryIndex = 0; entryIndex < tuiState.transcript.length; entryIndex++) {
      const entry = tuiState.transcript[entryIndex];
      const entryLines = [];
      const localPayloadBlocks = [];
      const payloadUI = {
        blocks: localPayloadBlocks,
        cursorId: tuiState.payloadCursorId,
        expandedIds: tuiState.expandedToolJsonPayloadIds,
        inspectorOpen: tuiState.payloadInspectorOpen,
      };

      if (entry.role === 'user') {
        const prefix = makeBadge(theme, 'YOU', { fg: 'bg.base', bg: 'accent.secondary' }) + ' ';
        const nextPrefix = ' '.repeat(Math.max(2, visibleWidth(prefix)));
        const wrapped = wordWrap(entry.text, Math.max(1, width - visibleWidth(prefix)));
        for (let i = 0; i < wrapped.length; i++) {
          entryLines.push(i === 0
            ? prefix + theme.style('fg.primary', wrapped[i])
            : nextPrefix + theme.style('fg.primary', wrapped[i]));
        }
      } else if (entry.role === 'assistant') {
        renderAssistantEntryLines(entryLines, entry.text, width, theme, {
          expandToolJsonPayloads: tuiState.toolJsonPayloadsExpanded,
          entryKey: `${entry.timestamp ?? 0}:${entryIndex}`,
          payloadUI,
        });
      } else if (entry.role === 'tool_call') {
        const pending = entry.error !== true && !entry.duration;
        const status = pending
          ? theme.style('accent.secondary', '…')
          : entry.error
            ? theme.style('state.error', glyphs.cross_mark || 'ERR')
            : theme.style('state.success', glyphs.check || 'OK');
        const badge = makeBadge(theme, 'TOOL', { fg: 'bg.base', bg: 'border.hover', bold: false });
        const dur = entry.duration ? theme.style('fg.dim', ` ${entry.duration}ms`) : '';
        const prefix = `${badge} `;
        const base = `${status} ${entry.text}${dur}`;
        pushWrappedLines(entryLines, base, width, {
          firstPrefix: prefix,
          nextPrefix: ' '.repeat(Math.max(2, visibleWidth(prefix))),
          styleFn: (s) => theme.style('fg.secondary', s),
        });
      } else if (entry.role === 'status') {
        const badge = makeBadge(theme, 'INFO', { fg: 'bg.base', bg: 'border.default', bold: false });
        const prefix = `${badge} `;
        pushWrappedLines(entryLines, entry.text, width, {
          firstPrefix: prefix,
          nextPrefix: ' '.repeat(Math.max(2, visibleWidth(prefix))),
          styleFn: (s) => theme.style('fg.dim', s),
        });
      } else if (entry.role === 'error') {
        const badge = makeBadge(theme, 'ERR', { fg: 'fg.primary', bg: 'state.error' });
        const prefix = `${badge} `;
        pushWrappedLines(entryLines, entry.text, width, {
          firstPrefix: prefix,
          nextPrefix: ' '.repeat(Math.max(2, visibleWidth(prefix))),
          styleFn: (s) => theme.style('state.error', s),
        });
      } else if (entry.role === 'warning') {
        const badge = makeBadge(theme, 'WARN', { fg: 'bg.base', bg: 'state.warn' });
        const prefix = `${badge} `;
        pushWrappedLines(entryLines, entry.text, width, {
          firstPrefix: prefix,
          nextPrefix: ' '.repeat(Math.max(2, visibleWidth(prefix))),
          styleFn: (s) => theme.style('state.warn', s),
        });
      } else if (entry.role === 'reasoning') {
        entryLines.push(
          `${makeBadge(theme, 'THINK', { fg: 'bg.base', bg: 'border.default', bold: false })} ` +
          theme.style('fg.dim', 'thinking')
        );

      } else if (entry.role === 'verdict') {
        const isApproved = entry.verdict === 'APPROVED';
        const icon = isApproved ? glyphs.check : glyphs.cross_mark;
        const label = isApproved
          ? makeBadge(theme, `${icon} APPROVED`, { fg: 'fg.primary', bg: 'state.success' })
          : makeBadge(theme, `${icon} DENIED`, { fg: 'fg.primary', bg: 'state.error' });
        const kindStr = entry.kind ? theme.style('fg.dim', ` ${entry.kind}`) : '';
        const summaryStr = entry.summary
          ? theme.style('fg.muted', '  ' + truncate(entry.summary, width - 20))
          : '';
        entryLines.push(`  ${label}${kindStr}${summaryStr}`);

      } else if (entry.role === 'divider') {
        entryLines.push(theme.style('fg.dim', glyphs.horizontal.repeat(Math.min(width, 40))));
      }

      const blockStartLine = totalLines;
      const block = {
        lineCount: entryLines.length,
        startLine: blockStartLine,
        endLine: blockStartLine + entryLines.length,
        lines: entryLines,
        payloadBlocks: localPayloadBlocks,
      };
      entryBlocks.push(block);
      totalLines = block.endLine;
    }

    cached = { key: transcriptCacheKey, entryBlocks, totalLines };
    tuiState.transcriptRenderCache = cached;
  }

  const streamingLines = [];

  // Add streaming buffer if assistant is currently streaming
  if (tuiState.streamBuf) {
    renderAssistantEntryLines(streamingLines, tuiState.streamBuf, width, theme, {
      streaming: true,
      expandToolJsonPayloads: tuiState.toolJsonPayloadsExpanded,
      payloadUI: null,
    });
  }

  // Take the last `height` lines (scroll to bottom), adjusted by scrollOffset
  const totalLineCount = (cached.totalLines || 0) + streamingLines.length;
  const maxScroll = Math.max(0, totalLineCount - height);
  const effectiveOffset = Math.min(tuiState.scrollOffset, maxScroll);
  const startIdx = Math.max(0, maxScroll - effectiveOffset);
  const endIdxExclusive = startIdx + height;

  const slice = [];
  const payloadBlocks = [];
  const entryBlocks = cached.entryBlocks || [];
  const startBlockIdx = findFirstIntersectingTranscriptBlock(entryBlocks, startIdx);
  const endBlockIdxExclusive = findFirstTranscriptBlockStartingAtOrAfter(entryBlocks, endIdxExclusive);

  for (let bi = startBlockIdx; bi < endBlockIdxExclusive; bi++) {
    const block = entryBlocks[bi];
    const blockStart = block.startLine ?? 0;
    const blockEnd = block.endLine ?? (blockStart + block.lineCount);

    if (block.lineCount === 0) continue;
    if (blockEnd <= startIdx || blockStart >= endIdxExclusive) continue;

    const localStart = Math.max(0, startIdx - blockStart);
    const localEnd = Math.min(block.lineCount, endIdxExclusive - blockStart);
    for (let i = localStart; i < localEnd; i++) {
      slice.push(block.lines[i]);
    }

    for (const pb of block.payloadBlocks || []) {
      const startLine = blockStart + pb.startLine;
      const endLine = blockStart + pb.endLine;
      payloadBlocks.push({
        ...pb,
        startLine,
        endLine,
        visible: endLine >= startIdx && startLine < endIdxExclusive,
      });
    }
  }

  const streamingStart = cached.totalLines || 0;
  const streamingEnd = streamingStart + streamingLines.length;
  if (streamingEnd > startIdx && streamingStart < endIdxExclusive) {
    const localStart = Math.max(0, startIdx - streamingStart);
    const localEnd = Math.min(streamingLines.length, endIdxExclusive - streamingStart);
    for (let i = localStart; i < localEnd; i++) {
      slice.push(streamingLines[i]);
    }
  }

  tuiState.payloadBlocks = payloadBlocks;
  if (tuiState.payloadCursorId && !payloadBlocks.some((b) => b.id === tuiState.payloadCursorId)) {
    tuiState.payloadCursorId = null;
  }
  if (tuiState.payloadInspectorOpen) {
    const selectedVisible = tuiState.payloadCursorId
      ? payloadBlocks.some((b) => b.id === tuiState.payloadCursorId && b.visible)
      : false;
    if (!selectedVisible) {
      const visibleBlock = payloadBlocks.find((b) => b.visible);
      if (visibleBlock) {
        tuiState.payloadCursorId = visibleBlock.id;
      }
    }
  }

  // Render
  for (let r = 0; r < height; r++) {
    const line = r < slice.length ? slice[r] : '';
    buf.writeLine(top + r, left, padTo(line, width));
  }

  // Scroll indicator when not at bottom
  if (effectiveOffset > 0) {
    const indicator = theme.style('fg.dim', `[+${effectiveOffset} lines]`);
    buf.writeLine(top + height - 1, left + width - visibleWidth(indicator) - 1, indicator);
  }
}

function renderToolPane(buf, layout, theme, tuiState) {
  if (!layout.toolPane) return;
  const { top, left, width, height } = layout.toolPane;
  const { glyphs } = theme;

  // Title
  const count = theme.style('fg.dim', String(tuiState.toolFeed.length));
  const title = `${makeBadge(theme, 'TOOLS', { fg: 'bg.base', bg: 'accent.secondary' })} ${count}`;
  buf.writeLine(top, left, padTo(title, width));

  // Tool feed entries (bottom-aligned)
  const lines = [];
  for (const entry of tuiState.toolFeed) {
    if (entry.type === 'call') {
      const argsPreview = summarizeToolArgs(entry.args, Math.max(8, width - entry.name.length - 8));
      lines.push(
        theme.style('accent.secondary', glyphs.arrow || glyphs.prompt) + ' ' +
        theme.style('fg.primary', entry.name) +
        (argsPreview ? ' ' + theme.style('fg.dim', argsPreview) : '')
      );
    } else if (entry.type === 'result') {
      const ok = !entry.error;
      const status = ok
        ? theme.style('state.success', glyphs.check || 'OK')
        : theme.style('state.error', glyphs.cross_mark || 'ERR');
      const dur = entry.duration ? theme.style('fg.dim', `${entry.duration}ms`) : theme.style('fg.dim', 'done');
      const preview = entry.preview
        ? ' ' + theme.style('fg.dim', truncate(entry.preview, width - 20))
        : '';
      lines.push(`  ${status} ${theme.style('fg.secondary', entry.name)} ${dur}${preview}`);
    }
  }

  const startIdx = Math.max(0, lines.length - (height - 1));
  const slice = lines.slice(startIdx, startIdx + height - 1);

  for (let r = 0; r < height - 1; r++) {
    const line = r < slice.length ? slice[r] : '';
    buf.writeLine(top + 1 + r, left, padTo(line, width));
  }
}

function renderComposer(buf, layout, theme, composer, tuiState, tabState) {
  const { top, left, width, height } = layout.composer;
  const { glyphs } = theme;

  // Top border with label
  const stateLabel = tuiState.runState === 'running'
    ? theme.style('state.warn', ' streaming... ')
    : tuiState.runState === 'awaiting_approval'
      ? theme.style('state.error', ' approval required ')
      : tuiState.runState === 'awaiting_user_question'
        ? theme.style('accent.primary', ' ? question ')
        : theme.style('fg.muted', ' message ');
  const tabHint = tabState ? tabState.hint : null;
  const label = tabHint
    ? stateLabel + theme.style('accent.primary', ` ${tabHint} `)
    : stateLabel;

  const borderChar = glyphs.horizontal;
  const labelWidth = visibleWidth(label);
  const borderLeft = borderChar.repeat(2);
  const borderRight = borderChar.repeat(Math.max(0, width - 2 - labelWidth - 2));
  const topBorder = theme.style('border.default', borderLeft) + label + theme.style('border.default', borderRight);
  buf.writeLine(top, left, topBorder);

  // Candidates bar (when tab completion is active — preview or cycling)
  let candidateRowUsed = false;
  if (tabState && tabState.candidates) {
    const { items, index } = tabState.candidates;
    const previewing = index < 0; // no selection yet, just showing options
    let candidateLine = '  ';
    let lineWidth = 2;
    for (let i = 0; i < items.length; i++) {
      const label = truncate(items[i], 30);
      const sep = i > 0 ? '  ' : '';
      const needed = visibleWidth(sep + label);
      if (lineWidth + needed > width - 1) break; // don't overflow
      candidateLine += sep;
      if (previewing) {
        candidateLine += theme.style('fg.secondary', label);
      } else {
        candidateLine += i === index
          ? theme.style('accent.primary', label)
          : theme.style('fg.dim', label);
      }
      lineWidth += needed;
    }
    buf.writeLine(top + 1, left, padTo(candidateLine, width));
    candidateRowUsed = true;
  }

  // Composer content lines
  const lines = composer.getLines();
  const contentTop = top + 1 + (candidateRowUsed ? 1 : 0);
  const innerHeight = height - 1 - (candidateRowUsed ? 1 : 0); // -1 for border, -1 if candidates shown
  for (let r = 0; r < innerHeight; r++) {
    if (r < lines.length) {
      const prefix = r === 0 ? theme.style('accent.primary', glyphs.prompt + ' ') : '  ';
      const content = lines[r];
      buf.writeLine(contentTop + r, left, padTo(prefix + theme.style('fg.primary', content), width));
    } else {
      buf.writeLine(contentTop + r, left, ' '.repeat(width));
    }
  }
}

function renderApprovalModal(buf, theme, rows, cols, approval) {
  if (!approval) return;

  // Modal dimensions
  const modalWidth = Math.min(60, cols - 8);
  const lines = [
    theme.bold(theme.style('state.warn', '  Approval Required')),
    '',
    `  ${theme.style('fg.secondary', 'kind:')} ${theme.style('fg.primary', approval.kind || 'exec')}`,
    `  ${theme.style('fg.secondary', 'detail:')}`,
  ];

  // Wrap the summary into the modal
  const summaryLines = wordWrap(approval.summary || '', modalWidth - 6);
  for (const sl of summaryLines) {
    lines.push(`    ${theme.style('fg.primary', sl)}`);
  }

  lines.push('');
  lines.push(
    `  ${theme.style('accent.link', 'Ctrl+Y / y')} approve  ` +
    `${theme.style('accent.link', 'a')} always  ` +
    `${theme.style('accent.link', 'Ctrl+N / n')} deny  ` +
    `${theme.style('accent.link', 'Esc')} close`
  );
  renderCenteredModalBox(buf, theme, rows, cols, modalWidth, lines);
}

function renderQuestionModal(buf, theme, rows, cols, userQuestion, inputBuf) {
  if (!userQuestion) return;

  const modalWidth = Math.min(64, cols - 8);
  const lines = [
    theme.bold(theme.style('accent.primary', '  Question')),
    '',
  ];

  // Wrap the question text
  const questionLines = wordWrap(userQuestion.question || '', modalWidth - 6);
  for (const ql of questionLines) {
    lines.push(`  ${theme.style('fg.primary', ql)}`);
  }

  // Choices (if provided)
  if (userQuestion.choices?.length) {
    lines.push('');
    lines.push(`  ${theme.style('fg.secondary', 'Choices:')} ${userQuestion.choices.map((c) => theme.style('accent.link', c)).join('  ')}`);
  }

  lines.push('');
  // Input line with cursor
  const inputDisplay = inputBuf + theme.style('fg.primary', '█');
  lines.push(`  ${theme.style('fg.dim', '›')} ${inputDisplay}`);
  lines.push('');
  lines.push(`  ${theme.style('accent.link', 'Enter')} ${theme.style('fg.dim', 'submit')}  ${theme.style('accent.link', 'Esc')} ${theme.style('fg.dim', 'skip')}`);
  renderCenteredModalBox(buf, theme, rows, cols, modalWidth, lines);
}

function renderReasoningModal(buf, theme, rows, cols, tuiState) {
  const modalWidth = Math.min(80, cols - 8);
  const modalHeight = Math.min(22, rows - 6);
  const bodyWidth = Math.max(10, modalWidth - 4);
  const bodyHeight = Math.max(6, modalHeight - 6);
  const modalTop = Math.floor((rows - modalHeight) / 2);
  const modalLeft = Math.floor((cols - modalWidth) / 2);

  const live = tuiState.reasoningStreaming;
  const text = tuiState.reasoningBuf || tuiState.lastReasoning || '';
  const lines = [
    theme.bold(theme.style('fg.primary', `  Reasoning ${live ? '(live)' : ''}`)),
    '',
  ];

  if (!text.trim()) {
    lines.push(`  ${theme.style('fg.dim', 'No reasoning captured yet in this TUI session.')}`);
  } else {
    const wrapped = [];
    for (const rawLine of text.split('\n')) {
      const chunks = wordWrap(rawLine, bodyWidth);
      if (chunks.length === 0) wrapped.push('');
      else wrapped.push(...chunks);
    }
    const hidden = Math.max(0, wrapped.length - bodyHeight);
    const visible = wrapped.slice(Math.max(0, wrapped.length - bodyHeight));
    if (hidden > 0) {
      lines.push(`  ${theme.style('fg.dim', `[${hidden} more lines above]`)}`);
      lines.push('');
    }
    for (const line of visible) {
      lines.push(`  ${theme.style('fg.dim', line)}`);
    }
  }

  lines.push('');
  lines.push(`  ${theme.style('accent.link', 'Ctrl+G')} toggle  ${theme.style('accent.link', 'Esc')} close`);
  drawModalBoxAt(buf, theme, modalTop, modalLeft, modalWidth, lines);
}

function renderProviderModal(buf, theme, rows, cols, currentProvider, currentModel, cursor = 0) {
  const { glyphs } = theme;
  const providers = getProviderList();
  const modalWidth = Math.min(56, cols - 8);

  const lines = [
    theme.bold(theme.style('fg.primary', '  Provider / Model')),
    '',
  ];

  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    const isCurrent = p.id === currentProvider;
    const isCursor = i === cursor;
    const hasKey = p.hasKey ? theme.style('state.success', glyphs.check) : theme.style('fg.dim', '-');
    const marker = isCursor ? theme.style('accent.primary', glyphs.prompt) : ' ';
    let name = theme.style('fg.secondary', p.id);
    if (isCurrent) name = theme.style('fg.primary', p.id);
    if (isCursor) name = theme.style('accent.primary', p.id);
    const currentTag = isCurrent ? theme.style('fg.dim', ' (current)') : '';
    lines.push(`  ${marker} ${i + 1}. ${name}  ${hasKey}${currentTag}`);
  }

  lines.push('');

  // Current model + curated list
  const models = getCuratedModels(currentProvider);
  lines.push(`  ${theme.style('fg.muted', 'model:')} ${theme.style('fg.primary', currentModel)}`);
  if (models.length > 0) {
    const modelPreview = models.slice(0, 4).map(m => truncate(m, 30)).join(', ');
    lines.push(`  ${theme.style('fg.dim', modelPreview)}`);
  }

  lines.push('');
  lines.push(`  ${theme.style('fg.dim', '\u2191\u2193 navigate  Enter switch  Esc close  1-9 quick pick')}`);
  renderCenteredModalBox(buf, theme, rows, cols, modalWidth, lines);
}

function renderModelModal(buf, theme, rows, cols, modalState, currentModel) {
  const { glyphs } = theme;
  const modalWidth = Math.min(80, cols - 8);
  const listHeight = Math.max(6, Math.min(14, rows - 16));

  const lines = [
    theme.bold(theme.style('fg.primary', '  Model Picker')),
    '',
    `  ${theme.style('fg.muted', 'provider:')} ${theme.style('fg.secondary', modalState.providerId)}`,
    `  ${theme.style('fg.muted', 'current:')} ${theme.style('fg.primary', currentModel)}`,
    '',
  ];

  if (modalState.models.length === 0) {
    lines.push(`  ${theme.style('fg.dim', 'No models found. Use /model <name> for custom values.')}`);
  } else {
    const count = modalState.models.length;
    const { start, end } = getWindowedListRange(count, modalState.cursor, listHeight);

    for (let i = start; i < end; i++) {
      const isCursor = i === modalState.cursor;
      const marker = isCursor ? theme.style('accent.primary', glyphs.prompt) : ' ';
      const num = padTo(`${i + 1}.`, 4);
      const modelText = truncate(modalState.models[i], modalWidth - 14);
      const model = isCursor
        ? theme.style('accent.primary', modelText)
        : theme.style('fg.secondary', modelText);
      const currentMark = modalState.models[i] === currentModel
        ? theme.style('fg.dim', ' (current)')
        : '';
      lines.push(`  ${marker} ${num} ${model}${currentMark}`);
    }

    if (end < count) {
      lines.push(`  ${theme.style('fg.dim', `... ${count - end} more`)}`);
    }
  }

  lines.push('');
  if (modalState.loading) {
    lines.push(`  ${theme.style('fg.dim', 'Fetching live model list...')}`);
  } else if (modalState.error) {
    lines.push(`  ${theme.style('fg.dim', `Live fetch failed (${modalState.error}); showing curated list`)}`);
  } else if (modalState.source === 'live') {
    lines.push(`  ${theme.style('fg.dim', `${modalState.models.length} models from provider`)}`);
  } else {
    lines.push(`  ${theme.style('fg.dim', `${modalState.models.length} curated models`)}`);
  }
  lines.push(`  ${theme.style('fg.dim', '\u2191\u2193 navigate  Enter select  Esc close  1-9 quick pick')}`);
  renderCenteredModalBox(buf, theme, rows, cols, modalWidth, lines);
}

function formatRelativeTime(ts) {
  if (!Number.isFinite(Number(ts)) || Number(ts) <= 0) return 'unknown';
  const deltaMs = Math.max(0, Date.now() - Number(ts));
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const iso = new Date(Number(ts)).toISOString();
  return iso.slice(0, 16).replace('T', ' ');
}

function renderResumeModal(buf, theme, rows, cols, modalState, currentSessionId) {
  const { glyphs } = theme;
  
  // Two-column layout: sessions list + preview
  const totalWidth = Math.min(140, cols - 4);
  const listWidth = Math.floor(totalWidth * 0.55);
  const previewWidth = totalWidth - listWidth - 1; // -1 for divider
  const listHeight = Math.max(8, Math.min(16, rows - 12));
  const totalHeight = listHeight + 8; // + header + filter + hints + borders
  
  const { top: modalTop, left: modalLeft } = getCenteredModalRect(rows, cols, totalWidth, totalHeight, { minTop: 2 });
  
  const isRenameMode = modalState?.mode === 'rename';
  const isFilterMode = modalState?.mode === 'filter';
  
  // Helper to draw the list side
  function renderList() {
    const lines = [theme.bold(theme.style('fg.primary', '  Resume Session'))];
    
    // Filter bar
    if (isFilterMode) {
      const filterText = modalState.filterBuf || '';
      const filterDisplay = filterText || theme.style('fg.dim', 'type to filter...');
      lines.push(`  ${theme.style('accent.primary', '/')} ${filterDisplay}`);
    } else {
      const filterHint = modalState?.filterBuf 
        ? `${theme.style('accent.primary', 'filter:')} ${truncate(modalState.filterBuf, listWidth - 20)}`
        : theme.style('fg.dim', '  Press / to filter');
      lines.push(filterHint);
    }
    lines.push(theme.style('fg.dim', glyphs.horizontal.repeat(listWidth - 4)));
    
    if (!modalState || modalState.loading) {
      lines.push(`  ${theme.style('fg.dim', 'Loading...')}`);
    } else if (modalState.error) {
      lines.push(`  ${theme.style('state.error', modalState.error)}`);
    } else if (!Array.isArray(modalState.filteredRows) || modalState.filteredRows.length === 0) {
      lines.push(`  ${theme.style('fg.dim', modalState.filterBuf ? 'No matching sessions.' : 'No resumable sessions.')}`);
    } else {
      const count = modalState.filteredRows.length;
      const { start, end } = getWindowedListRange(count, modalState.cursor, listHeight - 3);
      
      for (let i = start; i < end; i++) {
        const row = modalState.filteredRows[i].item;
        const isCursor = i === modalState.cursor;
        const isCurrent = row.sessionId === currentSessionId;
        const marker = isCursor ? theme.style('accent.primary', glyphs.prompt) : ' ';
        const num = padTo(`${i + 1}.`, 4);
        const primaryRaw = row.sessionName || row.sessionId.slice(0, 20);
        const primaryText = truncate(primaryRaw, Math.max(12, listWidth - 30));
        const primary = isCursor
          ? theme.style('accent.primary', primaryText)
          : theme.style('fg.primary', primaryText);
        const currentTag = isCurrent ? theme.style('state.success', ' ●') : '';
        const deleteTag = modalState.confirmDeleteId === row.sessionId
          ? theme.style('state.warn', ' [del?]')
          : '';
        const renameTag = isRenameMode && modalState.renameTargetId === row.sessionId
          ? theme.style('accent.secondary', ' [ren]')
          : '';
        lines.push(` ${marker} ${num}${primary}${currentTag}${deleteTag}${renameTag}`);
        
        const meta = truncate(
          `${row.provider}/${row.model} · ${formatRelativeTime(row.updatedAt)}`,
          listWidth - 10,
        );
        lines.push(`      ${theme.style('fg.dim', meta)}`);
      }
      if (end < count) {
        lines.push(`  ${theme.style('fg.dim', `... ${count - end} more`)}`);
      }
    }
    
    // Fill remaining space
    while (lines.length < listHeight + 3) {
      lines.push('');
    }
    
    return lines;
  }
  
  // Helper to draw the preview side
  function renderPreview() {
    const lines = [theme.bold(theme.style('fg.primary', '  Preview'))];
    lines.push(theme.style('fg.dim', glyphs.horizontal.repeat(previewWidth - 4)));
    
    const selected = modalState?.filteredRows?.[modalState?.cursor]?.item;
    
    if (!selected) {
      lines.push(`  ${theme.style('fg.dim', 'Select a session to preview')}`);
    } else if (modalState?.preview?.loading) {
      lines.push(`  ${theme.style('fg.dim', 'Loading preview...')}`);
    } else if (modalState?.preview?.error) {
      lines.push(`  ${theme.style('state.error', modalState.preview.error)}`);
    } else if (!modalState?.preview?.messages?.length) {
      lines.push(`  ${theme.style('fg.dim', 'No messages in session')}`);
    } else {
      const msgs = modalState.preview.messages.slice(-4);
      for (const msg of msgs) {
        const role = msg.role === 'user' ? theme.style('accent.secondary', 'You:') : theme.style('accent.primary', 'AI:');
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        const preview = truncate(content.replace(/\n/g, ' '), previewWidth - 10);
        lines.push(`  ${role} ${theme.style('fg.secondary', preview)}`);
      }
    }
    
    // Session details section
    if (selected) {
      lines.push('');
      lines.push(theme.style('fg.dim', glyphs.horizontal.repeat(previewWidth - 4)));
      lines.push(`  ${theme.style('fg.muted', 'ID:')} ${theme.style('fg.secondary', selected.sessionId)}`);
      if (selected.sessionName) {
        lines.push(`  ${theme.style('fg.muted', 'Name:')} ${theme.style('fg.primary', selected.sessionName)}`);
      }
      lines.push(`  ${theme.style('fg.muted', 'Path:')} ${theme.style('fg.secondary', truncate(selected.cwd || '.', previewWidth - 12))}`);
      lines.push(`  ${theme.style('fg.muted', 'Model:')} ${theme.style('fg.secondary', `${selected.provider}/${selected.model}`)}`);
    }
    
    // Fill remaining space
    while (lines.length < listHeight + 3) {
      lines.push('');
    }
    
    return lines;
  }
  
  // Draw both sides
  const listLines = renderList();
  const previewLines = renderPreview();
  
  const combinedLines = [];
  for (let i = 0; i < Math.max(listLines.length, previewLines.length); i++) {
    const left = padTo(listLines[i] || '', listWidth);
    const divider = theme.style('fg.dim', i === 0 ? '┬' : i === Math.max(listLines.length, previewLines.length) - 1 ? '┴' : '│');
    const right = previewLines[i] || '';
    combinedLines.push(left + divider + right);
  }
  
  // Add hints at the bottom
  combinedLines.push(theme.style('fg.dim', glyphs.horizontal.repeat(totalWidth)));
  if (isRenameMode) {
    combinedLines.push(`  ${theme.style('accent.primary', 'Enter')} save  ${theme.style('accent.primary', 'Esc')} cancel  ${theme.style('fg.dim', 'Type to rename')}`);
  } else if (isFilterMode) {
    combinedLines.push(`  ${theme.style('accent.primary', 'Enter')} apply filter  ${theme.style('accent.primary', 'Esc')} clear  ${theme.style('fg.dim', 'Type to search')}`);
  } else if (modalState?.confirmDeleteId) {
    combinedLines.push(`  ${theme.style('state.warn', 'Enter/D to confirm delete · Esc to cancel')}`);
  } else {
    const hints = [
      theme.style('accent.link', '↑↓') + theme.style('fg.dim', ' nav '),
      theme.style('accent.link', 'Enter') + theme.style('fg.dim', ' resume '),
      theme.style('accent.link', '/') + theme.style('fg.dim', ' filter '),
      theme.style('accent.link', 'R') + theme.style('fg.dim', ' rename '),
      theme.style('accent.link', 'D') + theme.style('fg.dim', ' delete '),
      theme.style('accent.link', 'Esc') + theme.style('fg.dim', ' close'),
    ].join(' ');
    combinedLines.push(`  ${hints}`);
  }
  
  // Draw the box
  drawModalBoxAt(buf, theme, modalTop, modalLeft, totalWidth, combinedLines);
}

// ── Config modal ─────────────────────────────────────────────────────

/** Mask an input string: show dots except last 4 chars for verification. */
function maskInput(str) {
  if (str.length <= 4) return str;
  return '\u2022'.repeat(str.length - 4) + str.slice(-4);
}

/**
 * Build the ordered list of config items.
 * Provider rows followed by: tavily, sandbox, execMode, explain.
 */
function getConfigItems(providerList, config) {
  const items = [];
  for (const p of providerList) {
    const providerConf = config[p.id] || {};
    const cfg = PROVIDER_CONFIGS[p.id];
    let keyStatus = false;
    try {
      const k = resolveApiKey(cfg);
      if (k) keyStatus = true;
    } catch { /* no key */ }
    items.push({
      type: 'provider',
      id: p.id,
      hasKey: keyStatus,
      model: providerConf.model || cfg.defaultModel,
    });
  }
  // Tavily
  const tavilyKey = process.env.PUSH_TAVILY_API_KEY || config.tavilyApiKey || '';
  items.push({ type: 'tavily', id: 'tavily', hasKey: Boolean(tavilyKey) });
  // Sandbox
  const sandbox = process.env.PUSH_LOCAL_SANDBOX || (config.localSandbox !== undefined ? String(config.localSandbox) : 'off');
  const sandboxOn = sandbox === 'true' || sandbox === '1';
  items.push({ type: 'sandbox', id: 'sandbox', sandboxOn });
  // ExecMode
  const execMode = process.env.PUSH_EXEC_MODE || config.execMode || 'auto';
  items.push({ type: 'execMode', id: 'execMode', execMode });
  // ExplainMode
  const explainOn = process.env.PUSH_EXPLAIN_MODE === 'true' || config.explainMode === true;
  items.push({ type: 'explain', id: 'explain', explainOn });
  return items;
}

function renderConfigModal(buf, theme, rows, cols, modalState, config) {
  const { glyphs } = theme;
  const providers = getProviderList();
  const items = getConfigItems(providers, config);
  const modalWidth = Math.min(50, cols - 8);

  if (modalState.mode === 'list') {
    // ── List mode ──
    const lines = [
      theme.bold(theme.style('fg.primary', '  Config')),
      '',
    ];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const isCursor = i === modalState.cursor;
      const marker = isCursor ? theme.style('accent.primary', '\u203A') : ' ';
      const num = `${i + 1}.`;

      if (item.type === 'provider') {
        const keyIcon = item.hasKey
          ? theme.style('state.success', glyphs.check)
          : theme.style('fg.dim', '-');
        const modelStr = truncate(item.model, modalWidth - 28);
        const name = isCursor
          ? theme.style('accent.primary', item.id)
          : theme.style('fg.secondary', item.id);
        const nameCol = padTo(name, 14);
        lines.push(`  ${marker} ${num} ${nameCol} ${keyIcon}  ${theme.style('fg.dim', modelStr)}`);
      } else if (item.type === 'tavily') {
        const keyIcon = item.hasKey
          ? theme.style('state.success', glyphs.check)
          : theme.style('fg.dim', '-');
        const name = isCursor
          ? theme.style('accent.primary', 'tavily')
          : theme.style('fg.secondary', 'tavily');
        lines.push(`  ${marker} ${num} ${padTo(name, 14)} ${keyIcon}`);
      } else if (item.type === 'sandbox') {
        const status = item.sandboxOn
          ? theme.style('state.success', 'on')
          : theme.style('fg.dim', 'off');
        const name = isCursor
          ? theme.style('accent.primary', 'sandbox')
          : theme.style('fg.secondary', 'sandbox');
        lines.push(`  ${marker} ${num} ${padTo(name, 14)} ${status}`);
      } else if (item.type === 'execMode') {
        const modeColor = item.execMode === 'yolo' ? 'state.warning' : item.execMode === 'auto' ? 'state.success' : 'fg.secondary';
        const modeStr = theme.style(modeColor, item.execMode);
        const name = isCursor
          ? theme.style('accent.primary', 'execMode')
          : theme.style('fg.secondary', 'execMode');
        lines.push(`  ${marker} ${num} ${padTo(name, 14)} ${modeStr}`);
      } else if (item.type === 'explain') {
        const status = item.explainOn
          ? theme.style('state.success', 'on')
          : theme.style('fg.dim', 'off');
        const name = isCursor
          ? theme.style('accent.primary', 'explain')
          : theme.style('fg.secondary', 'explain');
        lines.push(`  ${marker} ${num} ${padTo(name, 14)} ${status}`);
      }

      // Visual gap between providers and extras
      if (i === providers.length - 1) lines.push('');
    }

    lines.push('');
    lines.push(
      `  ${theme.style('fg.dim', '\u2191\u2193 navigate  Enter edit  Esc close')}`
    );

    renderCenteredModalBox(buf, theme, rows, cols, modalWidth, lines);
  } else if (modalState.mode === 'edit') {
    // ── Edit mode ──
    const targetLabel = modalState.editTarget;
    const lines = [
      theme.bold(theme.style('fg.primary', `  API key for ${targetLabel}`)),
      '',
    ];

    // Show current key (masked)
    let currentDisplay = '(not set)';
    if (targetLabel === 'tavily') {
      const k = process.env.PUSH_TAVILY_API_KEY || config.tavilyApiKey || '';
      if (k) currentDisplay = maskSecret(k);
    } else {
      const cfg = PROVIDER_CONFIGS[targetLabel];
      if (cfg) {
        try {
          const k = resolveApiKey(cfg);
          if (k) currentDisplay = maskSecret(k);
        } catch { /* no key */ }
      }
    }
    lines.push(`  ${theme.style('fg.muted', 'Current:')} ${theme.style('fg.secondary', currentDisplay)}`);
    lines.push('');

    // Input line with masked display
    const inputDisplay = modalState.editBuf
      ? maskInput(modalState.editBuf)
      : '';
    const inputWidth = modalWidth - 8;
    const inputPad = inputDisplay
      ? truncate(inputDisplay, inputWidth)
      : theme.style('fg.dim', '_'.repeat(Math.min(36, inputWidth)));
    lines.push(`  ${theme.style('accent.primary', '\u203A')} ${inputPad}`);
    lines.push('');
    lines.push(`  ${theme.style('fg.dim', 'Paste key + Enter to save \u00B7 Esc cancel')}`);

    renderCenteredModalBox(buf, theme, rows, cols, modalWidth, lines);
  } else if (modalState.mode === 'pick') {
    // ── Pick mode (exec mode selection) ──
    const EXEC_MODES = [
      { id: 'strict', desc: 'prompt before every exec command' },
      { id: 'auto',   desc: 'prompt only for high-risk commands' },
      { id: 'yolo',   desc: 'no exec prompts' },
    ];
    const lines = [
      theme.bold(theme.style('fg.primary', '  Exec mode')),
      '',
    ];
    for (let i = 0; i < EXEC_MODES.length; i++) {
      const m = EXEC_MODES[i];
      const isCursor = i === modalState.pickCursor;
      const marker = isCursor ? theme.style('accent.primary', '\u203A') : ' ';
      const label = isCursor ? theme.style('accent.primary', m.id) : theme.style('fg.secondary', m.id);
      lines.push(`  ${marker} ${padTo(label, 8)}  ${theme.style('fg.dim', m.desc)}`);
    }
    lines.push('');
    lines.push(`  ${theme.style('fg.dim', '\u2191\u2193 select  Enter save  Esc cancel')}`);

    renderCenteredModalBox(buf, theme, rows, cols, modalWidth, lines);
  }
}

// ── Main TUI entry point ────────────────────────────────────────────

/**
 * Run the full-screen TUI.
 * @param {{ sessionId?, provider?, model?, cwd?, maxRounds? }} options
 */
export async function runTUI(options = {}) {
  const theme = createTheme();
  const tuiState = createTUIState();
  const composer = createComposer();
  const keybinds = createKeybindMap();
  const screenBuf = createScreenBuffer();
  const inputHistory = createInputHistory();

  // ── Resolve provider/session ─────────────────────────────────────

  const config = await loadConfig();
  applyConfigToEnv(config);
  const safeExecPatterns = Array.isArray(config.safeExecPatterns) ? config.safeExecPatterns : [];

  const maxRounds = options.maxRounds || DEFAULT_MAX_ROUNDS;

  async function createFreshSessionState(providerName, requestedModel, cwd) {
    const providerConfig = PROVIDER_CONFIGS[providerName];
    if (!providerConfig) throw new Error(`Unknown provider: ${providerName}`);
    const sessionId = makeSessionId();
    const now = Date.now();
    const nextState = {
      sessionId,
      createdAt: now,
      updatedAt: now,
      provider: providerName,
      model: requestedModel,
      cwd,
      rounds: 0,
      eventSeq: 0,
      workingMemory: {
        plan: '',
        openTasks: [],
        filesTouched: [],
        assumptions: [],
        errorsEncountered: [],
        currentPhase: '',
        completedPhases: [],
      },
      messages: [{ role: 'system', content: buildSystemPromptBase(cwd) }],
    };
    // Start enriching the system prompt in the background — will be
    // awaited before the first LLM call in runAssistantLoop.
    ensureSystemPromptReady(nextState);
    // Disk writes are deferred to first user message (lazy session creation).
    return nextState;
  }

  // ── Session init ─────────────────────────────────────────────────

  let state;
  if (options.sessionId) {
    state = await loadSessionState(options.sessionId);
    // Optional resume overrides
    let stateChanged = false;

    if (options.provider) {
      const overrideProvider = options.provider.toLowerCase();
      const overrideConfig = PROVIDER_CONFIGS[overrideProvider];
      if (!overrideConfig) throw new Error(`Unknown provider: ${overrideProvider}`);
      if (overrideProvider !== state.provider) {
        state.provider = overrideProvider;
        state.model = options.model || overrideConfig.defaultModel;
        stateChanged = true;
      }
    }

    if (options.model && options.model !== state.model) {
      state.model = options.model;
      stateChanged = true;
    }

    if (options.cwd) {
      const resolvedCwd = path.resolve(options.cwd);
      if (resolvedCwd !== state.cwd) {
        state.cwd = resolvedCwd;
        stateChanged = true;
      }
    }

    if (stateChanged) {
      await saveSessionState(state);
    }
  } else {
    const providerName = (options.provider || process.env.PUSH_PROVIDER || config.provider || 'ollama').toLowerCase();
    const cwd = path.resolve(options.cwd || process.cwd());
    const providerConfig = PROVIDER_CONFIGS[providerName];
    if (!providerConfig) throw new Error(`Unknown provider: ${providerName}`);
    const requestedModel = options.model || providerConfig.defaultModel;
    state = await createFreshSessionState(providerName, requestedModel, cwd);
  }

  const activeProviderConfig = PROVIDER_CONFIGS[state.provider];
  if (!activeProviderConfig) throw new Error(`Unknown provider in session: ${state.provider}`);

  // Mutable context for mid-session switching
  const ctx = {
    providerConfig: activeProviderConfig,
    apiKey: resolveApiKey(activeProviderConfig),
  };

  // ── Lazy session creation ─────────────────────────────────────────
  // Resumed sessions are already on disk; fresh sessions are persisted on first message.
  let sessionPersisted = !!options.sessionId;

  async function ensureSessionPersisted() {
    if (sessionPersisted) return;
    sessionPersisted = true;
    await appendSessionEvent(state, 'session_started', {
      sessionId: state.sessionId,
      state: 'idle',
      mode: 'tui',
      provider: state.provider,
    });
    await saveSessionState(state);
  }

  async function refreshSystemPromptForConfigChange() {
    if (!state || !Array.isArray(state.messages) || !state.cwd) return;
    const sysMsg = state.messages[0];
    if (!sysMsg || sysMsg.role !== 'system') return;

    // Replace the object so any in-flight enrichment promise writes to the stale
    // message object instead of clobbering this refreshed prompt.
    state.messages[0] = { role: 'system', content: buildSystemPromptBase(state.cwd) };
    await ensureSystemPromptReady(state);

    if (sessionPersisted) {
      await saveSessionState(state);
    }
  }

  // ── Git branch (best-effort) ─────────────────────────────────────

  let branch = '';
  async function refreshBranchLabel() {
    branch = '';
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execAsync = promisify(execFile);
      const { stdout } = await execAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: state.cwd });
      branch = stdout.trim();
    } catch { /* not a git repo */ }
  }
  await refreshBranchLabel();
  
  // ── Git status (for status bar) ───────────────────────────────────
  let scheduler = null;
  
  async function refreshGitStatus() {
    const status = await getCompactGitStatus(state.cwd);
    if (JSON.stringify(status) !== JSON.stringify(tuiState.gitStatus)) {
      tuiState.gitStatus = status;
      tuiState.dirty.add('footer');
      scheduler?.schedule();
    }
  }
  
  // Initial git status
  await refreshGitStatus();
  
  // Periodic git status refresh (every 5 seconds)
  let gitStatusInterval = setInterval(() => {
    void refreshGitStatus();
  }, 5000);
  
  // Git status will be refreshed periodically and after certain events

  // ── Abort controller ─────────────────────────────────────────────

  let runAbort = null;

  // ── Enter alternate screen ───────────────────────────────────────

  process.stdout.write(ESC.altScreenOn + ESC.cursorHide + ESC.clearScreen + ESC.bracketedPasteOn);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding(null);

  let layoutCache = null; // { key, layout }
  let renderFrameMeta = {
    rows: 0,
    cols: 0,
    layoutKey: '',
    hadOverlay: false,
    tooSmall: false,
    initialized: false,
  };

  function getVisibleOverlayKind() {
    if (tuiState.runState === 'awaiting_approval' && tuiState.approval) return 'approval';
    if (tuiState.runState === 'awaiting_user_question' && tuiState.userQuestion) return 'question';
    return getActiveOverlayModal();
  }

  // ── Render function ──────────────────────────────────────────────

  function render() {
    const { rows, cols } = getTermSize();

    // Min terminal size guard
    if (rows < 16 || cols < 60) {
      screenBuf.clear();
      screenBuf.write(ESC.clearScreen);
      const msg = 'Terminal too small (need 60x16)';
      const msgRow = Math.max(1, Math.floor(rows / 2));
      const msgCol = Math.max(1, Math.floor((cols - msg.length) / 2) + 1);
      screenBuf.writeLine(msgRow, msgCol, msg);
      screenBuf.flush();
      renderFrameMeta = { rows, cols, layoutKey: '', hadOverlay: false, tooSmall: true, initialized: true };
      return;
    }

    const composerLines = composer.getLines().length;
    const layoutKey = `${rows}x${cols}:${tuiState.toolPaneOpen ? 1 : 0}:${composerLines}`;
    let layout = layoutCache?.key === layoutKey ? layoutCache.layout : null;
    if (!layout) {
      layout = computeLayout(rows, cols, {
        toolPaneOpen: tuiState.toolPaneOpen,
        composerLines,
      });
      layoutCache = { key: layoutKey, layout };
    }

    screenBuf.clear();

    // Live-suggest candidates from current composer text (no-op when cycling)
    tabCompleter.suggest(composer.getText());
    const tabState = tabCompleter.isActive()
      ? { hint: tabCompleter.getHint(), candidates: tabCompleter.getState() }
      : null;

    const overlayKind = getVisibleOverlayKind();
    const mustFullRedraw =
      tuiState.dirty.has('all') ||
      !renderFrameMeta.initialized ||
      renderFrameMeta.tooSmall ||
      renderFrameMeta.rows !== rows ||
      renderFrameMeta.cols !== cols ||
      renderFrameMeta.layoutKey !== layoutKey ||
      renderFrameMeta.hadOverlay ||
      Boolean(overlayKind);

    const renderHeaderRegion = () => {
      renderHeader(screenBuf, layout, theme, {
        provider: state.provider,
        model: state.model,
        session: state.sessionId,
        cwd: state.cwd,
        runState: tuiState.runState,
        branch,
      });
      screenBuf.writeLine(
        layout.header.top + layout.header.height,
        layout.innerLeft,
        drawDivider(layout.innerWidth, theme.glyphs, theme)
      );
    };

    const renderFooterRegion = () => {
      const isStreaming = tuiState.runState === 'running' && tuiState.streamBuf.length > 0;
      renderStatusBar(screenBuf, layout, theme, {
        gitStatus: tuiState.gitStatus,
        cwd: state.cwd,
        tokens: estimateTokens(state.messages),
        isStreaming,
        messageCount: state.messages?.length || 0,
      });
      renderKeybindHints(screenBuf, layout, theme, tuiState);
    };

    if (mustFullRedraw) {
      // Background fill
      screenBuf.write(theme.bg('bg.base'));
      screenBuf.write(ESC.clearScreen);

      renderHeaderRegion();
      renderTranscript(screenBuf, layout, theme, tuiState);
      renderToolPane(screenBuf, layout, theme, tuiState);
      renderComposer(screenBuf, layout, theme, composer, tuiState, tabState);
      renderFooterRegion();
    } else {
      screenBuf.write(theme.bg('bg.base'));
      if (tuiState.dirty.has('header')) {
        renderHeaderRegion();
      }
      if (tuiState.dirty.has('transcript')) {
        renderTranscript(screenBuf, layout, theme, tuiState);
      }
      if (tuiState.dirty.has('tools')) {
        renderToolPane(screenBuf, layout, theme, tuiState);
      }
      if (tuiState.dirty.has('composer')) {
        renderComposer(screenBuf, layout, theme, composer, tuiState, tabState);
      }
      if (tuiState.dirty.has('footer')) {
        renderFooterRegion();
      }
    }

    // Overlays (approval/question are run-state overlays; others are UI overlays)
    switch (overlayKind) {
      case 'approval':
        renderApprovalModal(screenBuf, theme, rows, cols, tuiState.approval);
        break;
      case 'question':
        renderQuestionModal(screenBuf, theme, rows, cols, tuiState.userQuestion, questionInputBuf);
        break;
      case 'reasoning':
        renderReasoningModal(screenBuf, theme, rows, cols, tuiState);
        break;
      case 'provider':
        renderProviderModal(screenBuf, theme, rows, cols, state.provider, state.model, tuiState.providerModalCursor);
        break;
      case 'resume':
        if (tuiState.resumeModalState) {
          renderResumeModal(screenBuf, theme, rows, cols, tuiState.resumeModalState, state.sessionId);
        }
        break;
      case 'model':
        if (tuiState.modelModalState) {
          renderModelModal(screenBuf, theme, rows, cols, tuiState.modelModalState, state.model);
        }
        break;
      case 'config':
        if (tuiState.configModalState) {
          renderConfigModal(screenBuf, theme, rows, cols, tuiState.configModalState, config);
        }
        break;
    }

    // Position cursor — in modal edit mode, place cursor in the modal input field
    let cursorRow, cursorCol;
    if (overlayKind === 'config' && tuiState.configModalState?.mode === 'edit') {
      const ms = tuiState.configModalState;
      const modalWidth = Math.min(50, cols - 8);
      const { left, top } = getCenteredModalRect(rows, cols, modalWidth, 8); // 8 lines tall for edit mode
      // Edit mode layout: title(1) + blank(1) + current(1) + blank(1) + input(1) + blank(1) + help(1) = ~7 lines
      // Input line is at offset 4 from top (0-indexed: 0=title, 1=blank, 2=current, 3=blank, 4=input)
      cursorRow = top + 4;
      // Cursor col: left padding (2) + prompt '› ' (2) + edit cursor position
      cursorCol = left + 2 + 2 + ms.editCursor;
    } else {
      // Position cursor in composer (offset by 1 if candidates bar is visible)
      const cursor = composer.getCursor();
      const candidateOffset = tabState ? 1 : 0;
      cursorRow = layout.composer.top + 1 + candidateOffset + cursor.line;
      const cursorLine = composer.getLines()[cursor.line] || '';
      cursorCol = layout.innerLeft + 2 + visibleWidth(cursorLine.slice(0, cursor.col)); // +2 for prompt prefix, CJK-aware
    }
    screenBuf.write(ESC.cursorTo(cursorRow, cursorCol));

    // Show cursor only when idle
    if (tuiState.runState === 'idle') {
      screenBuf.write(ESC.cursorShow);
    } else {
      screenBuf.write(ESC.cursorHide);
    }

    screenBuf.write(theme.RESET);
    screenBuf.flush();
    tuiState.dirty.clear();
    renderFrameMeta = {
      rows,
      cols,
      layoutKey,
      hadOverlay: Boolean(overlayKind),
      tooSmall: false,
      initialized: true,
    };
  }

  scheduler = createRenderScheduler(render);

  // ── Engine event handler ─────────────────────────────────────────

  function handleEngineEvent(event) {
    switch (event.type) {
      case 'assistant_thinking_token':
        if (!tuiState.reasoningStreaming) {
          thinkingPhaseStart = tuiState.reasoningBuf.length; // mark start of this chunk
        }
        tuiState.reasoningBuf += event.payload.text;
        tuiState.reasoningStreaming = true;
        tuiState.dirty.add(tuiState.reasoningModalOpen ? 'all' : 'footer');
        scheduler.schedule();
        break;

      case 'assistant_thinking_done': {
        tuiState.reasoningStreaming = false;
        const chunk = tuiState.reasoningBuf.slice(thinkingPhaseStart).trim();
        if (chunk) {
          tuiState.lastReasoning = tuiState.reasoningBuf;
          addTranscriptEntry(tuiState, 'reasoning', chunk);
        }
        if (tuiState.reasoningModalOpen) tuiState.dirty.add('all');
        scheduler.schedule();
        break;
      }

      case 'assistant_token':
        tuiState.streamBuf += event.payload.text;
        tuiState.scrollOffset = 0; // auto-scroll on new tokens
        tuiState.dirty.add('transcript');
        tuiState.dirty.add('footer'); // LIVE indicator
        scheduler.schedule();
        break;

      case 'assistant_done':
        if (tuiState.streamBuf) {
          addTranscriptEntry(tuiState, 'assistant', tuiState.streamBuf);
          tuiState.streamBuf = '';
        }
        tuiState.dirty.add('footer'); // LIVE indicator clears
        tuiState.reasoningStreaming = false;
        if (tuiState.reasoningBuf.trim()) {
          tuiState.lastReasoning = tuiState.reasoningBuf;
        }
        scheduler.schedule();
        break;

      case 'tool_call':
        addToolFeedEntry(tuiState, {
          type: 'call',
          name: event.payload.toolName,
          args: event.payload.args,
        });
        pushTranscriptEntry(tuiState, {
          role: 'tool_call',
          text: event.payload.toolName,
          error: false,
          timestamp: Date.now(),
        });
        scheduler.schedule();
        break;

      case 'tool_result': {
        const isError = event.payload.isError;
        const text = event.payload.text || '';
        addToolFeedEntry(tuiState, {
          type: 'result',
          name: event.payload.toolName,
          duration: event.payload.durationMs,
          error: isError,
          preview: text.slice(0, 100),
        });
        // Update the last tool_call transcript entry with result info
        let updatedTranscriptToolCall = false;
        for (let i = tuiState.transcript.length - 1; i >= 0; i--) {
          if (tuiState.transcript[i].role === 'tool_call' && tuiState.transcript[i].text === event.payload.toolName) {
            tuiState.transcript[i].error = isError;
            tuiState.transcript[i].duration = event.payload.durationMs;
            updatedTranscriptToolCall = true;
            break;
          }
        }
        if (updatedTranscriptToolCall) {
          invalidateTranscriptRenderCache(tuiState);
          tuiState.dirty.add('transcript');
        }
        scheduler.schedule();
        // Refresh git status after file-modifying operations
        if (!isError && ['write_file', 'edit_file', 'git_commit', 'exec'].includes(event.payload.toolName)) {
          setTimeout(() => refreshGitStatus(), 300);
        }
        break;
      }

      case 'status':
        addTranscriptEntry(tuiState, 'status', event.payload.detail || event.payload.phase);
        scheduler.schedule();
        break;

      case 'warning':
        addTranscriptEntry(tuiState, 'warning', event.payload.message || event.payload.code);
        scheduler.schedule();
        break;

      case 'error':
        addTranscriptEntry(tuiState, 'error', event.payload.message);
        scheduler.schedule();
        break;

      case 'run_complete':
        tuiState.runState = 'idle';
        tuiState.streamBuf = '';
        tuiState.reasoningStreaming = false;
        if (tuiState.reasoningBuf.trim()) {
          tuiState.lastReasoning = tuiState.reasoningBuf;
        }
        tuiState.dirty.add('all');
        process.stdout.write('\x07'); // bell
        scheduler.schedule();
        break;
    }
  }

  // ── Approval handling ────────────────────────────────────────────

  let approvalResolve = null;
  const trustedPatterns = new Set();
  let thinkingPhaseStart = 0;

  // ── Ask-user handling ─────────────────────────────────────────────

  let questionResolve = null;
  let questionInputBuf = '';

  function makeAskUserFn() {
    return (question, choices) => new Promise((resolve) => {
      questionInputBuf = '';
      questionResolve = resolve;
      tuiState.runState = 'awaiting_user_question';
      tuiState.userQuestion = { question, choices: choices ?? null };
      tuiState.dirty.add('all');
      scheduler.flush();
    });
  }

  function submitQuestionAnswer() {
    if (questionResolve) {
      const answer = questionInputBuf;
      questionResolve(answer);
      questionResolve = null;
      questionInputBuf = '';
      tuiState.userQuestion = null;
      tuiState.runState = 'running';
      tuiState.dirty.add('all');
      scheduler.schedule();
    }
  }

  function dismissQuestion() {
    if (questionResolve) {
      questionResolve('(skipped — make a reasonable assumption)');
      questionResolve = null;
      questionInputBuf = '';
      tuiState.userQuestion = null;
      tuiState.runState = 'running';
      tuiState.dirty.add('all');
      scheduler.schedule();
    }
  }

  /** Dedicated input handler for the ask_user modal — captures typed text. */
  function handleQuestionInput(key) {
    if (key.name === 'return' || key.name === 'enter') {
      submitQuestionAnswer();
      return;
    }
    if (key.name === 'escape') {
      dismissQuestion();
      return;
    }
    if (key.name === 'backspace' || key.name === 'delete') {
      if (questionInputBuf.length > 0) {
        questionInputBuf = questionInputBuf.slice(0, -1);
        tuiState.dirty.add('all');
        scheduler.schedule();
      }
      return;
    }
    // Printable character
    if (key.sequence && !key.ctrl && !key.meta && key.sequence.length === 1 && key.sequence.charCodeAt(0) >= 32) {
      questionInputBuf += key.sequence;
      tuiState.dirty.add('all');
      scheduler.schedule();
    }
  }

  function makeApprovalFn() {
    return (tool, detail) => {
      const patternIndex = matchingRiskPatternIndex(detail);

      // Session trust: auto-approve if this risk pattern was previously trusted
      if (patternIndex >= 0 && trustedPatterns.has(patternIndex)) {
        addTranscriptEntry(tuiState, 'status', `[auto-approved] ${tool}: ${detail}`);
        scheduler.schedule();
        return Promise.resolve(true);
      }

      return new Promise((resolve) => {
        tuiState.runState = 'awaiting_approval';
        tuiState.approval = { kind: tool, summary: detail, patternIndex };
        approvalResolve = resolve;
        tuiState.dirty.add('all');
        scheduler.flush();
      });
    };
  }

  // ── Skills ────────────────────────────────────────────────────────

  const skills = await loadSkills(state.cwd);

  async function reloadSkillsMap() {
    const fresh = await loadSkills(state.cwd);
    skills.clear();
    for (const [name, skill] of fresh) {
      skills.set(name, skill);
    }
    tabCompleter.reset();
    return skills.size;
  }

  function createCurrentTabCompleter() {
    return createTabCompleter({
      ctx, skills, getCuratedModels, getProviderList,
      workspaceRoot: state.cwd,
      extraCommands: ['resume', 'compact'],
    });
  }

  let tabCompleter = createCurrentTabCompleter();

  function formatError(err) {
    if (err instanceof Error && err.message) return err.message;
    return String(err);
  }

  function handleAsyncError(err, context = '') {
    const message = context ? `${context}: ${formatError(err)}` : formatError(err);
    addTranscriptEntry(tuiState, 'error', message);
    tuiState.dirty.add('all');
    scheduler.flush();
  }

  function runAsync(action, context = '') {
    try {
      const maybePromise = action();
      if (maybePromise && typeof maybePromise.then === 'function') {
        void maybePromise.catch((err) => {
          handleAsyncError(err, context);
        });
      }
    } catch (err) {
      handleAsyncError(err, context);
    }
  }

  // ── Actions ──────────────────────────────────────────────────────

  /** Run the assistant loop on a user message (or skill-expanded prompt). */
  async function runPrompt(text, options = {}) {
    tuiState.runState = 'running';
    tuiState.reasoningBuf = '';
    tuiState.reasoningStreaming = false;
    tuiState.dirty.add('all');
    scheduler.flush();

    await ensureSessionPersisted();
    await appendUserMessageWithFileReferences(state, text, state.cwd, {
      referenceSourceText: options.referenceSourceText,
    });
    await appendSessionEvent(state, 'user_message', { chars: text.length, preview: text.slice(0, 280) });

    runAbort = new AbortController();

    try {
      await runAssistantLoop(state, ctx.providerConfig, ctx.apiKey, maxRounds, {
        approvalFn: makeApprovalFn(),
        askUserFn: makeAskUserFn(),
        signal: runAbort.signal,
        emit: handleEngineEvent,
        safeExecPatterns,
        execMode: process.env.PUSH_EXEC_MODE || 'auto',
      });
      await saveSessionState(state);
    } catch (err) {
      if (err.name !== 'AbortError') {
        addTranscriptEntry(tuiState, 'error', err.message || String(err));
      }
      await saveSessionState(state);
    } finally {
      tuiState.runState = 'idle';
      runAbort = null;
      tuiState.dirty.add('all');
      scheduler.flush();
    }
  }

  async function compactSessionContext(rawArg) {
    const arg = String(rawArg || '').trim();
    let preserveTurns = DEFAULT_COMPACT_TURNS;
    if (arg) {
      if (!/^\d+$/.test(arg)) {
        addTranscriptEntry(tuiState, 'warning', 'Usage: /compact [turns] (positive integer)');
        scheduler.flush();
        return;
      }
      preserveTurns = Math.max(1, Math.min(64, Number.parseInt(arg, 10)));
    }

    const result = compactContext(state.messages, { preserveTurns });
    if (!result.compacted) {
      addTranscriptEntry(
        tuiState,
        'status',
        `Nothing to compact (turns: ${result.totalTurns}, preserve: ${result.preserveTurns}).`,
      );
      scheduler.flush();
      return;
    }

    state.messages = result.messages;
    await appendSessionEvent(state, 'context_compacted', {
      preserveTurns: result.preserveTurns,
      totalTurns: result.totalTurns,
      compactedMessages: result.compactedCount,
      removedCount: result.removedCount,
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
    });
    await saveSessionState(state);

    addTranscriptEntry(
      tuiState,
      'status',
      `Compacted context: ${result.compactedCount} messages -> 1 summary (kept last ${result.preserveTurns} turns, ~${result.beforeTokens} -> ~${result.afterTokens} tokens).`,
    );
    scheduler.flush();
  }

  async function renameCurrentSession(rawName) {
    const trimmed = typeof rawName === 'string' ? rawName.trim() : '';
    if (!trimmed) {
      addTranscriptEntry(tuiState, 'warning', 'Usage: /session rename <name> | /session rename --clear');
      scheduler.flush();
      return;
    }

    if (trimmed === '--clear') {
      delete state.sessionName;
      await appendSessionEvent(state, 'session_renamed', { name: null });
      await saveSessionState(state);
      addTranscriptEntry(tuiState, 'status', 'Session name cleared.');
      scheduler.flush();
      return;
    }

    state.sessionName = trimmed;
    await appendSessionEvent(state, 'session_renamed', { name: trimmed });
    await saveSessionState(state);
    addTranscriptEntry(tuiState, 'status', `Session renamed: ${JSON.stringify(trimmed)}`);
    scheduler.flush();
  }

  function resetTUIViewForSessionChange() {
    tuiState.runState = 'idle';
    tuiState.streamBuf = '';
    tuiState.approval = null;
    approvalResolve = null;
    setActiveOverlayModal(null);
    tuiState.payloadCursorId = null;
    tuiState.toolJsonPayloadsExpanded = false;
    tuiState.expandedToolJsonPayloadIds = new Set();
    tuiState.payloadBlocks = [];
    tuiState.reasoningBuf = '';
    tuiState.lastReasoning = '';
    tuiState.reasoningStreaming = false;
    tuiState.transcript = [];
    tuiState.transcriptVersion = 0;
    tuiState.transcriptRenderCache = null;
    tuiState.toolFeed = [];
    tuiState.scrollOffset = 0;
    tuiState.providerModalCursor = 0;
    tuiState.resumeModalState = null;
    tuiState.modelModalState = null;
    tuiState.configModalState = null;
    composer.clear();
    tabCompleter = createCurrentTabCompleter();
    tabCompleter.reset();
  }

  async function switchToSessionById(targetSessionId, { closePicker = true } = {}) {
    if (!targetSessionId) return false;
    if (tuiState.runState !== 'idle') {
      addTranscriptEntry(tuiState, 'warning', 'Cannot resume another session while a run is active.');
      scheduler.flush();
      return false;
    }

    if (targetSessionId === state.sessionId) {
      if (closePicker) {
        setActiveOverlayModal(null);
        tuiState.resumeModalState = null;
      }
      addTranscriptEntry(tuiState, 'status', `Already on session: ${state.sessionId}`);
      scheduler.flush();
      return true;
    }

    let nextState;
    try {
      nextState = await loadSessionState(targetSessionId);
    } catch (err) {
      addTranscriptEntry(tuiState, 'error', `Failed to load session ${targetSessionId}: ${formatError(err)}`);
      scheduler.flush();
      return false;
    }

    const nextProviderConfig = PROVIDER_CONFIGS[nextState.provider];
    if (!nextProviderConfig) {
      addTranscriptEntry(tuiState, 'error', `Cannot resume ${targetSessionId}: unknown provider "${nextState.provider}".`);
      scheduler.flush();
      return false;
    }

    let nextApiKey;
    try {
      nextApiKey = resolveApiKey(nextProviderConfig);
    } catch (err) {
      addTranscriptEntry(
        tuiState,
        'error',
        `Cannot resume ${targetSessionId}: missing API key for ${nextProviderConfig.id} (${formatError(err)}).`,
      );
      scheduler.flush();
      return false;
    }

    const previousSessionId = state.sessionId;
    await ensureSessionPersisted(); // flush any unpersisted current session before switching
    await saveSessionState(state);
    state = nextState;
    sessionPersisted = true; // resumed session is already on disk
    ctx.providerConfig = nextProviderConfig;
    ctx.apiKey = nextApiKey;

    await refreshBranchLabel();
    resetTUIViewForSessionChange();
    await reloadSkillsMap();

    const nameSuffix = state.sessionName ? ` (${JSON.stringify(state.sessionName)})` : '';
    addTranscriptEntry(
      tuiState,
      'status',
      `Resumed session: ${state.sessionId}${nameSuffix} (from ${previousSessionId}) [${state.provider}/${state.model}]`,
    );
    addTranscriptEntry(tuiState, 'status', `Workspace: ${state.cwd}`);
    tuiState.dirty.add('all');
    scheduler.flush();
    return true;
  }

  async function openResumeModal() {
    if (tuiState.runState !== 'idle') {
      addTranscriptEntry(tuiState, 'warning', 'Cannot open resume picker while a run is active.');
      scheduler.flush();
      return;
    }

    setActiveOverlayModal('resume');
    tuiState.resumeModalState = {
      loading: true,
      rows: [],
      filteredRows: [],
      cursor: 0,
      error: null,
      confirmDeleteId: null,
      mode: 'list',  // 'list', 'rename', 'filter'
      renameTargetId: null,
      renameBuf: '',
      renameCursor: 0,
      filterBuf: '',
      filterCursor: 0,
      preview: null,  // { messages: [], loading }
    };
    tuiState.dirty.add('all');
    scheduler.flush();

    try {
      const rows = await listSessions();
      const currentIndex = rows.findIndex((row) => row.sessionId === state.sessionId);
      const ms = {
        loading: false,
        rows,
        filteredRows: rows.map(r => ({ item: r, score: 1 })),
        cursor: currentIndex >= 0 ? currentIndex : 0,
        error: null,
        confirmDeleteId: null,
        mode: 'list',
        renameTargetId: null,
        renameBuf: '',
        renameCursor: 0,
        filterBuf: '',
        filterCursor: 0,
        preview: null,
      };
      tuiState.resumeModalState = ms;
      // Load preview for initially selected session
      await loadSessionPreview(ms);
    } catch (err) {
      tuiState.resumeModalState = {
        loading: false,
        rows: [],
        filteredRows: [],
        cursor: 0,
        error: `Failed to list sessions: ${formatError(err)}`,
        confirmDeleteId: null,
        mode: 'list',
        renameTargetId: null,
        renameBuf: '',
        renameCursor: 0,
        filterBuf: '',
        filterCursor: 0,
        preview: null,
      };
    }

    tuiState.dirty.add('all');
    scheduler.flush();
  }
  
  async function loadSessionPreview(ms) {
    if (!ms) return;
    const selected = ms.filteredRows[ms.cursor]?.item;
    if (!selected) {
      ms.preview = null;
      return;
    }
    
    ms.preview = { loading: true, messages: [] };
    tuiState.dirty.add('all');
    scheduler.schedule();
    
    try {
      const sessionState = await loadSessionState(selected.sessionId);
      // Get last 5 user/assistant message pairs
      const messages = (sessionState.messages || [])
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .slice(-6);
      ms.preview = { loading: false, messages };
    } catch {
      ms.preview = { loading: false, messages: [], error: 'Failed to load preview' };
    }
    tuiState.dirty.add('all');
    scheduler.schedule();
  }
  
  function updateFilteredRows(ms) {
    if (!ms.filterBuf) {
      ms.filteredRows = ms.rows.map(r => ({ item: r, score: 1 }));
    } else {
      ms.filteredRows = filterSessions(ms.rows, ms.filterBuf);
    }
    // Keep cursor in bounds
    ms.cursor = Math.min(ms.cursor, Math.max(0, ms.filteredRows.length - 1));
  }

  async function handleResumeModalInput(key) {
    const ms = tuiState.resumeModalState;
    if (!ms) return;

    const renameRequested = ms.mode === 'list'
      && key.ch && !key.ctrl && !key.meta
      && String(key.ch).toLowerCase() === 'r';
    const deleteRequested = (ms.mode !== 'rename' && ms.mode !== 'filter') && (
      key.name === 'delete'
      || (key.ch && !key.ctrl && !key.meta && ['d', 'x'].includes(String(key.ch).toLowerCase()))
    );
    const filterRequested = ms.mode === 'list' && key.ch === '/' && !key.ctrl && !key.meta;

    const markDirty = (flush = false) => {
      tuiState.dirty.add('all');
      if (flush) scheduler.flush();
      else scheduler.schedule();
    };

    const exitRenameMode = () => {
      ms.mode = 'list';
      ms.renameTargetId = null;
      ms.renameBuf = '';
      ms.renameCursor = 0;
      ms.confirmDeleteId = null;
    };

    const exitFilterMode = () => {
      ms.mode = 'list';
    };

    const visibleRows = Array.isArray(ms.filteredRows) ? ms.filteredRows : [];

    async function deleteResumeRow(row) {
      try {
        const deleted = await deleteSession(row.sessionId);
        if (deleted === 0) {
          ms.error = `Session not found: ${row.sessionId}`;
        } else {
          const displayName = row.sessionName ? `${JSON.stringify(row.sessionName)} (${row.sessionId})` : row.sessionId;
          addTranscriptEntry(tuiState, 'status', `Deleted session: ${displayName}`);
          const nextRows = await listSessions();
          ms.rows = nextRows;
          updateFilteredRows(ms);
          ms.cursor = Math.min(ms.cursor, Math.max(0, ms.filteredRows.length - 1));
          ms.error = null;
        }
      } catch (err) {
        ms.error = `Delete failed: ${formatError(err)}`;
      } finally {
        ms.confirmDeleteId = null;
        markDirty(true);
      }
    }

    async function saveRename() {
      const targetId = ms.renameTargetId;
      if (!targetId) {
        exitRenameMode();
        return;
      }

      const trimmed = ms.renameBuf.trim();
      try {
        if (targetId === state.sessionId) {
          if (trimmed) state.sessionName = trimmed;
          else delete state.sessionName;
          await appendSessionEvent(state, 'session_renamed', { name: trimmed || null });
          await saveSessionState(state);
        } else {
          const targetState = await loadSessionState(targetId);
          if (trimmed) targetState.sessionName = trimmed;
          else delete targetState.sessionName;
          await appendSessionEvent(targetState, 'session_renamed', { name: trimmed || null });
          await saveSessionState(targetState);
        }

        const nextRows = await listSessions();
        ms.rows = nextRows;
        updateFilteredRows(ms);
        const nextIndex = ms.filteredRows.findIndex((r) => r.item.sessionId === targetId);
        ms.cursor = nextIndex >= 0 ? nextIndex : Math.min(ms.cursor, Math.max(0, ms.filteredRows.length - 1));
        ms.error = null;
        exitRenameMode();

        if (trimmed) {
          addTranscriptEntry(tuiState, 'status', `Session renamed: ${JSON.stringify(trimmed)} (${targetId})`);
        } else {
          addTranscriptEntry(tuiState, 'status', `Session name cleared: ${targetId}`);
        }
      } catch (err) {
        ms.error = `Rename failed: ${formatError(err)}`;
      } finally {
        markDirty(true);
      }
    }

    if (key.name === 'escape') {
      if (ms.mode === 'rename') {
        exitRenameMode();
        ms.error = null;
        markDirty();
        return;
      }
      if (ms.mode === 'filter') {
        ms.filterBuf = '';
        updateFilteredRows(ms);
        exitFilterMode();
        ms.error = null;
        markDirty();
        return;
      }
      if (ms.confirmDeleteId) {
        ms.confirmDeleteId = null;
        ms.error = null;
        markDirty();
        return;
      }
      closeModal();
      return;
    }

    if (ms.mode === 'filter') {
      const edit = applySingleLineEditKey(ms.filterBuf, ms.filterCursor, key, { submitOnReturn: true });
      if (!edit.handled) return;
      if (edit.submitted) {
        exitFilterMode();
        markDirty();
        return;
      }
      ms.filterBuf = edit.text;
      ms.filterCursor = edit.cursor;
      if (edit.changed) updateFilteredRows(ms);
      markDirty();
      return;
    }

    if (visibleRows.length === 0 || ms.loading) {
      return;
    }

    if (ms.mode === 'rename') {
      const edit = applySingleLineEditKey(ms.renameBuf, ms.renameCursor, key, { submitOnReturn: true });
      if (!edit.handled) return;
      if (edit.submitted) {
        await saveRename();
        return;
      }
      ms.renameBuf = edit.text;
      ms.renameCursor = edit.cursor;
      markDirty();
      return;
    }

    const nav = getListNavigationAction(key);
    if (nav?.type === 'move') {
      ms.cursor = moveCursorCircular(ms.cursor, visibleRows.length, nav.delta);
      ms.confirmDeleteId = null;
      ms.error = null;
      await loadSessionPreview(ms);
      markDirty();
      return;
    }

    if (filterRequested) {
      ms.mode = 'filter';
      ms.filterCursor = ms.filterBuf.length;
      ms.confirmDeleteId = null;
      ms.error = null;
      markDirty();
      return;
    }

    if (nav?.type === 'select_index') {
      if (nav.index >= 0 && nav.index < visibleRows.length) {
        ms.confirmDeleteId = null;
        ms.error = null;
        await switchToSessionById(visibleRows[nav.index].item.sessionId, { closePicker: true });
      }
      return;
    }

    if (renameRequested) {
      const row = visibleRows[ms.cursor]?.item;
      if (!row) return;
      ms.mode = 'rename';
      ms.renameTargetId = row.sessionId;
      ms.renameBuf = row.sessionName || '';
      ms.renameCursor = ms.renameBuf.length;
      ms.confirmDeleteId = null;
      ms.error = null;
      markDirty();
      return;
    }

    if (deleteRequested) {
      const row = visibleRows[ms.cursor]?.item;
      if (!row) return;
      if (row.sessionId === state.sessionId) {
        ms.error = 'Cannot delete the currently active session.';
        ms.confirmDeleteId = null;
        markDirty();
        return;
      }
      if (ms.confirmDeleteId !== row.sessionId) {
        ms.confirmDeleteId = row.sessionId;
        ms.error = null;
        markDirty();
        return;
      }
      await deleteResumeRow(row);
      return;
    }

    if (nav?.type === 'confirm') {
      const row = visibleRows[ms.cursor]?.item;
      if (!row) return;
      if (ms.confirmDeleteId === row.sessionId) {
        await deleteResumeRow(row);
        return;
      }
      ms.error = null;
      await switchToSessionById(row.sessionId, { closePicker: true });
    }
  }

  async function startNewSession() {
    if (tuiState.runState !== 'idle') {
      addTranscriptEntry(tuiState, 'warning', 'Cannot start a new session while a run is active.');
      scheduler.flush();
      return;
    }

    const previousSessionId = state.sessionId;
    await ensureSessionPersisted(); // flush any unpersisted current session before switching
    await saveSessionState(state);
    state = await createFreshSessionState(state.provider, state.model, state.cwd);
    sessionPersisted = false; // new session starts lazy
    await refreshBranchLabel();
    resetTUIViewForSessionChange();

    addTranscriptEntry(
      tuiState,
      'status',
      `Started new session: ${state.sessionId} (from ${previousSessionId}) [${state.provider}/${state.model}]`,
    );
    tuiState.dirty.add('all');
    scheduler.flush();
  }

  async function switchModel(target, { closePicker = false } = {}) {
    if (!target) return;

    if (target === state.model) {
      addTranscriptEntry(tuiState, 'status', `Already using model: ${target}`);
      if (closePicker) {
        closeModelModal();
      } else {
        scheduler.flush();
      }
      return;
    }

    state.model = target;
    // Persist per-provider model default (matches classic REPL behavior).
    if (!config[ctx.providerConfig.id]) config[ctx.providerConfig.id] = {};
    config[ctx.providerConfig.id].model = target;
    await saveConfig(config);
    await saveSessionState(state);
    addTranscriptEntry(tuiState, 'status', `Model switched to: ${target}`);
    if (closePicker) {
      closeModelModal();
    } else {
      tuiState.dirty.add('all');
      scheduler.flush();
    }
  }

  function closeModelModal() {
    setActiveOverlayModal(null);
    tuiState.modelModalState = null;
    tuiState.dirty.add('all');
    scheduler.flush();
  }

  async function openModelPicker() {
    const providerId = ctx.providerConfig.id;
    const initialModels = getCuratedModels(providerId);
    const initialCursor = Math.max(0, initialModels.indexOf(state.model));

    setActiveOverlayModal('model');
    tuiState.modelModalState = {
      providerId,
      models: initialModels,
      cursor: initialCursor,
      loading: true,
      source: 'curated',
      error: '',
    };
    tuiState.dirty.add('all');
    scheduler.flush();

    const { models, source, error } = await fetchModels(ctx.providerConfig, ctx.apiKey);
    const ms = tuiState.modelModalState;
    if (!ms || getActiveOverlayModal() !== 'model' || ms.providerId !== providerId) return;

    ms.models = models;
    ms.source = source;
    ms.error = error || '';
    ms.loading = false;

    const currentIndex = models.indexOf(state.model);
    if (currentIndex >= 0) {
      ms.cursor = currentIndex;
    } else if (ms.cursor >= models.length) {
      ms.cursor = Math.max(0, models.length - 1);
    }

    tuiState.dirty.add('all');
    scheduler.flush();
  }

  async function selectModelFromPicker(index) {
    const ms = tuiState.modelModalState;
    if (!ms || index < 0 || index >= ms.models.length) return;
    await switchModel(ms.models[index], { closePicker: true });
  }

  async function handleModelModalInput(key) {
    const ms = tuiState.modelModalState;
    if (!ms) return;
    const action = getListNavigationAction(key);
    if (!action) return;
    if (action.type === 'cancel') {
      closeModelModal();
      return;
    }
    if (action.type === 'move') {
      if (ms.models.length > 0) {
        ms.cursor = moveCursorCircular(ms.cursor, ms.models.length, action.delta);
      }
      tuiState.dirty.add('all');
      scheduler.schedule();
      return;
    }
    if (action.type === 'select_index') {
      await selectModelFromPicker(action.index);
      return;
    }
    if (action.type === 'confirm') {
      await selectModelFromPicker(ms.cursor);
    }
  }

  /** Handle /model [name|#] command. */
  async function handleModelCommand(arg) {
    if (!arg) {
      await openModelPicker();
      return;
    }

    // Switching: need the model list for numeric resolution
    const { models } = await fetchModels(ctx.providerConfig, ctx.apiKey);

    // Resolve by number or name
    let target;
    if (/^\d+$/.test(arg)) {
      const num = parseInt(arg, 10);
      if (num < 1 || num > models.length) {
        addTranscriptEntry(tuiState, 'error', `Model index out of range: ${num}`);
        scheduler.flush();
        return;
      }
      target = models[num - 1];
    } else {
      target = arg;
    }

    await switchModel(target);
  }

  /** Handle /provider [name|#] command. */
  async function handleProviderCommand(arg) {
    const providers = getProviderList();

    if (!arg) {
      openProviderSwitcher();
      return;
    }

    // Resolve by number or name
    let target;
    if (/^\d+$/.test(arg)) {
      const num = parseInt(arg, 10);
      target = (num >= 1 && num <= providers.length) ? providers[num - 1] : null;
    } else {
      target = providers.find(p => p.id === arg.toLowerCase());
    }

    if (!target) {
      addTranscriptEntry(tuiState, 'error', `Unknown provider: ${arg}`);
      scheduler.flush();
      return;
    }

    await switchProvider(providers.indexOf(target));
  }

  /** Handle /config [subcommand] [args]. */
  async function handleConfigCommand(arg) {
    if (!arg) {
      openConfigModal();
      return;
    }

    const parts = arg.split(/\s+/);
    const sub = parts[0];

    if (sub === 'key') {
      if (parts.length < 2) {
        addTranscriptEntry(tuiState, 'warning', 'Usage: /config key <secret> or /config key <provider> <secret>');
        scheduler.flush();
        return;
      }

      let targetId, secret;
      if (parts.length === 2) {
        // /config key <secret> — set for current provider
        targetId = ctx.providerConfig.id;
        secret = parts[1];
      } else {
        // /config key <provider> <secret>
        targetId = parts[1].toLowerCase();
        secret = parts[2];
      }

      if (!PROVIDER_CONFIGS[targetId]) {
        addTranscriptEntry(tuiState, 'error', `Unknown provider: ${targetId}`);
        scheduler.flush();
        return;
      }

      // Persist to config
      if (!config[targetId]) config[targetId] = {};
      config[targetId].apiKey = secret;
      await saveConfig(config);

      // Set env var so resolveApiKey() picks it up
      const envKey = `PUSH_${targetId.toUpperCase()}_API_KEY`;
      process.env[envKey] = secret;

      // Hot-reload running session if setting for current provider
      if (targetId === ctx.providerConfig.id) {
        ctx.apiKey = secret;
      }

      addTranscriptEntry(tuiState, 'status', `API key saved for ${targetId} (${maskSecret(secret)})`);
      scheduler.flush();
      return;
    }

    if (sub === 'url') {
      if (parts.length < 2) {
        addTranscriptEntry(tuiState, 'warning', 'Usage: /config url <url>');
        scheduler.flush();
        return;
      }

      const url = parts[1];
      const targetId = ctx.providerConfig.id;

      if (!config[targetId]) config[targetId] = {};
      config[targetId].url = url;
      await saveConfig(config);

      const envKey = `PUSH_${targetId.toUpperCase()}_URL`;
      process.env[envKey] = url;

      addTranscriptEntry(tuiState, 'status', `Endpoint URL saved for ${targetId}: ${url}`);
      scheduler.flush();
      return;
    }

    if (sub === 'tavily') {
      if (parts.length < 2) {
        addTranscriptEntry(tuiState, 'warning', 'Usage: /config tavily <secret>');
        scheduler.flush();
        return;
      }

      const secret = parts[1];
      config.tavilyApiKey = secret;
      await saveConfig(config);
      process.env.PUSH_TAVILY_API_KEY = secret;

      addTranscriptEntry(tuiState, 'status', `Tavily API key saved (${maskSecret(secret)})`);
      scheduler.flush();
      return;
    }

    if (sub === 'sandbox') {
      if (parts.length < 2 || (parts[1] !== 'on' && parts[1] !== 'off')) {
        addTranscriptEntry(tuiState, 'warning', 'Usage: /config sandbox on|off');
        scheduler.flush();
        return;
      }

      const enabled = parts[1] === 'on';
      config.localSandbox = enabled;
      await saveConfig(config);
      process.env.PUSH_LOCAL_SANDBOX = String(enabled);

      addTranscriptEntry(tuiState, 'status', `Local sandbox: ${enabled ? 'on' : 'off'}`);
      scheduler.flush();
      return;
    }

    if (sub === 'explain') {
      if (parts.length < 2 || (parts[1] !== 'on' && parts[1] !== 'off')) {
        addTranscriptEntry(tuiState, 'warning', 'Usage: /config explain on|off');
        scheduler.flush();
        return;
      }

      const enabled = parts[1] === 'on';
      config.explainMode = enabled;
      await saveConfig(config);
      process.env.PUSH_EXPLAIN_MODE = String(enabled);
      await refreshSystemPromptForConfigChange();

      addTranscriptEntry(tuiState, 'status', `Explain mode: ${enabled ? 'on' : 'off'}`);
      scheduler.flush();
      return;
    }

    addTranscriptEntry(tuiState, 'warning', `Unknown config subcommand: ${sub}. Try: key, url, tavily, sandbox, explain`);
    scheduler.flush();
  }

  /** Dispatch slash commands. Returns true if handled. */
  async function handleSlashCommand(text) {
    if (!text.startsWith('/')) return false;

    const spaceIdx = text.indexOf(' ');
    const cmd = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx);
    const arg = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

    switch (cmd) {
      case 'exit':
      case 'quit':
        exitResolve();
        return true;

      case 'config':
        await handleConfigCommand(arg || null);
        return true;

      case 'help':
        addTranscriptEntry(tuiState, 'status', [
          'Commands:',
          '  /new                 Start a new session (same provider/model/cwd)',
          '  /model               Open navigable model picker',
          '  /model <name|#>      Switch model',
          '  /provider            Open navigable provider picker',
          '  /provider <name|#>   Switch provider',
          '  /config              Show config overview (keys masked)',
          '  /config key <secret> Set API key for current provider',
          '  /config url <url>    Set endpoint URL for current provider',
          '  /config tavily <key> Set Tavily web search API key',
          '  /config sandbox on|off  Toggle local Docker sandbox',
          '  /config explain on|off  Toggle pattern explanations',
          '  /skills              List available skills',
          '  /skills reload       Reload workspace + Claude skills',
          `  /compact [turns]      Compact older context (default keep ${DEFAULT_COMPACT_TURNS} turns)`,
          '  /<skill> [args]      Run a skill (e.g. /commit, /review)',
          '  /resume              Open resumable session picker',
          '  /resume <session-id> Switch to a saved session',
          '  @path[:line[-end]]   Preload file refs into context',
          '  /session             Print session id',
          '  /session rename <name>  Rename current session (--clear to unset)',
          '  /exit                Exit TUI',
          '',
          'Keybinds:',
          '  Enter         Send message',
          '  Alt+Enter     New line in composer',
          '  Up/Down       Input history (single-line)',
          '  Ctrl+A/E      Start/end of line',
          '  Ctrl+U        Kill to line start',
          '  Ctrl+K        Kill to line end',
          '  Ctrl+W        Kill word backward',
          '  Ctrl+D        Delete forward / exit when empty',
          '  Ctrl+Left/Right  Word navigation',
          '  PageUp/Down   Scroll transcript',
          '  Ctrl+L        Clear viewport (preserves history)',
          '  Ctrl+T        Toggle tool pane',
          '  Ctrl+O        Payload inspector mode (per-block expand/collapse)',
          '  Ctrl+G        Toggle reasoning pane',
          '  Ctrl+C        Cancel run / exit',
          '  Ctrl+Y        Approve',
          '  Ctrl+N        Deny',
          '  Ctrl+P        Provider switcher',
          '  Payload inspector: j/k or arrows move, Enter toggles block, a toggles all',
        ].join('\n'));
        scheduler.flush();
        return true;

      case 'new':
        await startNewSession();
        return true;

      case 'session':
        if (!arg) {
          const nameSuffix = state.sessionName ? ` (${JSON.stringify(state.sessionName)})` : '';
          addTranscriptEntry(tuiState, 'status', `session: ${state.sessionId}${nameSuffix}`);
          scheduler.flush();
          return true;
        }
        if (arg === 'rename' || arg.startsWith('rename ')) {
          await renameCurrentSession(arg.slice('rename'.length));
          return true;
        }
        addTranscriptEntry(tuiState, 'warning', 'Usage: /session | /session rename <name> | /session rename --clear');
        scheduler.flush();
        return true;

      case 'resume':
        if (!arg) {
          await openResumeModal();
          return true;
        }
        if (!/^sess_[a-z0-9]+_[a-f0-9]{6}$/.test(arg)) {
          addTranscriptEntry(tuiState, 'warning', 'Usage: /resume | /resume <session-id>');
          scheduler.flush();
          return true;
        }
        await switchToSessionById(arg, { closePicker: false });
        return true;

      case 'model':
        await handleModelCommand(arg || null);
        return true;

      case 'provider':
        await handleProviderCommand(arg || null);
        return true;

      case 'skills':
        if (arg === 'reload') {
          const count = await reloadSkillsMap();
          addTranscriptEntry(tuiState, 'status', `Reloaded skills: ${count}`);
          scheduler.flush();
          return true;
        }
        if (arg) {
          addTranscriptEntry(tuiState, 'warning', 'Usage: /skills | /skills reload');
          scheduler.flush();
          return true;
        }
        if (skills.size === 0) {
          addTranscriptEntry(tuiState, 'status', 'No skills loaded.');
        } else {
          const lines = [];
          for (const [name, skill] of skills) {
            const tag = skill.source === 'workspace'
              ? ' (workspace)'
              : skill.source === 'claude'
                ? ' (claude)'
                : '';
            lines.push(`  /${name}  ${skill.description}${tag}`);
          }
          addTranscriptEntry(tuiState, 'status', lines.join('\n'));
        }
        scheduler.flush();
        return true;

      case 'compact':
        await compactSessionContext(arg || null);
        return true;

      default: {
        // Check if it's a skill name
        const skill = skills.get(cmd);
        if (skill) {
          const promptTemplate = await getSkillPromptTemplate(skill);
          const prompt = interpolateSkill(promptTemplate, arg);
          if (tuiState.transcript.length > 0) {
            pushTranscriptEntry(tuiState, { role: 'divider', timestamp: Date.now() });
          }
          addTranscriptEntry(tuiState, 'user', text);
          composer.clear();
          tuiState.dirty.add('all');
          await ensureSessionPersisted();
          await appendSessionEvent(state, 'user_message', { chars: prompt.length, preview: prompt.slice(0, 280), skill: cmd });
          await runPrompt(prompt, { referenceSourceText: arg });
          return true;
        }

        addTranscriptEntry(tuiState, 'warning', `Unknown command: /${cmd}. Type /help for commands.`);
        scheduler.flush();
        return true;
      }
    }
  }

  async function sendMessage() {
    const text = composer.getText().trim();
    if (!text || tuiState.runState !== 'idle') return;

    inputHistory.push(text);
    inputHistory.reset();

    // Slash command dispatch
    if (text.startsWith('/')) {
      composer.clear();
      tuiState.dirty.add('composer');
      const handled = await handleSlashCommand(text);
      if (handled) return;
    }

    if (tuiState.transcript.length > 0) {
      pushTranscriptEntry(tuiState, { role: 'divider', timestamp: Date.now() });
    }
    addTranscriptEntry(tuiState, 'user', text);
    composer.clear();
    tuiState.dirty.add('all');
    await runPrompt(text);
  }

  function cancelRun() {
    if (runAbort) {
      runAbort.abort();
      addTranscriptEntry(tuiState, 'status', 'Run cancelled.');
    }
  }

  function approveAction() {
    if (approvalResolve) {
      if (tuiState.approval) {
        pushTranscriptEntry(tuiState, { role: 'verdict', verdict: 'APPROVED', kind: tuiState.approval.kind, summary: tuiState.approval.summary, timestamp: Date.now() });
      }
      approvalResolve(true);
      approvalResolve = null;
      tuiState.approval = null;
      tuiState.runState = 'running';
      tuiState.dirty.add('all');
      scheduler.schedule();
    }
  }

  function alwaysApproveAction() {
    if (approvalResolve) {
      const patIdx = tuiState.approval?.patternIndex;
      if (typeof patIdx === 'number' && patIdx >= 0) {
        trustedPatterns.add(patIdx);
      }
      if (tuiState.approval) {
        pushTranscriptEntry(tuiState, { role: 'verdict', verdict: 'APPROVED', kind: tuiState.approval.kind, summary: tuiState.approval.summary, trusted: true, timestamp: Date.now() });
      }
      approvalResolve(true);
      approvalResolve = null;
      tuiState.approval = null;
      tuiState.runState = 'running';
      tuiState.dirty.add('all');
      scheduler.schedule();
    }
  }

  function denyAction() {
    if (approvalResolve) {
      if (tuiState.approval) {
        pushTranscriptEntry(tuiState, { role: 'verdict', verdict: 'DENIED', kind: tuiState.approval.kind, summary: tuiState.approval.summary, timestamp: Date.now() });
      }
      approvalResolve(false);
      approvalResolve = null;
      tuiState.approval = null;
      tuiState.runState = 'running';
      tuiState.dirty.add('all');
      scheduler.schedule();
    }
  }

  /** Dedicated input handler for the approval modal — bare keys, no keybind map. */
  function handleApprovalModalInput(key) {
    if (key.name === 'y' && !key.ctrl && !key.meta) {
      approveAction();
      return;
    }
    if (key.name === 'a' && !key.ctrl && !key.meta) {
      alwaysApproveAction();
      return;
    }
    if (key.name === 'n' && !key.ctrl && !key.meta) {
      denyAction();
      return;
    }
    if (key.name === 'escape') {
      denyAction();
      return;
    }
    // Ctrl+Y and Ctrl+N still work (from keybind map fallthrough)
    if (key.ctrl && key.name === 'y') {
      approveAction();
      return;
    }
    if (key.ctrl && key.name === 'n') {
      denyAction();
      return;
    }
  }

  function toggleTools() {
    tuiState.toolPaneOpen = !tuiState.toolPaneOpen;
    tuiState.dirty.add('all');
    scheduler.flush();
  }

  // Overlay modals are mutually exclusive (approval/question are separate run states).
  // Centralizing the open/close logic keeps the boolean fields in sync while we
  // migrate toward a stricter modal state machine.
  function getActiveOverlayModal() {
    if (tuiState.configModalOpen) return 'config';
    if (tuiState.reasoningModalOpen) return 'reasoning';
    if (tuiState.payloadInspectorOpen) return 'payload_inspector';
    if (tuiState.modelModalOpen) return 'model';
    if (tuiState.providerModalOpen) return 'provider';
    if (tuiState.resumeModalOpen) return 'resume';
    return null;
  }

  function setActiveOverlayModal(modalName) {
    tuiState.configModalOpen = modalName === 'config';
    tuiState.reasoningModalOpen = modalName === 'reasoning';
    tuiState.payloadInspectorOpen = modalName === 'payload_inspector';
    tuiState.modelModalOpen = modalName === 'model';
    tuiState.providerModalOpen = modalName === 'provider';
    tuiState.resumeModalOpen = modalName === 'resume';
  }

  function getVisiblePayloadBlocks() {
    return Array.isArray(tuiState.payloadBlocks)
      ? tuiState.payloadBlocks.filter((b) => b.visible)
      : [];
  }

  function openPayloadInspector() {
    const visibleBlocks = getVisiblePayloadBlocks();
    const fallback = visibleBlocks[visibleBlocks.length - 1]
      || tuiState.payloadBlocks[tuiState.payloadBlocks.length - 1]
      || null;
    if (!fallback) {
      process.stdout.write('\x07');
      return;
    }
    setActiveOverlayModal('payload_inspector');
    const cursorExists = tuiState.payloadCursorId && tuiState.payloadBlocks.some((b) => b.id === tuiState.payloadCursorId);
    if (!cursorExists) {
      tuiState.payloadCursorId = fallback.id;
    }
    tuiState.dirty.add('all');
    scheduler.flush();
  }

  function closePayloadInspector() {
    setActiveOverlayModal(null);
    tuiState.dirty.add('all');
    scheduler.flush();
  }

  function toggleToolJsonPayloads() {
    if (!tuiState.payloadInspectorOpen) {
      openPayloadInspector();
      return;
    }
    closePayloadInspector();
  }

  function movePayloadCursor(delta) {
    const visibleBlocks = getVisiblePayloadBlocks();
    if (visibleBlocks.length === 0) return;
    const currentIdx = visibleBlocks.findIndex((b) => b.id === tuiState.payloadCursorId);
    const nextIdx = currentIdx >= 0
      ? (currentIdx + delta + visibleBlocks.length) % visibleBlocks.length
      : (delta >= 0 ? 0 : visibleBlocks.length - 1);
    tuiState.payloadCursorId = visibleBlocks[nextIdx].id;
    tuiState.dirty.add('transcript');
    scheduler.schedule();
  }

  function toggleFocusedPayloadBlock() {
    const visibleBlocks = getVisiblePayloadBlocks();
    const block = visibleBlocks.find((b) => b.id === tuiState.payloadCursorId)
      || visibleBlocks[0]
      || null;
    if (!block) return;
    tuiState.payloadCursorId = block.id;
    if (tuiState.expandedToolJsonPayloadIds.has(block.id)) {
      tuiState.expandedToolJsonPayloadIds.delete(block.id);
    } else {
      tuiState.expandedToolJsonPayloadIds.add(block.id);
    }
    tuiState.dirty.add('transcript');
    scheduler.flush();
  }

  function toggleAllToolJsonPayloads() {
    tuiState.toolJsonPayloadsExpanded = !tuiState.toolJsonPayloadsExpanded;
    tuiState.dirty.add('all');
    scheduler.flush();
  }

  function toggleReasoningModal() {
    setActiveOverlayModal(tuiState.reasoningModalOpen ? null : 'reasoning');
    tuiState.dirty.add('all');
    scheduler.flush();
  }

  function handleReasoningModalInput(key) {
    if (key.name === 'escape' || (key.ctrl && key.name === 'g')) {
      toggleReasoningModal();
    }
  }

  function handlePayloadInspectorInput(key) {
    if (key.name === 'escape' || (key.ctrl && key.name === 'o')) {
      closePayloadInspector();
      return;
    }
    if (key.ctrl && key.name === 'c') {
      if (tuiState.runState === 'running') {
        cancelRun();
      } else {
        exitResolve();
      }
      return;
    }
    if (key.ctrl && key.name === 'l') {
      clearViewport();
      return;
    }
    if (key.name === 'up' || (!key.ctrl && !key.meta && key.name === 'k')) {
      movePayloadCursor(-1);
      return;
    }
    if (key.name === 'down' || (!key.ctrl && !key.meta && key.name === 'j')) {
      movePayloadCursor(1);
      return;
    }
    if (key.name === 'return' || key.name === 'enter' || key.ch === ' ') {
      toggleFocusedPayloadBlock();
      return;
    }
    if (!key.ctrl && !key.meta && key.name === 'a') {
      toggleAllToolJsonPayloads();
      return;
    }
    if (key.name === 'pageup') {
      const { rows } = getTermSize();
      tuiState.scrollOffset += Math.max(1, Math.floor(rows / 3));
      tuiState.dirty.add('transcript');
      scheduler.schedule();
      return;
    }
    if (key.name === 'pagedown') {
      const { rows } = getTermSize();
      tuiState.scrollOffset = Math.max(0, tuiState.scrollOffset - Math.max(1, Math.floor(rows / 3)));
      tuiState.dirty.add('transcript');
      scheduler.schedule();
    }
  }

  function clearViewport() {
    process.stdout.write(ESC.clearScreen);
    tuiState.dirty.add('all');
    scheduler.flush();
  }

  function openProviderSwitcher() {
    const providers = getProviderList();
    const currentIndex = providers.findIndex((p) => p.id === state.provider);
    tuiState.providerModalCursor = currentIndex >= 0 ? currentIndex : 0;
    setActiveOverlayModal('provider');
    tuiState.dirty.add('all');
    scheduler.flush();
  }

  function closeModal() {
    const activeOverlay = getActiveOverlayModal();
    if (activeOverlay === 'config') {
      closeConfigModal();
      return;
    }
    if (activeOverlay === 'reasoning') {
      setActiveOverlayModal(null);
      tuiState.dirty.add('all');
      scheduler.flush();
      return;
    }
    if (activeOverlay === 'payload_inspector') {
      closePayloadInspector();
      return;
    }
    if (activeOverlay === 'model') {
      closeModelModal();
      return;
    }
    if (activeOverlay === 'provider') {
      setActiveOverlayModal(null);
      tuiState.providerModalCursor = 0;
      tuiState.dirty.add('all');
      scheduler.flush();
      return;
    }
    if (activeOverlay === 'resume') {
      setActiveOverlayModal(null);
      tuiState.resumeModalState = null;
      tuiState.dirty.add('all');
      scheduler.flush();
      return;
    }
    if (tuiState.runState === 'awaiting_approval' && approvalResolve) {
      // Esc on approval = deny
      denyAction();
    }
  }

  async function switchProvider(index) {
    const providers = getProviderList();
    if (index < 0 || index >= providers.length) return;
    const target = providers[index];
    let newApiKey;
    try {
      newApiKey = resolveApiKey(PROVIDER_CONFIGS[target.id]);
    } catch {
      addTranscriptEntry(tuiState, 'error', `Cannot switch to ${target.id}: no API key.`);
      return;
    }

    const newConfig = PROVIDER_CONFIGS[target.id];

    ctx.providerConfig = newConfig;
    ctx.apiKey = newApiKey;
    state.provider = target.id;
    state.model = config[target.id]?.model || newConfig.defaultModel;

    // Persist current default provider (matches classic REPL behavior).
    config.provider = target.id;
    await saveConfig(config);
    await saveSessionState(state);
    addTranscriptEntry(tuiState, 'status', `Switched to ${target.id} | model: ${state.model}`);
    setActiveOverlayModal(null);
    tuiState.providerModalCursor = index;
    tuiState.modelModalState = null;
    tuiState.dirty.add('all');
    scheduler.flush();
  }

  async function handleProviderModalInput(key) {
    const providers = getProviderList();
    if (providers.length === 0) return;
    const action = getListNavigationAction(key);
    if (!action) return;
    if (action.type === 'cancel') {
      closeModal();
      return;
    }
    if (action.type === 'move') {
      tuiState.providerModalCursor = moveCursorCircular(tuiState.providerModalCursor, providers.length, action.delta);
      tuiState.dirty.add('all');
      scheduler.schedule();
      return;
    }
    if (action.type === 'select_index') {
      if (action.index >= 0 && action.index < providers.length) {
        await switchProvider(action.index);
      }
      return;
    }
    if (action.type === 'confirm') {
      await switchProvider(tuiState.providerModalCursor);
    }
  }

  // ── Config modal lifecycle ────────────────────────────────────────

  function openConfigModal() {
    setActiveOverlayModal('config');
    tuiState.configModalState = { mode: 'list', cursor: 0, editTarget: '', editBuf: '', editCursor: 0, pickCursor: 0 };
    tuiState.dirty.add('all');
    scheduler.flush();
  }

  function closeConfigModal() {
    setActiveOverlayModal(null);
    tuiState.configModalState = null;
    tuiState.dirty.add('all');
    scheduler.flush();
  }

  function getConfigItemCount() {
    return getProviderList().length + 4;
  }

  async function handleConfigModalInput(key) {
    const ms = tuiState.configModalState;
    if (!ms) return;

    if (ms.mode === 'list') {
      const action = getListNavigationAction(key);
      if (!action) return;
      if (action.type === 'cancel') {
        closeConfigModal();
        return;
      }
      if (action.type === 'move') {
        ms.cursor = moveCursorCircular(ms.cursor, getConfigItemCount(), action.delta);
        tuiState.dirty.add('all');
        scheduler.schedule();
        return;
      }
      if (action.type === 'select_index') {
        ms.cursor = action.index;
        await activateConfigItem(ms.cursor);
        return;
      }
      if (action.type === 'confirm') {
        await activateConfigItem(ms.cursor);
        return;
      }
      return;
    }

    if (ms.mode === 'edit') {
      const edit = applySingleLineEditKey(ms.editBuf, ms.editCursor, key, {
        submitOnReturn: true,
        cancelOnEscape: true,
      });
      if (!edit.handled) return;

      if (edit.canceled) {
        ms.mode = 'list';
        ms.editBuf = '';
        ms.editCursor = 0;
        tuiState.dirty.add('all');
        scheduler.schedule();
        return;
      }

      if (edit.submitted) {
        if (ms.editBuf) {
          await saveConfigKey(ms.editTarget, ms.editBuf);
        }
        ms.mode = 'list';
        ms.editBuf = '';
        ms.editCursor = 0;
        tuiState.dirty.add('all');
        scheduler.flush();
        return;
      }

      ms.editBuf = edit.text;
      ms.editCursor = edit.cursor;
      tuiState.dirty.add('all');
      scheduler.schedule();
      return;
    }

    if (ms.mode === 'pick') {
      // ── Pick mode input (exec mode selection) ──
      const EXEC_MODES = ['strict', 'auto', 'yolo'];
      const action = getListNavigationAction(key, { allowNumbers: false });
      if (!action) return;
      if (action.type === 'cancel') {
        ms.mode = 'list';
        tuiState.dirty.add('all');
        scheduler.schedule();
        return;
      }
      if (action.type === 'move') {
        ms.pickCursor = moveCursorCircular(ms.pickCursor, EXEC_MODES.length, action.delta);
        tuiState.dirty.add('all');
        scheduler.schedule();
        return;
      }
      if (action.type === 'confirm') {
        const chosen = EXEC_MODES[ms.pickCursor];
        config.execMode = chosen;
        await saveConfig(config);
        process.env.PUSH_EXEC_MODE = chosen;
        ms.mode = 'list';
        tuiState.dirty.add('all');
        scheduler.flush();
        return;
      }
      return;
    }
  }

  async function activateConfigItem(index) {
    const ms = tuiState.configModalState;
    const providers = getProviderList();
    if (index < providers.length) {
      // Provider → enter edit mode
      ms.mode = 'edit';
      ms.editTarget = providers[index].id;
      ms.editBuf = '';
      ms.editCursor = 0;
    } else if (index === providers.length) {
      // Tavily → enter edit mode
      ms.mode = 'edit';
      ms.editTarget = 'tavily';
      ms.editBuf = '';
      ms.editCursor = 0;
    } else if (index === providers.length + 1) {
      // Sandbox → toggle directly
      const current = process.env.PUSH_LOCAL_SANDBOX || (config.localSandbox !== undefined ? String(config.localSandbox) : 'off');
      const isOn = current === 'true' || current === '1';
      config.localSandbox = !isOn;
      await saveConfig(config);
      process.env.PUSH_LOCAL_SANDBOX = String(!isOn);
    } else if (index === providers.length + 2) {
      // ExecMode → enter pick mode
      const EXEC_MODES = ['strict', 'auto', 'yolo'];
      const current = process.env.PUSH_EXEC_MODE || config.execMode || 'auto';
      ms.mode = 'pick';
      ms.pickCursor = Math.max(0, EXEC_MODES.indexOf(current));
    } else if (index === providers.length + 3) {
      // ExplainMode → toggle directly
      const isOn = process.env.PUSH_EXPLAIN_MODE === 'true' || config.explainMode === true;
      config.explainMode = !isOn;
      await saveConfig(config);
      process.env.PUSH_EXPLAIN_MODE = String(!isOn);
      await refreshSystemPromptForConfigChange();
    }
    tuiState.dirty.add('all');
    scheduler.flush();
  }

  async function saveConfigKey(targetId, secret) {
    if (targetId === 'tavily') {
      config.tavilyApiKey = secret;
      await saveConfig(config);
      process.env.PUSH_TAVILY_API_KEY = secret;
      return;
    }

    // Provider API key
    if (!PROVIDER_CONFIGS[targetId]) return;
    if (!config[targetId]) config[targetId] = {};
    config[targetId].apiKey = secret;
    await saveConfig(config);

    const envKey = `PUSH_${targetId.toUpperCase()}_API_KEY`;
    process.env[envKey] = secret;

    // Hot-reload running session if setting for current provider
    if (targetId === ctx.providerConfig.id) {
      ctx.apiKey = secret;
    }
  }

  // ── Exit promise ─────────────────────────────────────────────────

  let exitResolve;
  const exitPromise = new Promise((resolve) => { exitResolve = resolve; });

  // ── Bracketed paste state ────────────────────────────────────────

  const PASTE_START = '\x1b[200~';
  const PASTE_END   = '\x1b[201~';
  let pasteMode = false;
  let pasteBuf = '';

  // Stream-safe decoding: StringDecoder holds incomplete UTF-8 byte
  // sequences across data events (prevents replacement characters for
  // CJK/emoji split across chunks). pendingInput holds character strings
  // that might be partial paste markers at chunk boundaries.
  const utf8Decoder = new StringDecoder('utf8');
  let pendingInput = '';

  /**
   * Check if str ends with a proper prefix of marker.
   * Returns the length of the matching suffix, or 0.
   */
  function partialMarkerSuffix(str, marker) {
    const maxLen = Math.min(str.length, marker.length - 1);
    for (let len = maxLen; len >= 1; len--) {
      if (str.endsWith(marker.slice(0, len))) {
        return len;
      }
    }
    return 0;
  }

  function insertPastedText(text) {
    if (!text) return;

    // Config edit mode is a single-line secret input; paste should target the
    // modal buffer instead of the main composer, and newlines should be dropped.
    if (getActiveOverlayModal() === 'config' && tuiState.configModalState?.mode === 'edit') {
      const ms = tuiState.configModalState;
      const normalized = text.replace(/\r\n/g, '\n').replace(/[\r\n]/g, '');
      if (!normalized) return;
      ms.editBuf = ms.editBuf.slice(0, ms.editCursor) + normalized + ms.editBuf.slice(ms.editCursor);
      ms.editCursor += normalized.length;
      tuiState.dirty.add('all');
      scheduler.schedule();
      return;
    }

    // Resume modal rename mode is also a single-line text input.
    if (getActiveOverlayModal() === 'resume' && tuiState.resumeModalState?.mode === 'rename') {
      const ms = tuiState.resumeModalState;
      const normalized = text.replace(/\r\n/g, '\n').replace(/[\r\n]/g, '');
      if (!normalized) return;
      ms.renameBuf = ms.renameBuf.slice(0, ms.renameCursor) + normalized + ms.renameBuf.slice(ms.renameCursor);
      ms.renameCursor += normalized.length;
      tuiState.dirty.add('all');
      scheduler.schedule();
      return;
    }

    // For non-text modals, ignore paste rather than mutating the hidden composer.
    if (getActiveOverlayModal() || (tuiState.runState === 'awaiting_approval' && tuiState.approval)) {
      return;
    }

    tabCompleter.reset();
    composer.insertText(text);
    tuiState.dirty.add('composer');
    scheduler.schedule();
  }

  // ── Input handler ────────────────────────────────────────────────

  function onData(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const decoded = utf8Decoder.write(buf);
    if (!decoded) return; // Incomplete UTF-8 sequence, wait for more bytes
    const str = pendingInput + decoded;
    pendingInput = '';
    processInput(str);
  }

  function processInput(str) {
    // ── Bracketed paste handling (before parseKey) ──
    if (pasteMode) {
      const endIdx = str.indexOf(PASTE_END);
      if (endIdx === -1) {
        // No end marker found. Hold a potential partial marker at the tail
        // so we can match it if the rest arrives in the next chunk.
        const held = partialMarkerSuffix(str, PASTE_END);
        if (held > 0) {
          pasteBuf += str.slice(0, -held);
          pendingInput = str.slice(-held);
        } else {
          pasteBuf += str;
        }
        return;
      }
      // End of paste
      pasteBuf += str.slice(0, endIdx);
      insertPastedText(pasteBuf);
      pasteBuf = '';
      pasteMode = false;
      // Process any data after the paste end marker
      const after = str.slice(endIdx + PASTE_END.length);
      if (after.length > 0) processInput(after);
      return;
    }

    // Check for paste start marker (may appear mid-chunk)
    const startIdx = str.indexOf(PASTE_START);
    if (startIdx !== -1) {
      // Process data before paste marker
      const before = str.slice(0, startIdx);
      if (before.length > 0) processInput(before);
      // Enter paste mode
      pasteMode = true;
      pasteBuf = '';
      // Process data after paste start marker (may contain paste end too)
      const after = str.slice(startIdx + PASTE_START.length);
      if (after.length > 0) processInput(after);
      return;
    }

    // Normal key input
    // Some automation layers (e.g. terminal-mcp `type`) write multiple printable
    // characters in a single stdin chunk. `parseKey()` parses one key sequence, so
    // split safe non-escape chunks into per-character events here.
    const splitChunks = splitRawInputChunk(str);
    if (splitChunks.length > 1) {
      for (const ch of splitChunks) processInput(ch);
      return;
    }

    const keyBuf = Buffer.from(str);
    const key = parseKey(keyBuf);

    // Approval modal: dedicated handler with bare y/a/n keys
    if (tuiState.runState === 'awaiting_approval' && tuiState.approval) {
      handleApprovalModalInput(key);
      return;
    }

    // Ask-user modal: captures typed text
    if (tuiState.runState === 'awaiting_user_question' && tuiState.userQuestion) {
      handleQuestionInput(key);
      return;
    }

    // UI overlay modal router
    switch (getActiveOverlayModal()) {
      case 'config':
        runAsync(() => handleConfigModalInput(key), 'config input failed');
        return;
      case 'reasoning':
        handleReasoningModalInput(key);
        return;
      case 'payload_inspector':
        handlePayloadInspectorInput(key);
        return;
      case 'model':
        runAsync(() => handleModelModalInput(key), 'model picker input failed');
        return;
      case 'provider':
        runAsync(() => handleProviderModalInput(key), 'provider switch failed');
        return;
      case 'resume':
        runAsync(() => handleResumeModalInput(key), 'resume picker input failed');
        return;
      default:
        break;
    }

    // Tab completion — intercept before keybind map
    if (key.name === 'tab' && tuiState.runState === 'idle') {
      const result = tabCompleter.tab(composer.getText(), key.shift);
      if (result) {
        composer.setText(result.text);
        tuiState.dirty.add('composer');
        scheduler.schedule();
      }
      return;
    }

    // Reset tab completion on any non-Tab keystroke
    if (key.name !== 'tab') {
      tabCompleter.reset();
    }

    // Check keybinds
    const action = keybinds.lookup(key);

    switch (action) {
      case 'send':
        runAsync(() => sendMessage(), 'send failed');
        return;
      case 'newline':
        composer.insertNewline();
        tuiState.dirty.add('composer');
        scheduler.schedule();
        return;
      case 'cancel_or_exit':
        if (tuiState.runState === 'running') {
          cancelRun();
        } else {
          exitResolve();
        }
        return;
      case 'toggle_tools':
        toggleTools();
        return;
      case 'toggle_tool_json_payloads':
        toggleToolJsonPayloads();
        return;
      case 'toggle_reasoning':
        toggleReasoningModal();
        return;
      case 'clear_viewport':
        clearViewport();
        return;
      case 'reattach':
        // Phase 1: no-op placeholder for Ctrl+R
        addTranscriptEntry(tuiState, 'status', 'Re-attach not yet implemented.');
        scheduler.schedule();
        return;
      case 'approve':
        approveAction();
        return;
      case 'deny':
        denyAction();
        return;
      case 'provider_switcher':
        openProviderSwitcher();
        return;
      case 'close_modal':
        closeModal();
        return;
      case 'line_start':
        composer.moveHome();
        tuiState.dirty.add('composer');
        scheduler.schedule();
        return;
      case 'line_end':
        composer.moveEnd();
        tuiState.dirty.add('composer');
        scheduler.schedule();
        return;
      case 'kill_line_backward':
        composer.killLineBackward();
        tuiState.dirty.add('composer');
        scheduler.schedule();
        return;
      case 'kill_line_forward':
        composer.killLineForward();
        tuiState.dirty.add('composer');
        scheduler.schedule();
        return;
      case 'kill_word_backward':
        composer.killWordBackward();
        tuiState.dirty.add('composer');
        scheduler.schedule();
        return;
      case 'delete_or_exit':
        if (composer.isEmpty() && tuiState.runState === 'idle') {
          exitResolve();
        } else {
          composer.deleteForward();
          tuiState.dirty.add('composer');
          scheduler.schedule();
        }
        return;
      case 'word_left':
        composer.moveWordLeft();
        tuiState.dirty.add('composer');
        scheduler.schedule();
        return;
      case 'word_right':
        composer.moveWordRight();
        tuiState.dirty.add('composer');
        scheduler.schedule();
        return;
      case 'scroll_up': {
        const { rows } = getTermSize();
        const step = Math.max(1, Math.floor(rows / 3));
        tuiState.scrollOffset += step;
        tuiState.dirty.add('transcript');
        scheduler.schedule();
        return;
      }
      case 'scroll_down': {
        const { rows } = getTermSize();
        const step = Math.max(1, Math.floor(rows / 3));
        tuiState.scrollOffset = Math.max(0, tuiState.scrollOffset - step);
        tuiState.dirty.add('transcript');
        scheduler.schedule();
        return;
      }
    }

    // If idle and it's a printable char, feed to composer
    if (key.ch && !key.ctrl && !key.meta) {
      composer.insertChar(key.ch);
      tuiState.dirty.add('composer');
      scheduler.schedule();
      return;
    }

    // Editing keys (not bound to actions)
    if (key.name === 'backspace') {
      composer.backspace();
      tuiState.dirty.add('composer');
      scheduler.schedule();
      return;
    }
    if (key.name === 'delete') {
      composer.deleteForward();
      tuiState.dirty.add('composer');
      scheduler.schedule();
      return;
    }
    if (key.name === 'left') {
      composer.moveLeft();
      tuiState.dirty.add('composer');
      scheduler.schedule();
      return;
    }
    if (key.name === 'right') {
      composer.moveRight();
      tuiState.dirty.add('composer');
      scheduler.schedule();
      return;
    }
    if (key.name === 'up') {
      // Input history: recall older entry when on first line with single-line content
      if (composer.getLines().length === 1 && composer.getCursor().line === 0) {
        const recalled = inputHistory.up(composer.getText());
        if (recalled !== null) {
          composer.setText(recalled);
          tuiState.dirty.add('composer');
          scheduler.schedule();
          return;
        }
      }
      composer.moveUp();
      tuiState.dirty.add('composer');
      scheduler.schedule();
      return;
    }
    if (key.name === 'down') {
      // Input history: recall newer entry when navigating
      if (inputHistory.isNavigating()) {
        const recalled = inputHistory.down(composer.getText());
        if (recalled !== null) {
          composer.setText(recalled);
          tuiState.dirty.add('composer');
          scheduler.schedule();
          return;
        }
      }
      composer.moveDown();
      tuiState.dirty.add('composer');
      scheduler.schedule();
      return;
    }
    if (key.name === 'home') {
      composer.moveHome();
      tuiState.dirty.add('composer');
      scheduler.schedule();
      return;
    }
    if (key.name === 'end') {
      composer.moveEnd();
      tuiState.dirty.add('composer');
      scheduler.schedule();
      return;
    }
  }

  process.stdin.on('data', onData);

  // ── Signal handling ─────────────────────────────────────────────

  function dumpSessionTranscript(sessionState) {
    try {
      const messages = sessionState?.messages ?? [];
      const userAndAssistant = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
      if (userAndAssistant.length === 0) return;
      process.stdout.write('\n─── Session transcript ───\n\n');
      for (const msg of userAndAssistant) {
        if (msg.role === 'user') {
          const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          // Skip synthetic system-injected messages (e.g. [SESSION_RESUMED])
          if (text.startsWith('[') && text.includes(']')) continue;
          process.stdout.write(`> ${text.slice(0, 500)}\n\n`);
        } else if (msg.role === 'assistant') {
          const raw = typeof msg.content === 'string' ? msg.content : '';
          // Strip JSON tool call fences, keeping only prose
          const cleaned = raw
            .replace(/```(?:json)?\s*\n?\{[\s\S]*?\}\s*\n?```/g, '')
            .trim();
          if (cleaned) process.stdout.write(`${cleaned.slice(0, 800)}\n\n`);
        }
      }
      process.stdout.write('─────────────────────────\n\n');
    } catch { /* best-effort */ }
  }

  function emergencyCleanup() {
    try {
      if (sessionPersisted) dumpSessionTranscript(state);
    } catch { /* best-effort */ }
    try {
      process.stdout.write(ESC.bracketedPasteOff + ESC.cursorShow + ESC.altScreenOff + ESC.reset);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch { /* best-effort */ }
  }

  function onSignal(sig) {
    emergencyCleanup();
    process.exit(128 + (sig === 'SIGTERM' ? 15 : sig === 'SIGHUP' ? 1 : 2));
  }

  function onUncaughtException(err) {
    emergencyCleanup();
    process.stderr.write(`\nPush TUI fatal: ${err?.message || err}\n`);
    process.exit(1);
  }

  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  process.on('uncaughtException', onUncaughtException);

  // ── Resize handler ───────────────────────────────────────────────

  function onResize() {
    tuiState.dirty.add('all');
    scheduler.flush();
  }
  process.stdout.on('resize', onResize);

  // ── Initial render ───────────────────────────────────────────────

  scheduler.flush();

  // ── Wait for exit ────────────────────────────────────────────────

  try {
    await exitPromise;
  } finally {
    // ── Cleanup ──────────────────────────────────────────────────
    clearInterval(gitStatusInterval);
    scheduler.destroy();
    process.stdin.removeListener('data', onData);
    process.stdout.removeListener('resize', onResize);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGHUP', onSignal);
    process.removeListener('uncaughtException', onUncaughtException);

    if (runAbort) runAbort.abort();

    process.stdout.write(ESC.bracketedPasteOff + ESC.cursorShow + ESC.altScreenOff + ESC.reset);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();

    if (sessionPersisted) {
      dumpSessionTranscript(state);
      await saveSessionState(state);
    }
  }

  return 0;
}
