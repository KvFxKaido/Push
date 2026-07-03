// @ts-nocheck — gradual typing in progress for this large module
/**
 * tui.ts — Push TUI full-screen terminal interface.
 * Zero dependencies beyond Node built-ins and sibling modules.
 *
 * Entry point: runTUI(options)
 * Reuses the existing engine, session store, and provider system.
 */

import process from 'node:process';
import path from 'node:path';
import { existsSync, realpathSync, promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

import {
  createTheme,
  isThemeName,
  renderThemePreview,
  THEME_NAMES,
  VARIANTS,
} from './tui-theme.js';
// `frameTick` counter wraps around every 216,000 ticks (6h at 10 FPS).
// The previous animation system used this as a shared time base; the
// spinner is the only remaining consumer, but a generous modulus is
// effectively free so we keep it.
const TICK_MODULUS = 60 * 60 * 60;

import {
  detectSpinnerName,
  isReducedMotion,
  isSpinnerName,
  moodVerb,
  SPINNER_NAMES,
  SPINNERS,
  spinnerFrame,
  verbForActivity,
} from './tui-spinner.js';
import { createDelegationTranscriptRenderer, isDelegationEvent } from './tui-delegation-events.js';
import { isEditDiff } from '../lib/edit-diff.ts';
import {
  formatElapsed,
  formatTokenCount,
  getCompactGitStatus,
  renderKeybindHints,
  renderStatusBar,
} from './tui-status.js';
import {
  createReconnectState,
  planNextRetry,
  recordAttemptResult,
  secondsUntilNextRetry,
} from './tui-daemon-reconnect.js';
import { classifyDaemonSpawnError, readPushdLogTail } from './tui-daemon-errors.js';
import { createDefaultTuiIo } from './tui-io.js';
import { FocusStack } from './tui-focus.js';
import {
  evaluateHelloResponse,
  formatUnknownEventWarning,
  shouldWarnAboutUnknownEvent,
} from './tui-daemon-handshake.js';
import { getContextBudget, estimateContextTokens } from './context-manager.js';
import { filterSessions, scopeSessionsToWorkspace } from './tui-fuzzy.js';
import { findLastAssistantText, findLastCodeBlock, formatByteSize } from './tui-copy.js';
import {
  applySingleLineEditKey,
  getListNavigationAction,
  moveCursorCircular,
} from './tui-modal-input.js';
import {
  cursorMarker,
  cursorStyle,
  drawModalBoxAt,
  getCenteredModalRect,
  getWindowedListRange,
  renderCenteredModalBox,
} from './tui-widgets.js';
import { createApprovalPane } from './tui-approval-pane.js';
import {
  parseKey,
  splitRawInputChunk,
  createKeybindMap,
  createComposer,
  createInputHistory,
} from './tui-input.js';
import {
  ESC,
  getTermSize,
  visibleWidth,
  truncate,
  wordWrap,
  padTo,
  drawDivider,
  createScreenBuffer,
  createRenderScheduler,
  computeLayout,
  osc52Copy,
} from './tui-renderer.js';
import {
  makeBadge,
  pushWrappedLines,
  renderAssistantEntryLines,
  renderEntryLines,
  summarizeToolArgs,
} from './tui-framers.js';
import { PROVIDER_CONFIGS, resolveApiKey, getProviderList } from './provider.js';
import { getCuratedModels, fetchModels } from './model-catalog.js';
import {
  createSessionState,
  saveSessionState,
  appendSessionEvent,
  loadSessionState,
  listSessions,
  deleteSession,
  getSessionRoot,
  rewriteMessagesLog,
} from './session-store.js';
import { runCheckpointCommand } from './checkpoint-command.js';
import { formatWorktreeStatus } from './worktree.js';
import {
  buildSystemPromptBase,
  ensureSystemPromptReady,
  runAssistantTurn,
  DEFAULT_MAX_ROUNDS,
} from './engine.js';
import { loadConfig, applyConfigToEnv, saveConfig, maskSecret } from './config-store.js';
import {
  loadSkills,
  interpolateSkill,
  getSkillPromptTemplate,
  filterSkillsForEnvironment,
  getCurrentSkillPlatform,
  lintSkills,
  formatSkillDiagnostics,
  skillDiagnosticSummaryLine,
  type SkillDiagnostic,
} from './skill-loader.js';
import { ALL_CAPABILITIES } from '../lib/capabilities.js';
import { TUI_DAEMON_CAPABILITIES } from '../lib/daemon-capabilities.js';
import { getBuildStamp } from './build-stamp.js';
import { isTranscriptMutationEvent } from '../lib/session-transcript-events.js';
import { matchingRiskPatternIndex, suggestApprovalPrefix } from './tools.js';
import { ensureRepoCommandsSeeded } from './repo-commands.js';
import { createTabCompleter } from './tui-completer.js';
import { createFileLedger, updateFileLedger, getLedgerSummary } from './file-ledger.js';
import { appendUserMessageWithFileReferences } from './file-references.js';
import { compactContext } from './context-manager.js';
import {
  computeTranscriptViewport,
  findFirstBlockStartingAtOrAfter,
  findFirstIntersectingBlock,
} from './tui-transcript-window.js';
import { shouldFullRedraw } from './tui-render-frame.js';
import { reconcileEntryBlocks } from './tui-transcript-cache.js';
import { reconcileStreamFrame } from './tui-stream-frame.js';

// ── TUI state ───────────────────────────────────────────────────────

const MAX_TRANSCRIPT = 2000; // max lines in transcript buffer
const MAX_TOOL_FEED = 200; // max items in tool feed
// `TUI_DAEMON_CAPABILITIES` (the snapshot/event-v2 profile this client
// advertises) is the canonical, drift-tested definition in
// `lib/daemon-capabilities.ts` — imported above, not redefined here (#745).

// OSC 52 payload cap. Widely-supported terminals (Windows Terminal, iTerm2,
// kitty, alacritty) accept at least ~100 KB; tmux historically capped lower
// without `set -g set-clipboard on`. Truncate rather than silently fail.
const OSC52_MAX_BYTES = 100_000;

function safeRealpath(targetPath) {
  try {
    return realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function isPathWithin(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return (
    resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

function normalizeProviderInput(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'undefined' || normalized === 'null') return '';
  return normalized;
}

function normalizeBooleanSetting(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return Boolean(value);
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on', 'auto'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'manual'].includes(normalized)) return false;
  return fallback;
}

function isTuiDaemonAutoStartEnabled(config) {
  return normalizeBooleanSetting(
    process.env.PUSH_TUI_DAEMON_AUTOSTART ?? config.tuiDaemonAutoStart,
    true,
  );
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // `kill(pid, 0)` only checks whether the process exists. POSIX
    // distinguishes two failure modes: ESRCH (no such process) and
    // EPERM (process exists, but the caller cannot signal it). EPERM
    // means the daemon is running under another uid or has changed
    // credentials — it is NOT "not running." Treating it as such
    // would cause `startDaemonForTui` to delete the pidfile and spawn
    // a duplicate. Any other code (EINVAL, etc.) is treated as the
    // safe "not running" fallback.
    return err?.code === 'EPERM';
  }
}

function findContainingPushRepoRoot(startDir) {
  let dir = safeRealpath(startDir);

  while (true) {
    const hasMarkers =
      existsSync(path.join(dir, 'push')) &&
      existsSync(path.join(dir, 'AGENTS.md')) &&
      existsSync(path.join(dir, 'cli', 'cli.js')) &&
      existsSync(path.join(dir, 'cli', 'tui.mjs'));
    if (hasMarkers) return dir;

    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function getRuntimeOriginWarning(workspaceCwd) {
  const repoRoot = findContainingPushRepoRoot(workspaceCwd);
  if (!repoRoot) return null;

  const rawEntry = process.argv[1];
  if (!rawEntry || !rawEntry.trim()) return null;

  const runtimeEntry = safeRealpath(rawEntry);
  if (isPathWithin(repoRoot, runtimeEntry)) return null;

  return [
    'Workspace looks like the Push repo, but this TUI is running from a different CLI install.',
    `runtime: ${runtimeEntry}`,
    `repo launcher: ${path.join(repoRoot, 'push')}`,
    'tip: use `./push` or `bash ./push` here to test local changes.',
  ].join('\n');
}

function getRuntimeOriginMismatch(workspaceCwd) {
  const repoRoot = findContainingPushRepoRoot(workspaceCwd);
  if (!repoRoot) return null;

  const rawEntry = process.argv[1];
  if (!rawEntry || !rawEntry.trim()) {
    return { repoRoot, runtimeEntry: '', mismatched: false };
  }

  const runtimeEntry = safeRealpath(rawEntry);
  return {
    repoRoot,
    runtimeEntry,
    mismatched: !isPathWithin(repoRoot, runtimeEntry),
  };
}

function createTUIState() {
  return {
    // Run state machine: idle | running | awaiting_approval | awaiting_user_question
    runState: 'idle',
    // What the agent is doing right now, used to label the spinner
    // (thinking / replying / <tool verb>). Null when idle. Updated from
    // engine events; resolved via tui-spinner.verbForActivity.
    activity: null,
    // Transcript: array of { role, text, timestamp, seq }
    transcript: [],
    // Monotonic id stamped on each entry at push time — stable across
    // MAX_TRANSCRIPT front-eviction, so cached payload ids don't drift.
    transcriptSeq: 0,
    // Per-entry framed-line cache keyed by entry identity (see
    // tui-transcript-cache.ts). Appending an entry only frames that entry.
    entryRenderCache: new WeakMap(),
    // Streaming token accumulator (for in-progress assistant response)
    streamBuf: '',
    // Settle-and-freeze cache for the streaming tail (tui-stream-frame.ts):
    // frames the settled prefix once, reframes only the volatile tail per token.
    streamFrameState: null,
    // Tool feed: array of { type: 'call'|'result', name, args?, duration?, error?, preview?, timestamp }
    toolFeed: [],
    // Approval prompt (when awaiting_approval)
    approval: null, // { kind, summary, details }
    // Pane wrapper for the approval modal — owns its render + key handling.
    // Set together with `approval` via openApprovalPane / cleared via closeApprovalPane.
    approvalPane: null,
    // User question prompt (when awaiting_user_question)
    userQuestion: null, // { question: string, choices?: string[] }
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
    resumeModalState: null, // { loading, rows[], cursor, error, confirmDeleteId, mode, renameTargetId, renameBuf, renameCursor }
    modelModalOpen: false,
    modelModalState: null, // { providerId, models[], cursor, loading, source, error }
    configModalOpen: false,
    configModalState: null, // { mode: 'list'|'edit', cursor: 0, editTarget: '', editBuf: '', editCursor: 0 }
    // Scrollback offset (0 = pinned to bottom, positive = scrolled up by N lines)
    scrollOffset: 0,
    // Dirty flags for selective re-render
    dirty: new Set(['all']),
    // Git status for status bar
    gitStatus: null, // { branch, dirty, ahead, behind }
    // File awareness ledger (accumulated from engine tool_result events)
    fileAwareness: null, // { total, files: [{ path, status, reads, writes }] }
    // Most recent full tool result text — used by /copy tool. The per-entry
    // `resultPreview` on transcript tool_calls is truncated; this holds the
    // untruncated payload dispatched on the live event.
    lastToolResult: null, // { name, text, isError } | null
    // Most recent Remote pairing bundle — used by /copy remote so users
    // don't have to select a long bearer out of alternate-screen scrollback.
    lastRemotePairBundle: null,
    // Wall-clock ms when the current turn started (idle → running).
    // Cleared on running → idle. Preserved across awaiting_* ↔ running
    // since those are continuations of the same turn (e.g. user
    // approving a tool). Null when idle. Used by the running indicator
    // to show elapsed time.
    turnStartedAt: null,
  };
}

// ── Transcript management ───────────────────────────────────────────

const DEFAULT_COMPACT_TURNS = 6;

function pushTranscriptEntry(tuiState, entry, { autoScroll = true } = {}) {
  // Stamp a stable id before push so the per-entry render cache (keyed by entry
  // identity) and the payload ids derived from it survive front-eviction.
  entry.seq = tuiState.transcriptSeq = (tuiState.transcriptSeq || 0) + 1;
  tuiState.transcript.push(entry);
  if (tuiState.transcript.length > MAX_TRANSCRIPT) {
    tuiState.transcript.splice(0, tuiState.transcript.length - MAX_TRANSCRIPT);
  }
  // No cache invalidation needed: the new entry is a natural cache miss while
  // every prior entry keeps its framed lines (identity-keyed). Width / theme /
  // payload-flag changes invalidate via the global `sig` in renderTranscript.
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

function renderHeader(
  buf,
  layout,
  theme,
  { provider, model, session, cwd, runState, branch, spinner, activity },
) {
  const { glyphs } = theme;
  const { top, left, width } = layout.header;

  // Status dot. While running, prefer a Braille spinner frame if one is
  // active and the terminal can render Unicode; otherwise fall back to the
  // static glyph set's statusDot.
  const runningGlyph =
    theme.unicode && spinner?.name && spinner.name !== 'off'
      ? (spinnerFrame(spinner.name, spinner.tick ?? 0) ?? glyphs.statusDot)
      : glyphs.statusDot;
  const stateDot =
    runState === 'running'
      ? theme.style('state.warn', runningGlyph)
      : runState === 'awaiting_approval'
        ? theme.style('state.error', glyphs.statusDot)
        : theme.style('state.success', glyphs.statusDot);
  // Verb sits next to the spinner glyph while running (thinking,
  // replying, or a tool verb). Falls through to runState otherwise so
  // 'idle' / 'awaiting_approval' still read clearly. When there's no
  // activity-specific verb yet, swap the mechanical 'running' for a
  // deterministic mood verb (roosting / brewing / …) seeded by
  // sessionId — softer than a status code, stable per session.
  const verb = runState === 'running' ? (verbForActivity(activity) ?? moodVerb(session)) : runState;

  const sep = theme.style('fg.dim', '·');
  const stateLabel = theme.style('fg.dim', verb);
  const providerStr = theme.style('accent.link', provider);
  const modelStr = theme.bold(theme.style('fg.primary', model));
  const homeDir = process.env.HOME || '';
  const shortCwd = homeDir && cwd.startsWith(homeDir) ? '~' + cwd.slice(homeDir.length) : cwd;
  const branchPart = branch ? ` ${sep} ${theme.style('accent.link', branch)}` : '';

  // Single dim row: `● state · provider · model · ~/dir · branch`.
  // No box, no session line — the bottom status bar already carries
  // session/git context, so trade chrome for transcript real estate.
  const cwdStr = theme.style('fg.dim', truncate(shortCwd, Math.floor(width * 0.35)));
  const row = `${stateDot} ${stateLabel} ${sep} ${providerStr} ${sep} ${modelStr} ${sep} ${cwdStr}${branchPart}`;
  buf.writeLine(top, left, padTo(row, width));
}

// Aliases kept so the existing call sites read naturally; the implementations
// live in tui-transcript-window.ts where they can be unit-tested.
const findFirstIntersectingTranscriptBlock = findFirstIntersectingBlock;
const findFirstTranscriptBlockStartingAtOrAfter = findFirstBlockStartingAtOrAfter;

function renderTranscript(buf, layout, theme, tuiState) {
  const { top, left, width, height } = layout.transcript;

  const expandedPayloadIdsKey = tuiState.toolJsonPayloadsExpanded
    ? 'all'
    : Array.from(tuiState.expandedToolJsonPayloadIds).sort().join('|');
  // Global frame signature: when any of these change, every entry must reflow
  // (width re-wraps, theme re-styles, payload-expansion changes line counts), so
  // the signature mismatch forces a full reframe. Entry *identity* handles the
  // common case — appending an entry frames only that entry; all prior entries
  // reuse their cached lines.
  const sig = [
    width,
    theme.name,
    tuiState.toolJsonPayloadsExpanded ? 1 : 0,
    tuiState.payloadInspectorOpen ? 1 : 0,
    tuiState.payloadCursorId || '',
    expandedPayloadIdsKey,
  ].join('::');

  const { entryBlocks, totalLines } = reconcileEntryBlocks({
    entries: tuiState.transcript,
    sig,
    cache: tuiState.entryRenderCache,
    frameEntry: (entry, entryIndex) => {
      const lines = [];
      const payloadBlocks = [];
      renderEntryLines(lines, entry, width, theme, {
        expandToolJsonPayloads: tuiState.toolJsonPayloadsExpanded,
        entryKey: `${entry.timestamp ?? 0}:${entry.seq ?? entryIndex}`,
        payloadUI: {
          blocks: payloadBlocks,
          cursorId: tuiState.payloadCursorId,
          expandedIds: tuiState.expandedToolJsonPayloadIds,
          inspectorOpen: tuiState.payloadInspectorOpen,
        },
      });
      return { lines, payloadBlocks };
    },
  });

  let streamingLines = [];

  // Add streaming buffer if assistant is currently streaming. The settled
  // prefix (complete lines + closed fences) is framed once and cached; only the
  // volatile tail reframes per token (see tui-stream-frame.ts). Same bullet
  // prefix the assistant framer uses — emitted once via firstPrefixConsumed.
  if (tuiState.streamBuf) {
    const streamSig = `${width}::${theme.name}::${tuiState.toolJsonPayloadsExpanded ? 1 : 0}`;
    const { lines: framed, state } = reconcileStreamFrame({
      text: tuiState.streamBuf,
      sig: streamSig,
      prev: tuiState.streamFrameState,
      frameChunk: (src, firstPrefixConsumed) => {
        const chunkLines = [];
        renderAssistantEntryLines(chunkLines, src, width, theme, {
          expandToolJsonPayloads: tuiState.toolJsonPayloadsExpanded,
          payloadUI: null,
          firstPrefixConsumed,
        });
        return chunkLines;
      },
    });
    tuiState.streamFrameState = state;
    streamingLines = framed;
  } else if (tuiState.streamFrameState) {
    // Stream ended (buffer committed/cleared) — drop the cache so the next
    // stream starts clean rather than reusing a stale settled prefix.
    tuiState.streamFrameState = null;
  }

  // Take the last `height` lines (scroll to bottom), adjusted by scrollOffset.
  const { effectiveOffset, startIdx, endIdxExclusive } = computeTranscriptViewport({
    totalLineCount: (totalLines || 0) + streamingLines.length,
    viewportHeight: height,
    scrollOffset: tuiState.scrollOffset,
  });

  const slice = [];
  const payloadBlocks = [];
  const startBlockIdx = findFirstIntersectingTranscriptBlock(entryBlocks, startIdx);
  const endBlockIdxExclusive = findFirstTranscriptBlockStartingAtOrAfter(
    entryBlocks,
    endIdxExclusive,
  );

  for (let bi = startBlockIdx; bi < endBlockIdxExclusive; bi++) {
    const block = entryBlocks[bi];
    const blockStart = block.startLine ?? 0;
    const blockEnd = block.endLine ?? blockStart + block.lineCount;

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

  const streamingStart = totalLines || 0;
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
        theme.style('accent.secondary', glyphs.arrow || glyphs.prompt) +
          ' ' +
          theme.style('fg.primary', entry.name) +
          (argsPreview ? ' ' + theme.style('fg.dim', argsPreview) : ''),
      );
    } else if (entry.type === 'result') {
      const ok = !entry.error;
      const status = ok
        ? theme.style('state.success', glyphs.check || 'OK')
        : theme.style('state.error', glyphs.cross_mark || 'ERR');
      const dur = entry.duration
        ? theme.style('fg.dim', `${entry.duration}ms`)
        : theme.style('fg.dim', 'done');
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

/**
 * Running indicator. Lives in the gap row directly above the composer
 * (composer.top - 1 — that row is otherwise blank). Format:
 *
 *   * roosting… (4m 5s · 4.1k tokens)
 *
 * Only renders while running. In every other state we emit a blank
 * padded line so the screen-buffer diff drops the row; without that
 * the previous frame's content would linger because the buffer
 * doesn't auto-clear unwritten rows (see tui-renderer.ts).
 *
 * Called every frame tick (10 FPS) while running, so elapsed time
 * updates roughly once per second of wall clock.
 */
function renderActivityIndicator(buf, layout, theme, tuiState, tokens, sessionId) {
  const top = layout.composer.top - 1;
  if (top < 1) return; // tiny terminal — gap row collapsed

  const visible = tuiState.runState === 'running' && typeof tuiState.turnStartedAt === 'number';

  if (!visible) {
    // Clear the row so a previous frame's indicator doesn't linger.
    buf.writeLine(top, layout.innerLeft, ' '.repeat(layout.innerWidth));
    return;
  }

  const verb = verbForActivity(tuiState.activity) ?? moodVerb(sessionId);
  const elapsed = formatElapsed(Date.now() - tuiState.turnStartedAt);
  const tokenStr = typeof tokens === 'number' ? formatTokenCount(tokens) : null;

  const sep = theme.style('fg.dim', '·');
  const marker = theme.style('fg.dim', theme.glyphs.hexagon);
  const verbStyled = theme.style('fg.muted', `${verb}…`);
  const metaInner = tokenStr ? `${elapsed} ${sep} ${tokenStr} tokens` : elapsed;
  const meta = theme.style('fg.dim', `(${metaInner})`);
  const row = `${marker} ${verbStyled} ${meta}`;

  buf.writeLine(top, layout.innerLeft, padTo(row, layout.innerWidth));
}

function renderComposer(buf, layout, theme, composer, tuiState, tabState) {
  const { top, left, width, height } = layout.composer;
  const { glyphs } = theme;
  // Composer divider: dim horizontal rule with no embedded label.
  // Run-state shows in the header row and the bottom status bar;
  // the composer doesn't need to repeat it. Tab-hint still shows on
  // the candidates row below.
  const divider = theme.style('fg.dim', glyphs.horizontal.repeat(width));
  buf.writeLine(top, left, divider);

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
        candidateLine +=
          i === index ? theme.style('accent.primary', label) : theme.style('fg.dim', label);
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
      buf.writeLine(
        contentTop + r,
        left,
        padTo(prefix + theme.style('fg.primary', content), width),
      );
    } else {
      buf.writeLine(contentTop + r, left, ' '.repeat(width));
    }
  }
}

function renderQuestionModal(buf, theme, rows, cols, userQuestion, inputBuf) {
  if (!userQuestion) return;

  const modalWidth = Math.min(64, cols - 8);
  const lines = [theme.bold(theme.style('accent.primary', '  Question')), ''];

  // Wrap the question text
  const questionLines = wordWrap(userQuestion.question || '', modalWidth - 6);
  for (const ql of questionLines) {
    lines.push(`  ${theme.style('fg.primary', ql)}`);
  }

  // Choices (if provided)
  if (userQuestion.choices?.length) {
    lines.push('');
    lines.push(
      `  ${theme.style('fg.secondary', 'Choices:')} ${userQuestion.choices.map((c) => theme.style('accent.link', c)).join('  ')}`,
    );
  }

  lines.push('');
  // Input line with cursor
  const inputDisplay = inputBuf + theme.style('fg.primary', '█');
  lines.push(`  ${theme.style('fg.dim', '›')} ${inputDisplay}`);
  lines.push('');
  lines.push(
    `  ${theme.style('accent.link', 'Enter')} ${theme.style('fg.dim', 'submit')}  ${theme.style('accent.link', 'Esc')} ${theme.style('fg.dim', 'skip')}`,
  );
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
  const lines = [theme.bold(theme.style('fg.primary', `  Reasoning ${live ? '(live)' : ''}`)), ''];

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
  lines.push(
    `  ${theme.style('accent.link', 'Ctrl+G')} toggle  ${theme.style('accent.link', 'Esc')} close`,
  );
  drawModalBoxAt(buf, theme, modalTop, modalLeft, modalWidth, lines);
}

function renderProviderModal(buf, theme, rows, cols, currentProvider, currentModel, cursor = 0) {
  const { glyphs } = theme;
  const providers = getProviderList();
  const modalWidth = Math.min(56, cols - 8);

  const lines = [theme.bold(theme.style('fg.primary', '  Provider / Model')), ''];

  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    const isCurrent = p.id === currentProvider;
    const isCursor = i === cursor;
    const hasKey = p.hasKey
      ? theme.style('state.success', glyphs.check)
      : theme.style('fg.dim', '-');
    const name = cursorStyle(theme, isCursor, p.id, isCurrent ? 'fg.primary' : 'fg.secondary');
    const currentTag = isCurrent ? theme.style('fg.dim', ' (current)') : '';
    lines.push(`  ${cursorMarker(theme, isCursor)} ${i + 1}. ${name}  ${hasKey}${currentTag}`);
  }

  lines.push('');

  // Current model + curated list
  const models = getCuratedModels(currentProvider);
  lines.push(`  ${theme.style('fg.muted', 'model:')} ${theme.style('fg.primary', currentModel)}`);
  if (models.length > 0) {
    const modelPreview = models
      .slice(0, 4)
      .map((m) => truncate(m, 30))
      .join(', ');
    lines.push(`  ${theme.style('fg.dim', modelPreview)}`);
  }

  lines.push('');
  lines.push(
    `  ${theme.style('fg.dim', '\u2191\u2193 navigate  Enter switch  Esc close  1-9 quick pick')}`,
  );
  renderCenteredModalBox(buf, theme, rows, cols, modalWidth, lines);
}

function renderModelModal(buf, theme, rows, cols, modalState, currentModel) {
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
    lines.push(
      `  ${theme.style('fg.dim', 'No models found. Use /model <name> for custom values.')}`,
    );
  } else {
    const count = modalState.models.length;
    const { start, end } = getWindowedListRange(count, modalState.cursor, listHeight);

    for (let i = start; i < end; i++) {
      const isCursor = i === modalState.cursor;
      const num = padTo(`${i + 1}.`, 4);
      const modelText = truncate(modalState.models[i], modalWidth - 14);
      const model = cursorStyle(theme, isCursor, modelText);
      const currentMark =
        modalState.models[i] === currentModel ? theme.style('fg.dim', ' (current)') : '';
      lines.push(`  ${cursorMarker(theme, isCursor)} ${num} ${model}${currentMark}`);
    }

    if (end < count) {
      lines.push(`  ${theme.style('fg.dim', `... ${count - end} more`)}`);
    }
  }

  lines.push('');
  if (modalState.loading) {
    lines.push(`  ${theme.style('fg.dim', 'Fetching live model list...')}`);
  } else if (modalState.error) {
    lines.push(
      `  ${theme.style('fg.dim', `Live fetch failed (${modalState.error}); showing curated list`)}`,
    );
  } else if (modalState.source === 'live') {
    lines.push(`  ${theme.style('fg.dim', `${modalState.models.length} models from provider`)}`);
  } else {
    lines.push(`  ${theme.style('fg.dim', `${modalState.models.length} curated models`)}`);
  }
  lines.push(
    `  ${theme.style('fg.dim', '\u2191\u2193 navigate  Enter select  Esc close  1-9 quick pick')}`,
  );
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

  const { top: modalTop, left: modalLeft } = getCenteredModalRect(
    rows,
    cols,
    totalWidth,
    totalHeight,
    { minTop: 2 },
  );

  const isRenameMode = modalState?.mode === 'rename';
  const isFilterMode = modalState?.mode === 'filter';

  // Helper to draw the list side
  function renderList() {
    // Scope tag keeps the hidden sessions visible-as-a-number: a filtered
    // view that doesn't say it's filtered reads as "that's everything".
    const scopeTag =
      modalState?.scope === 'workspace'
        ? modalState.scopedOutCount > 0
          ? ` · this workspace (${modalState.scopedOutCount} elsewhere)`
          : ' · this workspace'
        : ' · all workspaces';
    const lines = [
      theme.bold(theme.style('fg.primary', '  Resume Session')) + theme.style('fg.dim', scopeTag),
    ];

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
      lines.push(
        `  ${theme.style('fg.dim', modalState.filterBuf ? 'No matching sessions.' : 'No resumable sessions.')}`,
      );
    } else {
      const count = modalState.filteredRows.length;
      const { start, end } = getWindowedListRange(count, modalState.cursor, listHeight - 3);

      for (let i = start; i < end; i++) {
        const row = modalState.filteredRows[i].item;
        const isCursor = i === modalState.cursor;
        const isCurrent = row.sessionId === currentSessionId;
        const num = padTo(`${i + 1}.`, 4);
        const primaryRaw = row.sessionName || row.sessionId.slice(0, 20);
        const primaryText = truncate(primaryRaw, Math.max(12, listWidth - 30));
        const primary = cursorStyle(theme, isCursor, primaryText, 'fg.primary');
        const currentTag = isCurrent ? theme.style('state.success', ' ●') : '';
        const deleteTag =
          modalState.confirmDeleteId === row.sessionId ? theme.style('state.warn', ' [del?]') : '';
        const renameTag =
          isRenameMode && modalState.renameTargetId === row.sessionId
            ? theme.style('accent.secondary', ' [ren]')
            : '';
        lines.push(
          ` ${cursorMarker(theme, isCursor)} ${num}${primary}${currentTag}${deleteTag}${renameTag}`,
        );

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
        const role =
          msg.role === 'user'
            ? theme.style('accent.secondary', 'You:')
            : theme.style('accent.primary', 'AI:');
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        const preview = truncate(content.replace(/\n/g, ' '), previewWidth - 10);
        lines.push(`  ${role} ${theme.style('fg.secondary', preview)}`);
      }
    }

    // Session details section
    if (selected) {
      lines.push('');
      lines.push(theme.style('fg.dim', glyphs.horizontal.repeat(previewWidth - 4)));
      lines.push(
        `  ${theme.style('fg.muted', 'ID:')} ${theme.style('fg.secondary', selected.sessionId)}`,
      );
      if (selected.sessionName) {
        lines.push(
          `  ${theme.style('fg.muted', 'Name:')} ${theme.style('fg.primary', selected.sessionName)}`,
        );
      }
      lines.push(
        `  ${theme.style('fg.muted', 'Path:')} ${theme.style('fg.secondary', truncate(selected.cwd || '.', previewWidth - 12))}`,
      );
      lines.push(
        `  ${theme.style('fg.muted', 'Model:')} ${theme.style('fg.secondary', `${selected.provider}/${selected.model}`)}`,
      );
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
    const divider = theme.style(
      'fg.dim',
      i === 0 ? '┬' : i === Math.max(listLines.length, previewLines.length) - 1 ? '┴' : '│',
    );
    const right = previewLines[i] || '';
    combinedLines.push(left + divider + right);
  }

  // Add hints at the bottom
  combinedLines.push(theme.style('fg.dim', glyphs.horizontal.repeat(totalWidth)));
  if (isRenameMode) {
    combinedLines.push(
      `  ${theme.style('accent.primary', 'Enter')} save  ${theme.style('accent.primary', 'Esc')} cancel  ${theme.style('fg.dim', 'Type to rename')}`,
    );
  } else if (isFilterMode) {
    combinedLines.push(
      `  ${theme.style('accent.primary', 'Enter')} apply filter  ${theme.style('accent.primary', 'Esc')} clear  ${theme.style('fg.dim', 'Type to search')}`,
    );
  } else if (modalState?.confirmDeleteId) {
    combinedLines.push(
      `  ${theme.style('state.warn', 'Enter/D to confirm delete · Esc to cancel')}`,
    );
  } else {
    const hints = [
      theme.style('accent.link', '↑↓') + theme.style('fg.dim', ' nav '),
      theme.style('accent.link', 'Enter') + theme.style('fg.dim', ' resume '),
      theme.style('accent.link', '/') + theme.style('fg.dim', ' filter '),
      theme.style('accent.link', 'A') +
        theme.style('fg.dim', modalState?.scope === 'workspace' ? ' all ' : ' workspace '),
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
 * Provider rows followed by: tavily, sandbox, execMode, explain,
 * daemon, remote.
 */
function getConfigItems(providerList, config, modalState = null) {
  const items = [];
  for (const p of providerList) {
    const providerConf = config[p.id] || {};
    const cfg = PROVIDER_CONFIGS[p.id];
    let keyStatus = false;
    try {
      const k = resolveApiKey(cfg);
      if (k) keyStatus = true;
    } catch {
      /* no key */
    }
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
  const sandbox =
    process.env.PUSH_LOCAL_SANDBOX ||
    (config.localSandbox !== undefined ? String(config.localSandbox) : 'off');
  const sandboxOn = sandbox === 'true' || sandbox === '1';
  items.push({ type: 'sandbox', id: 'sandbox', sandboxOn });
  // ExecMode
  const execMode = process.env.PUSH_EXEC_MODE || config.execMode || 'auto';
  items.push({ type: 'execMode', id: 'execMode', execMode });
  // ExplainMode
  const explainOn = process.env.PUSH_EXPLAIN_MODE === 'true' || config.explainMode === true;
  items.push({ type: 'explain', id: 'explain', explainOn });
  // TUI daemon autostart
  items.push({
    type: 'daemon',
    id: 'daemon',
    daemonAutoStart: isTuiDaemonAutoStartEnabled(config),
  });
  // Remote relay config is stored separately from ~/.push/config.json;
  // modalState carries a best-effort async snapshot loaded when the
  // modal opens.
  items.push({
    type: 'remote',
    id: 'remote',
    remoteStatus: modalState?.remoteStatusLabel || 'status...',
  });
  return items;
}

function renderConfigModal(buf, theme, rows, cols, modalState, config) {
  const { glyphs } = theme;
  const providers = getProviderList();
  const items = getConfigItems(providers, config, modalState);
  const modalWidth = Math.min(50, cols - 8);

  if (modalState.mode === 'list') {
    // ── List mode ──
    const lines = [theme.bold(theme.style('fg.primary', '  Config')), ''];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const isCursor = i === modalState.cursor;
      // Use cursorMarker so the cursor glyph picks up the theme's
      // ASCII-fallback prompt char on terminals without unicode (the
      // prior hardcoded '\u203A' bypassed that path).
      const marker = cursorMarker(theme, isCursor);
      const num = `${i + 1}.`;

      if (item.type === 'provider') {
        const keyIcon = item.hasKey
          ? theme.style('state.success', glyphs.check)
          : theme.style('fg.dim', '-');
        const modelStr = truncate(item.model, modalWidth - 28);
        const nameCol = padTo(cursorStyle(theme, isCursor, item.id), 14);
        lines.push(`  ${marker} ${num} ${nameCol} ${keyIcon}  ${theme.style('fg.dim', modelStr)}`);
      } else if (item.type === 'tavily') {
        const keyIcon = item.hasKey
          ? theme.style('state.success', glyphs.check)
          : theme.style('fg.dim', '-');
        const name = cursorStyle(theme, isCursor, 'tavily');
        lines.push(`  ${marker} ${num} ${padTo(name, 14)} ${keyIcon}`);
      } else if (item.type === 'sandbox') {
        const status = item.sandboxOn
          ? theme.style('state.success', 'on')
          : theme.style('fg.dim', 'off');
        const name = cursorStyle(theme, isCursor, 'sandbox');
        lines.push(`  ${marker} ${num} ${padTo(name, 14)} ${status}`);
      } else if (item.type === 'execMode') {
        const modeColor =
          item.execMode === 'yolo'
            ? 'state.warning'
            : item.execMode === 'auto'
              ? 'state.success'
              : 'fg.secondary';
        const modeStr = theme.style(modeColor, item.execMode);
        const name = cursorStyle(theme, isCursor, 'execMode');
        lines.push(`  ${marker} ${num} ${padTo(name, 14)} ${modeStr}`);
      } else if (item.type === 'explain') {
        const status = item.explainOn
          ? theme.style('state.success', 'on')
          : theme.style('fg.dim', 'off');
        const name = cursorStyle(theme, isCursor, 'explain');
        lines.push(`  ${marker} ${num} ${padTo(name, 14)} ${status}`);
      } else if (item.type === 'daemon') {
        const status = item.daemonAutoStart
          ? theme.style('state.success', 'auto')
          : theme.style('fg.dim', 'manual');
        const name = cursorStyle(theme, isCursor, 'daemon');
        lines.push(`  ${marker} ${num} ${padTo(name, 14)} ${status}`);
      } else if (item.type === 'remote') {
        const name = cursorStyle(theme, isCursor, 'remote');
        lines.push(
          `  ${marker} ${num} ${padTo(name, 14)} ${theme.style('fg.dim', item.remoteStatus)}`,
        );
      }

      // Visual gap between providers and extras
      if (i === providers.length - 1) lines.push('');
    }

    lines.push('');
    lines.push(`  ${theme.style('fg.dim', '\u2191\u2193 navigate  Enter edit/toggle  Esc close')}`);

    renderCenteredModalBox(buf, theme, rows, cols, modalWidth, lines);
  } else if (modalState.mode === 'edit') {
    // ── Edit mode ──
    const targetLabel = modalState.editTarget;
    const lines = [theme.bold(theme.style('fg.primary', `  API key for ${targetLabel}`)), ''];

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
        } catch {
          /* no key */
        }
      }
    }
    lines.push(
      `  ${theme.style('fg.muted', 'Current:')} ${theme.style('fg.secondary', currentDisplay)}`,
    );
    lines.push('');

    // Input line with masked display
    const inputDisplay = modalState.editBuf ? maskInput(modalState.editBuf) : '';
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
      { id: 'auto', desc: 'prompt only for high-risk commands' },
      { id: 'yolo', desc: 'no exec prompts' },
    ];
    const lines = [theme.bold(theme.style('fg.primary', '  Exec mode')), ''];
    for (let i = 0; i < EXEC_MODES.length; i++) {
      const m = EXEC_MODES[i];
      const isCursor = i === modalState.pickCursor;
      // Use cursorMarker so the cursor glyph picks up the theme's
      // ASCII-fallback prompt char on terminals without unicode (the
      // prior hardcoded '\u203A' bypassed that path).
      const marker = cursorMarker(theme, isCursor);
      const label = cursorStyle(theme, isCursor, m.id);
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
  // Process/IO seam (TUI Decomposition Phase 0). Production passes no
  // `options.io` and gets the real `process` streams + signal/exit wiring —
  // behavior identical to the prior inline `process.*` calls. A headless test
  // harness injects a fake stdin/stdout + no-op signal/exit hooks so the
  // closure is drivable without a real terminal and can't kill the runner.
  const io = options.io ?? createDefaultTuiIo();

  // Injectable collaborators (TUI Decomposition Phase 0). Defaults reproduce
  // the prior inline behavior; a headless harness overrides `tryConnect` to
  // return a stub daemon client (no real socket/spawn) and `loadConfig` /
  // `listSessions` for deterministic startup (no disk, no resume modal).
  const deps = {
    loadConfig,
    listSessions,
    tryConnect: async (socketPath, timeoutMs) =>
      (await import('./daemon-client.js')).tryConnect(socketPath, timeoutMs),
    ...(options.deps ?? {}),
  };

  // Load config + apply env before theme construction so PUSH_THEME (and
  // any other theme-relevant env vars) are in place when createTheme() reads them.
  const config = await deps.loadConfig();
  applyConfigToEnv(config);

  // `let` (not `const`) so /theme <name> can hot-swap the theme without
  // restarting the TUI. Renderers receive `theme` as a parameter on every
  // frame, so reassigning this closure variable propagates to the next draw.
  //
  // The runtime fallback (see `detectThemeName` in `tui-theme.ts`) is
  // `mono`, which pairs with the reserved bullet-led TUI rendering.
  // `applyConfigToEnv` above seeds `PUSH_THEME` from `config.theme` if
  // pinned, so a user preference wins over the default with no extra
  // logic here.
  let theme = createTheme({});
  const tuiState = createTUIState();
  const composer = createComposer();

  // Test-only seam (TUI Decomposition Phase 0): hand the headless harness a
  // live reference to inspect `tuiState.transcript` (and the composer) without
  // parsing rendered ANSI frames. Production never passes `options.onState`.
  options.onState?.({ tuiState, composer });

  const keybinds = createKeybindMap();
  const screenBuf = createScreenBuffer((chunk) => io.stdout.write(chunk));
  const inputHistory = createInputHistory();

  // ── Resolve provider/session ─────────────────────────────────────
  if (!Array.isArray(config.safeExecPatterns)) {
    config.safeExecPatterns = [];
  }
  const safeExecPatterns = config.safeExecPatterns;

  const maxRounds = options.maxRounds || DEFAULT_MAX_ROUNDS;

  async function createFreshSessionState(providerName, requestedModel, cwd) {
    const providerConfig = PROVIDER_CONFIGS[providerName];
    if (!providerConfig) throw new Error(`Unknown provider: ${providerName}`);
    // Route through the shared factory so the attach token is minted at birth
    // (Universal Session Bearer) — the TUI's inline session is no longer born
    // tokenless, so when the daemon later lazy-loads it (a TUI attaches to its
    // own persisted `state.sessionId`) there's nothing to backfill and no
    // stale-`undefined` reconnect lockout. `mode: 'tui'` tags origin surface
    // so `list_sessions` (and the mobile drawer) bucket this row as TUI;
    // `ensureSessionPersisted` re-emits the matching value in the
    // `session_started` event payload.
    const nextState = {
      ...createSessionState({
        provider: providerName,
        model: requestedModel,
        cwd,
        mode: 'tui',
        messages: [{ role: 'system', content: buildSystemPromptBase(cwd) }],
      }),
      workingMemory: {
        plan: '',
        openTasks: [],
        filesTouched: [],
        assumptions: [],
        errorsEncountered: [],
        currentPhase: '',
        completedPhases: [],
      },
    };
    // Start enriching the system prompt in the background — will be
    // awaited before the first LLM call in the lead turn.
    ensureSystemPromptReady(nextState);
    // Seed repo validation commands (test/lint/typecheck/...) into working
    // memory in the background. Best-effort: failures don't block the session.
    ensureRepoCommandsSeeded(nextState);
    // Disk writes are deferred to first user message (lazy session creation).
    return nextState;
  }

  // ── Session init ─────────────────────────────────────────────────

  let state;
  if (options.sessionId) {
    state = await loadSessionState(options.sessionId);
    // Optional resume overrides
    let stateChanged = false;

    const overrideProvider = normalizeProviderInput(options.provider);
    if (overrideProvider) {
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
    const providerName =
      normalizeProviderInput(options.provider) ||
      normalizeProviderInput(process.env.PUSH_PROVIDER) ||
      normalizeProviderInput(config.provider) ||
      'ollama';
    const cwd = path.resolve(options.cwd || process.cwd());
    const providerConfig = PROVIDER_CONFIGS[providerName];
    if (!providerConfig) throw new Error(`Unknown provider: ${providerName}`);
    const requestedModel = options.model || providerConfig.defaultModel;
    state = await createFreshSessionState(providerName, requestedModel, cwd);
  }

  // Seed validation commands on resumed sessions too — covers users who
  // upgrade the CLI after starting a session that pre-dates the field.
  ensureRepoCommandsSeeded(state);

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
    // Normalize once so the condition and the emitted value can't
    // disagree. `listSessions()` trims `state.mode` on read; emitting
    // an untrimmed value here would make the `session_started` event
    // drift from the `list_sessions` row by a whitespace-padding
    // accident. Defensive fallback matches `listSessions()`'s legacy
    // fallback ('interactive') so if `state.mode` is ever cleared by
    // future refactors the event and the listing still agree.
    const trimmedMode = typeof state.mode === 'string' ? state.mode.trim() : '';
    const mode = trimmedMode || 'interactive';
    await appendSessionEvent(state, 'session_started', {
      sessionId: state.sessionId,
      state: 'idle',
      mode,
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
      // Non-append mutation (overwrites messages[0] in place). Force a
      // log rewrite so the persisted transcript reflects the refreshed
      // system prompt — saveSessionState's length-only fast path would
      // skip the log on a same-length edit.
      await rewriteMessagesLog(state);
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
      const { stdout } = await execAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: state.cwd,
      });
      branch = stdout.trim();
    } catch {
      /* not a git repo */
    }
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

  // ── Daemon mode (connect to pushd if running) ───────────────────
  let daemonClient = null;
  let daemonSessionId = null;
  let daemonAttachToken = null;
  // Run id of a daemon-owned run we learned about from a snapshot (reattach to
  // a run started elsewhere) rather than from a local `runPrompt` turn. The
  // local turn path owns `runAbort`; this is the only cancel handle for a run
  // we didn't start locally, so Ctrl+C can still cancel it. Null whenever the
  // session isn't running (cleared in `setRunState('idle')`). Audit: Codex #744.
  let daemonActiveRunId = null;
  let daemonAutoStartAttempted = false;
  // Code-freshness self-heal state (stale-runtime detection). `daemonBuildStamp`
  // is the connected daemon's startup stamp from the hello handshake; comparing
  // it to this process's own stamp detects a daemon running pre-`git pull` code.
  // `daemonStale` pauses new runs while a refresh is mid-flight; `pendingDaemonRespawn`
  // tells the socket-close handler to respawn a fresh daemon instead of plain
  // reconnect; `daemonRefreshInProgress` guards against overlapping refreshes.
  let daemonBuildStamp = null;
  let daemonStale = false;
  let pendingDaemonRespawn = false;
  let daemonRefreshInProgress = false;
  // Auto-reconnect state. When the daemon socket dies the TUI used to
  // permanently fall back to inline mode for the rest of the session —
  // the reconnect coordinator (`cli/tui-daemon-reconnect.ts`) replaces
  // that with an exponential-backoff retry loop. State is kept on this
  // closure so the frame ticker can render a live countdown and so the
  // `socket.on('close')` handler can reschedule without rebuilding any
  // of it.
  let daemonReconnectState = createReconnectState();
  let daemonReconnectTimer = null;
  // Set to true on first successful connect so the disconnect path can
  // tell the difference between "never connected this session" (no
  // reconnect attempt warranted) and "connection dropped" (start the
  // retry loop). Without it a TUI that boots with no daemon would
  // start hammering retries against a daemon that was never running.
  let daemonEverConnected = false;
  // Cursor for the highest envelope `seq` the TUI has observed from
  // the daemon. The TUI was previously sending `state.eventSeq` as
  // `lastSeenSeq` on attach, but `state.eventSeq` is the *local* event
  // counter — incoming daemon events never bumped it — so a reconnect
  // after any daemon output replayed everything from seq 0 and the
  // user saw duplicated transcript and tool lines (codex review on
  // PR #664). Tracking the per-connection observed seq separately
  // means `attachExistingDaemonSession` asks for events strictly
  // *after* the last one we already rendered, while leaving the
  // local `state.eventSeq` alone for the file-on-disk denormalisation.
  let lastSeenDaemonSeq = 0;
  // Deferred hook so the reconnect helpers can wake the frame ticker
  // without referencing `refreshTicker` before it's defined further
  // down the closure (it lives in the TDZ at the point the helpers
  // are declared, and a direct reference would throw if a disconnect
  // somehow fired before initialisation finished). The hook is
  // replaced with the real ticker refresh after the frame ticker is
  // initialised; before that, calling it is a safe no-op.
  let invalidateReconnectAnimators = () => {};
  // Registry of unknown event types we've already surfaced a warning
  // for on the current daemon connection. Cleared on each reconnect
  // by `tryDaemonConnect` so a daemon upgrade resurfaces the warning
  // for any genuinely-new types it starts emitting.
  const unknownEventWarnedTypes = new Set();

  async function readDaemonPidFile(pidPath) {
    try {
      const raw = await fs.readFile(pidPath, 'utf8');
      const parsed = Number.parseInt(raw.trim(), 10);
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  // Walk `dirs` for the first .ts/.mts source file with an mtime newer than
  // `refMs`, skipping build/dep/test trees. Early-exits on the first hit (we
  // only need existence, not the full set). Bounded — `cli/` + `lib/` are
  // small — and best-effort: any I/O error on a subtree is skipped.
  //
  // Termination is guaranteed two ways since this runs on every reuse connect:
  // symlinked dirs are never descended (`isSymbolicLink` skip), and a hard
  // entry budget caps total work so even a bind-mount real-dir cycle can't hang
  // TUI startup (it bails to `null` = no warning).
  async function firstSourceFileNewerThan(refMs, dirs) {
    const SKIP = new Set(['node_modules', 'dist', 'tests', '.git']);
    const stack = [...dirs];
    let budget = 10000;
    while (stack.length > 0 && budget > 0) {
      const dir = stack.pop();
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        if (--budget <= 0) break;
        if (ent.isSymbolicLink()) continue;
        if (ent.isDirectory()) {
          if (!SKIP.has(ent.name)) stack.push(path.join(dir, ent.name));
          continue;
        }
        if (!/\.m?ts$/i.test(ent.name)) continue;
        const full = path.join(dir, ent.name);
        try {
          const st = await fs.stat(full);
          if (st.mtimeMs > refMs) return full;
        } catch {
          /* skip unreadable file */
        }
      }
    }
    return null;
  }

  // Dev-only staleness check for a daemon we connected to but did NOT just
  // spawn (a pre-existing process reused via the fast probe / pidfile). A
  // long-lived daemon keeps its code in memory — neither dist nor tsx hot-
  // reloads — so source edited after it started silently runs old code (the
  // footgun that made #740's new verbs 404 against a stale daemon). Signal:
  // pidfile mtime (daemon-start proxy) vs the newest `cli/`/`lib/` source.
  // Scoped to a source-running TUI (tsx); a dist/installed TUI has no live
  // .ts tree to compare, so it reports `unchecked` (no false alarms in prod).
  // Returns one of three states: `stale` (+ descriptor), `current` (checked,
  // up to date), or `unchecked` (not source-run, or an I/O error).
  async function reusedDaemonStaleness() {
    // Strip any query/hash a loader may append (tsx can suffix import URLs)
    // before reading the extension — an anchored match on the raw URL would
    // miss `…/tui.ts?v=123` and silently skip the check.
    const cleanUrl = import.meta.url.replace(/[?#].*$/, '');
    const ext = path.extname(cleanUrl).slice(1).toLowerCase();
    if (ext !== 'ts' && ext !== 'mts') return { status: 'unchecked' };
    try {
      const { getPidPath } = await import('./pushd.js');
      const pidPath = getPidPath();
      const pidStat = await fs.stat(pidPath);
      const cliDir = path.dirname(fileURLToPath(cleanUrl));
      const libDir = path.join(cliDir, '..', 'lib');
      const newer = await firstSourceFileNewerThan(pidStat.mtimeMs, [cliDir, libDir]);
      if (!newer) return { status: 'current' };
      const pid = await readDaemonPidFile(pidPath);
      const rootDir = path.join(cliDir, '..');
      return {
        status: 'stale',
        pid,
        daemonStartedAtMs: pidStat.mtimeMs,
        newerFile: path.relative(rootDir, newer),
      };
    } catch {
      return { status: 'unchecked' };
    }
  }

  // Surface the staleness warning + a structured log on the reuse path. All
  // three states are logged with distinct events so a dist-mode reuse
  // (`unchecked`) isn't recorded as a verified-current daemon, and a stale
  // reuse is never silent.
  async function warnIfReusedDaemonStale() {
    // This is pure diagnostics on the connect fast path — it must never crash
    // TUI init (cf. `appendDaemonLogTail`). Any failure degrades to silence.
    try {
      const result = await reusedDaemonStaleness();
      if (result.status !== 'stale') {
        io.stderr.write(
          `${JSON.stringify({ level: 'debug', event: `tui_daemon_reuse_${result.status}` })}\n`,
        );
        return;
      }
      io.stderr.write(
        `${JSON.stringify({ level: 'warn', event: 'tui_daemon_reuse_stale', pid: result.pid, daemonStartedAtMs: result.daemonStartedAtMs, newerFile: result.newerFile })}\n`,
      );
      addTranscriptEntry(
        tuiState,
        'warning',
        `Reused a running pushd daemon${result.pid ? ` (pid ${result.pid})` : ''} started before your latest source edit (${result.newerFile}). It keeps old code in memory — stop it and relaunch so this session runs your current changes.`,
      );
    } catch {
      /* diagnostic path must never crash TUI init */
    }
  }

  /**
   * Code-freshness self-heal. Returns true if it detected a stale daemon (by
   * build stamp) and kicked off a refresh — in which case the caller skips the
   * mtime-based warn, which would be a redundant/contradictory second signal.
   *
   * Build-stamp drift (commit identity) is the self-heal trigger because it
   * only flips on commit / `git pull`, not on every editor save — so it won't
   * thrash during active local development the way the mtime check would if it
   * drove a respawn.
   */
  async function maybeSelfHealStaleDaemon() {
    try {
      // No stamp ⇒ older daemon that can't participate; leave self-heal off and
      // let the mtime warn cover it.
      if (!daemonBuildStamp) return false;
      const localStamp = await getBuildStamp();
      if (daemonBuildStamp === localStamp) {
        io.stderr.write(
          `${JSON.stringify({ level: 'debug', event: 'tui_daemon_buildstamp_match', stamp: localStamp })}\n`,
        );
        return false;
      }
      io.stderr.write(
        `${JSON.stringify({ level: 'warn', event: 'tui_daemon_buildstamp_stale', daemon: daemonBuildStamp, local: localStamp })}\n`,
      );
      addTranscriptEntry(
        tuiState,
        'warning',
        `Stale pushd daemon detected — it is running build ${daemonBuildStamp}, but this session is build ${localStamp}. Refreshing the daemon so your work runs on current code…`,
      );
      await refreshDaemon({ reason: `stale buildStamp ${daemonBuildStamp} != ${localStamp}` });
      return true;
    } catch {
      // Never let the freshness path crash connect — degrade to "no self-heal".
      return false;
    }
  }

  /** Reuse-path assessment: stamp-driven self-heal first, mtime warn as fallback. */
  async function assessReusedDaemon() {
    const healed = await maybeSelfHealStaleDaemon();
    if (!healed) await warnIfReusedDaemonStale();
  }

  /**
   * Drain the connected (stale) daemon and arrange a respawn from current code.
   * Never kills in-flight work: the daemon self-exits only once idle, so an
   * active run finishes on the code it started under. New runs are paused
   * (`daemonStale`) until the fresh daemon is ready.
   *
   * Both the already-idle and the deferred (active-run) paths converge on the
   * socket-close handler → `respawnFreshDaemon()`, which avoids racing the
   * daemon's deferred self-SIGTERM.
   */
  async function refreshDaemon({ reason } = {}) {
    if (daemonRefreshInProgress) return;
    daemonRefreshInProgress = true;
    daemonStale = true;
    tuiState.dirty.add('footer');
    scheduler?.schedule();
    try {
      const client = daemonClient;
      if (!client?.connected) {
        // Nothing connected to drain — e.g. it already died. Let the normal
        // reconnect path handle it; don't strand the user in paused state.
        daemonStale = false;
        return;
      }
      // Tell the close handler to respawn fresh rather than reconnect-loop.
      // Armed BEFORE the request so that even if the ack times out, a daemon
      // that did accept the drain (and will exit) still triggers a respawn on
      // close rather than a reconnect loop against the dying socket.
      pendingDaemonRespawn = true;
      let drainRes;
      try {
        // Generous timeout: the daemon acks promptly, but a busy daemon that's
        // mid-flush shouldn't trip a spurious "could not drain" while it's
        // actually on its way out.
        drainRes = await client.request('drain', { reason: reason ?? null }, null, 5000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Keep pendingDaemonRespawn armed: the daemon may have accepted the
        // drain and be exiting now, in which case the close handler respawns.
        // Unblock new runs so the user isn't stranded if it did NOT drain.
        addTranscriptEntry(
          tuiState,
          'warning',
          `Drain request to the stale daemon did not ack (${msg}); if it exits it will be replaced, otherwise run /daemon restart.`,
        );
        daemonStale = false;
        return;
      }
      const idle = Boolean(drainRes?.payload?.idle);
      // Total tracked work blocking the refresh — runs + delegations + graphs —
      // so the message can't claim "0 active runs" while a delegation holds it.
      const pendingWork = Number.isFinite(drainRes?.payload?.pendingWork)
        ? drainRes.payload.pendingWork
        : Array.isArray(drainRes?.payload?.pendingRuns)
          ? drainRes.payload.pendingRuns.length
          : 0;
      if (idle) {
        addTranscriptEntry(
          tuiState,
          'status',
          'Draining stale daemon; respawning from current code…',
        );
      } else {
        addTranscriptEntry(
          tuiState,
          'warning',
          `Stale daemon has ${pendingWork} active work item(s) in flight; new runs are paused. It will refresh automatically once they finish.`,
        );
      }
      // No proactive respawn here: the daemon self-exits when idle (now, or
      // after the active runs settle). Its socket close fires the close
      // handler, which drives `respawnFreshDaemon()`.
    } finally {
      daemonRefreshInProgress = false;
      tuiState.dirty.add('footer');
      scheduler?.schedule();
    }
  }

  /**
   * Spawn a fresh daemon from current code and reconnect, after a drained
   * daemon has exited. Invoked from the socket-close handler when
   * `pendingDaemonRespawn` is set. Falls back to inline (clearing `daemonStale`)
   * if the respawn fails so the user is never stranded.
   */
  async function respawnFreshDaemon() {
    pendingDaemonRespawn = false;
    // Reset the once-only autostart guard so ensureDaemonConnected will spawn a
    // fresh process (rather than treating autostart as already-spent).
    daemonAutoStartAttempted = false;
    daemonSessionId = null;
    daemonAttachToken = null;
    let ok = false;
    try {
      ok = await ensureDaemonConnected({ announce: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addTranscriptEntry(
        tuiState,
        'warning',
        `Fresh daemon respawn failed: ${msg}. Running inline; use /daemon restart to retry.`,
      );
    }
    // Unblock either way: on success runs go to the fresh daemon; on failure
    // they fall through to inline mode (which runs current code correctly).
    daemonStale = false;
    if (ok) {
      addTranscriptEntry(
        tuiState,
        'status',
        'Reconnected to a fresh pushd daemon running current code.',
      );
      if (sessionPersisted && state?.sessionId) {
        try {
          await attachExistingDaemonSession();
        } catch {
          /* best-effort re-attach; a fresh start_session will recover */
        }
      }
    } else {
      addTranscriptEntry(
        tuiState,
        'warning',
        'Could not respawn a fresh daemon; running inline. Use /daemon restart to retry.',
      );
    }
    tuiState.dirty.add('all');
    scheduler?.schedule();
  }

  async function startDaemonForTui() {
    const { getPidPath, getSocketPath, getLogPath } = await import('./pushd.js');
    const pidPath = getPidPath();
    const existingPid = await readDaemonPidFile(pidPath);
    const socketPath = getSocketPath();
    const logPath = getLogPath();

    if (existingPid && isProcessRunning(existingPid)) {
      const { waitForReady } = await import('./daemon-client.js');
      const ready = await waitForReady(socketPath, { maxWaitMs: 3000, intervalMs: 200 });
      if (ready) {
        return { status: 'already-running', ready, pid: existingPid, socketPath, logPath };
      }
      // The pid is alive but the socket never responded. Two
      // explanations: (1) the pid file is stale and the pid was reused
      // by an unrelated process (e.g. crash without pidfile cleanup);
      // (2) pushd is wedged. Returning `ready: false` here would
      // strand the session in inline-fallback mode for the rest of
      // the TUI run — `daemonAutoStartAttempted` flips and the
      // autostart never retries. Fall through to the spawn path
      // instead: if the live pid is actually pushd, the duplicate
      // spawn will hit EADDRINUSE on the unix socket and exit
      // (leaving the original in place), so the cost of being wrong
      // is one noisy log line. The cost of being right is a working
      // session. Codex P2 on PR #566.
    }

    if (existingPid) {
      try {
        await fs.unlink(pidPath);
      } catch {
        /* stale pid cleanup is best-effort */
      }
    }

    const { spawn } = await import('node:child_process');
    const currentExt = import.meta.url.match(/\.(m?[jt]s)$/)?.[1] ?? 'mjs';
    const pushdPath = fileURLToPath(new URL(`./pushd.${currentExt}`, import.meta.url));
    // Both .ts and .mts need the tsx loader; Node won't strip TS
    // syntax on its own. `.js` / `.mjs` are runnable directly.
    const needsTsxLoader = currentExt === 'ts' || currentExt === 'mts';
    const nodeArgs = needsTsxLoader ? ['--import', 'tsx', pushdPath] : [pushdPath];

    const logDir = path.dirname(logPath);
    await fs.mkdir(logDir, { recursive: true, mode: 0o700 });
    try {
      await fs.chmod(logDir, 0o700);
    } catch {
      /* non-POSIX */
    }
    const logHandle = await fs.open(logPath, 'a', 0o600);
    try {
      await logHandle.chmod(0o600);
    } catch {
      /* non-POSIX */
    }

    let child;
    try {
      child = spawn(process.execPath, nodeArgs, {
        detached: true,
        stdio: ['ignore', logHandle.fd, logHandle.fd],
        env: { ...process.env },
      });
      child.unref();
    } finally {
      await logHandle.close();
    }

    const { waitForReady } = await import('./daemon-client.js');
    const ready = await waitForReady(socketPath, { maxWaitMs: 3000, intervalMs: 200 });
    return { status: 'started', ready, pid: child.pid, socketPath, logPath };
  }

  /**
   * Best-effort: read the daemon log tail and append it to the
   * transcript as a `warning` entry, prefixed with `heading`. Used
   * from spawn-failure, unresponsive-after-spawn, and disconnect
   * paths so users see the daemon's last words without tailing the
   * log themselves. Silent no-op when the log file is missing or
   * empty (`readPushdLogTail` returns null in both cases — the spawn
   * path can run before the daemon writes anything, and printing
   * "log is empty" in that case is noise, not signal).
   */
  async function appendDaemonLogTail(heading) {
    try {
      const { getLogPath } = await import('./pushd.js');
      const tail = await readPushdLogTail(getLogPath());
      if (!tail) return;
      addTranscriptEntry(tuiState, 'warning', heading ? `${heading}\n${tail}` : tail);
      scheduler?.schedule();
    } catch {
      /* swallowed — the diagnostic path must never crash the TUI */
    }
  }

  async function tryDaemonConnect() {
    let client = null;
    let socketPath;
    try {
      const { getSocketPath } = await import('./pushd.js');
      socketPath = getSocketPath();
      client = await deps.tryConnect(socketPath, 500);
      if (!client) return false;
    } catch {
      // Connection-level failures (socket not present, EACCES, etc.)
      // are the "daemon not running" path — silently fall back to
      // inline and let the auto-spawn path handle it.
      return false;
    }

    // From here on, treat the hello round-trip as its own failure
    // domain. `daemon-client.request` REJECTS the promise (not
    // resolves with `ok: false`) when the daemon responds with a
    // non-ok envelope — see `cli/daemon-client.ts:processLine`
    // around lines 107-114. The previous shape (`if (!hello.ok)`)
    // was dead code and the outer catch swallowed protocol-mismatch
    // errors as silent disconnects (codex / copilot review on PR
    // #665). Catching the RequestError here lets the user see the
    // actual reason — `UNSUPPORTED_PROTOCOL_VERSION` is the most
    // common one — instead of mysteriously falling back to inline.
    let hello;
    try {
      hello = await client.request(
        'hello',
        { capabilities: [...TUI_DAEMON_CAPABILITIES] },
        null,
        500,
      );
    } catch (err) {
      const code = err?.code ? `${err.code}: ` : '';
      const message = err?.message || 'unknown error';
      addTranscriptEntry(
        tuiState,
        'warning',
        `Daemon hello rejected (${code}${message}). Running inline; restart pushd or rebuild the TUI.`,
      );
      try {
        client.close();
      } catch {
        /* socket may already be torn down */
      }
      return false;
    }

    try {
      const handshake = evaluateHelloResponse(hello.payload);
      if (!handshake.accepted) {
        addTranscriptEntry(tuiState, 'warning', handshake.reason);
        client.close();
        return false;
      }
      // Surface any non-fatal handshake warnings (e.g. missing
      // runtimeVersion on older daemons) once per connect so the user
      // knows what state they're in without it being a hard error.
      for (const w of handshake.warnings) {
        addTranscriptEntry(tuiState, 'warning', w);
      }

      // Stash the daemon's startup build stamp so the reuse-path freshness
      // check (assessReusedDaemon) can compare it to this process's own stamp.
      // Null for older daemons that don't advertise one — self-heal stays off.
      daemonBuildStamp = handshake.buildStamp ?? null;

      daemonClient = client;
      tuiState.dirty.add('footer');
      scheduler?.schedule();

      // Reset the per-connection unknown-event registry so a daemon
      // upgrade across a reconnect re-surfaces drift instead of
      // remembering "we already warned about that type" from the
      // previous link.
      unknownEventWarnedTypes.clear();

      // Register event handler — bridge daemon events to TUI
      client.onEvent((event) => {
        if (event.kind !== 'event') return;
        handleEngineEvent(event);
      });

      // Daemon disconnects no longer demote the session to inline mode
      // permanently — `scheduleDaemonReconnect` arms an exponential
      // backoff timer and `daemonReconnectState` drives the footer
      // chip so the user sees the retry countdown live.
      client._socket.on('close', () => {
        if (daemonClient === client) {
          daemonClient = null;
          // Null the session/attach tokens so any non-reconnect path
          // (e.g. an unrelated `ensureDaemonConnected` invocation)
          // doesn't short-circuit on `daemonSessionId` still being
          // set and end up `send_user_message`-ing on a stale handle.
          // The reconnect path stashes the pre-disconnect session id
          // on `state.sessionId` and the attach token on
          // `state.attachToken`, so `attachExistingDaemonSession`
          // can restore both from there on success (copilot review
          // on PR #664).
          daemonSessionId = null;
          daemonAttachToken = null;
          // A drain-driven refresh exits the daemon on purpose. Respawn a
          // fresh one from current code instead of the plain reconnect loop
          // (which would only re-dial the now-dead socket and never spawn).
          if (pendingDaemonRespawn) {
            void respawnFreshDaemon();
            return;
          }
          scheduleDaemonReconnect({ announce: true });
          // Best-effort: tail the daemon log into the transcript so
          // the user can see why pushd died. Fire-and-forget so the
          // close handler stays synchronous; the warning entry
          // arrives a tick later (often before the first reconnect
          // attempt fires) and answers "what just happened?" without
          // forcing the user to `tail -f ~/.push/run/pushd.log`.
          void appendDaemonLogTail('Daemon log at disconnect:');
        }
      });

      daemonEverConnected = true;
      // Any in-flight backoff is stale once we've handed back a live
      // client — clear it (preserving the attempt count is irrelevant
      // here because we made it through).
      cancelPendingReconnectTimer();
      daemonReconnectState = recordAttemptResult(daemonReconnectState, 'success');
      tuiState.dirty.add('footer');

      return true;
    } catch {
      try {
        client.close();
      } catch {
        /* best-effort */
      }
      return false;
    }
  }

  /** Stop the pending retry timer if armed. Does not reset attempt
   * count — `recordAttemptResult` is the only thing that does that. */
  function cancelPendingReconnectTimer() {
    if (daemonReconnectTimer) {
      clearTimeout(daemonReconnectTimer);
      daemonReconnectTimer = null;
    }
  }

  /** Arm the next reconnect retry. Idempotent: calling twice in a row
   * (e.g. socket close while a timer is already armed) cancels the
   * pending timer first so we never end up with two firing in
   * parallel. */
  function scheduleDaemonReconnect({ announce } = { announce: false }) {
    // Don't try to reconnect to a daemon we never connected to in the
    // first place — that's the inline-by-design path, not a regression
    // to recover from.
    if (!daemonEverConnected) return;
    cancelPendingReconnectTimer();
    if (announce && daemonReconnectState.phase === 'idle') {
      addTranscriptEntry(
        tuiState,
        'warning',
        'Daemon disconnected. Reconnecting in the background; turns sent now run inline.',
      );
    }
    const { next, delayMs } = planNextRetry(daemonReconnectState, Date.now());
    daemonReconnectState = next;
    daemonReconnectTimer = setTimeout(() => {
      daemonReconnectTimer = null;
      void attemptDaemonReconnect();
    }, delayMs);
    tuiState.dirty.add('footer');
    scheduler?.schedule();
    invalidateReconnectAnimators();
  }

  /** Single reconnect attempt. Tries to connect + re-attach to the
   * existing session; on success the footer flips back to `daemon`
   * and the user sees a one-line success entry. On failure we step
   * the backoff and schedule the next attempt.
   *
   * Wrapped in try/catch defensively — `tryDaemonConnect` and
   * `attachExistingDaemonSession` already swallow their own errors and
   * return false, but a future helper that doesn't would otherwise
   * silently kill the retry loop (a `void`-prefixed async function
   * that throws unhooks itself from the schedule). On caught error we
   * treat it as a failed attempt so the backoff still steps. */
  async function attemptDaemonReconnect() {
    try {
      if (daemonClient?.connected) {
        daemonReconnectState = recordAttemptResult(daemonReconnectState, 'success');
        tuiState.dirty.add('footer');
        scheduler?.schedule();
        return;
      }
      const connected = await tryDaemonConnect();
      if (connected) {
        // `tryDaemonConnect` records the success itself (it sets
        // `daemonEverConnected` + resets the reconnect state). If the
        // persisted session is addressable, re-attach so events replay.
        // The socket close handler clears `daemonSessionId`, so the
        // reconnect path must use `state.sessionId` as the durable handle.
        if (sessionPersisted && state?.sessionId) {
          const previousSessionId = state.sessionId;
          const attached = await attachExistingDaemonSession();
          if (!attached) {
            // Connected to a daemon that doesn't know our session
            // (e.g. it was wiped). Surface the mismatch — don't let
            // the user silently end up on a fresh session.
            addTranscriptEntry(
              tuiState,
              'warning',
              `Reconnected to pushd but session ${previousSessionId} is not available; new messages will start a fresh daemon session.`,
            );
            // daemonSessionId stays null — the next ensureDaemonSession
            // call will start_session and the user keeps moving.
          }
        }
        addTranscriptEntry(tuiState, 'status', 'Reconnected to pushd daemon.');
        tuiState.dirty.add('all');
        scheduler?.schedule();
        invalidateReconnectAnimators();
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Best-effort warning — don't let a thrown helper kill the loop.
      addTranscriptEntry(tuiState, 'warning', `Daemon reconnect attempt failed: ${message}`);
    }
    daemonReconnectState = recordAttemptResult(daemonReconnectState, 'fail');
    scheduleDaemonReconnect({ announce: false });
  }

  /**
   * Copy daemon-truth provider/model into the local view. Called on
   * attach response and on `session_state_changed` events. Also updates
   * the in-process `ctx.providerConfig` / `ctx.apiKey` so the next
   * inline-fallback call uses the right credentials. Returns true if
   * any field changed (callers re-render the footer on change).
   */
  function hydrateSessionStateFromDaemon(payload) {
    if (!payload || typeof payload !== 'object') return false;
    let changed = false;
    if (typeof payload.provider === 'string' && payload.provider) {
      if (state.provider !== payload.provider) {
        const newConfig = PROVIDER_CONFIGS[payload.provider];
        if (newConfig) {
          // Resolve the key FIRST, then commit both fields together.
          // A failed resolve must not leave `ctx.apiKey` pointing at
          // the *previous* provider's credential — if the daemon
          // disconnects right after the switch, the inline fallback
          // would otherwise call the new provider with the wrong key
          // instead of failing loudly with a missing-key error
          // (copilot review on PR #663). On failure we still update
          // `state.provider` + `ctx.providerConfig` so the daemon
          // (which has its own creds) stays correct, and null the
          // key so any inline fallback surfaces the misconfiguration
          // instead of silently using stale credentials.
          let resolvedKey = null;
          try {
            resolvedKey = resolveApiKey(newConfig);
          } catch {
            /* fall through with resolvedKey = null */
          }
          state.provider = payload.provider;
          ctx.providerConfig = newConfig;
          ctx.apiKey = resolvedKey;
          changed = true;
        }
      }
    }
    if (typeof payload.model === 'string' && payload.model) {
      if (state.model !== payload.model) {
        state.model = payload.model;
        changed = true;
      }
    }
    if (changed) {
      tuiState.dirty.add('footer');
      scheduler?.schedule();
    }
    return changed;
  }

  function installDaemonApprovalFromSnapshot(pendingApproval, sessionId) {
    const approvalId =
      pendingApproval && typeof pendingApproval.approvalId === 'string'
        ? pendingApproval.approvalId
        : '';

    if (!approvalId) {
      if (tuiState.approval?.daemonApprovalId) {
        approvalResolve = null;
        closeApprovalPane();
        if (tuiState.runState === 'awaiting_approval') setRunState('running');
        tuiState.dirty.add('all');
        scheduler?.schedule();
        return true;
      }
      return false;
    }

    if (tuiState.approval?.daemonApprovalId === approvalId) {
      if (tuiState.runState !== 'awaiting_approval') setRunState('awaiting_approval');
      return false;
    }

    // Runs when replay didn't already open the rich pane from an
    // `approval_required` event (the guards above return early if it did) —
    // i.e. the approval fell outside the replayed event tail. The snapshot's
    // `pendingApproval` now carries the same `kind`/`summary`/`title` the live
    // event does (#746), so the pane matches the in-session one. We follow the
    // live handler's mapping (`kind || 'action'`, `summary || title`) and
    // additionally fall back to a generic string when those are absent — that
    // last-resort case only arises for a pre-#746 daemon that omits the fields
    // (the live event always carries them).
    setRunState('awaiting_approval');
    openApprovalPane({
      kind:
        typeof pendingApproval.kind === 'string' && pendingApproval.kind
          ? pendingApproval.kind
          : 'action',
      summary:
        (typeof pendingApproval.summary === 'string' && pendingApproval.summary) ||
        (typeof pendingApproval.title === 'string' && pendingApproval.title) ||
        'Daemon is waiting for an approval decision to continue this session.',
      patternIndex: -1,
      suggestedPrefix: null,
      daemonApprovalId: approvalId,
    });
    approvalResolve = (approved) => {
      daemonClient
        ?.request(
          'submit_approval',
          {
            sessionId,
            approvalId,
            decision: approved ? 'approve' : 'deny',
            attachToken: daemonAttachToken,
          },
          sessionId,
        )
        .catch(() => {});
    };
    tuiState.dirty.add('all');
    scheduler?.schedule();
    return true;
  }

  function hydrateDaemonSnapshot(payload) {
    if (!payload || typeof payload !== 'object') return false;
    const session = payload.session;
    if (!session || typeof session !== 'object') return false;

    let changed = hydrateSessionStateFromDaemon(session);
    const snapshotSessionId =
      typeof session.sessionId === 'string' && session.sessionId
        ? session.sessionId
        : daemonSessionId;

    if (session.state === 'running') {
      // Remember the daemon's run id (preferring the richer `activeRun`
      // descriptor, falling back to `session.activeRunId`) so Ctrl+C can cancel
      // a run we reattached to but didn't start locally — there's no `runAbort`
      // for it. Set this BEFORE `setRunState('running')` so it survives (the
      // idle→running transition doesn't clear it; only →idle does).
      const runId =
        (payload.activeRun && typeof payload.activeRun.runId === 'string'
          ? payload.activeRun.runId
          : null) ||
        (typeof session.activeRunId === 'string' && session.activeRunId
          ? session.activeRunId
          : null);
      if (runId && runId !== daemonActiveRunId) daemonActiveRunId = runId;
      if (tuiState.runState === 'idle') {
        setRunState('running');
        changed = true;
      }
    } else if (session.state === 'idle') {
      if (tuiState.runState === 'running') {
        setRunState('idle');
        changed = true;
      }
      if (tuiState.runState === 'awaiting_approval' && tuiState.approval?.daemonApprovalId) {
        approvalResolve = null;
        closeApprovalPane();
        setRunState('idle');
        changed = true;
      }
    }

    if (snapshotSessionId) {
      changed =
        installDaemonApprovalFromSnapshot(payload.pendingApproval, snapshotSessionId) || changed;
    }

    return changed;
  }

  async function refreshDaemonSessionSnapshot(reason = 'unknown') {
    if (!daemonClient?.connected || !daemonSessionId || !daemonAttachToken) return false;
    try {
      const res = await daemonClient.request(
        'get_session_snapshot',
        {
          sessionId: daemonSessionId,
          attachToken: daemonAttachToken,
          recentEventLimit: 1,
        },
        daemonSessionId,
        1500,
      );
      // Hydration mutates UI state (run state, footer, approval pane) but
      // doesn't own the render loop. Schedule a redraw on change so the
      // refreshed snapshot lands even when this runs detached from the attach
      // path (see the non-blocking `void` call site).
      if (hydrateDaemonSnapshot(res.payload)) {
        tuiState.dirty.add('all');
        scheduler?.schedule();
      }
      return true;
    } catch (err) {
      // Older daemon without the verb — graceful, expected, not user-facing.
      if (err?.code === 'UNSUPPORTED_REQUEST_TYPE') return false;
      const message = err instanceof Error ? err.message : String(err);
      io.stderr.write(
        `${JSON.stringify({ level: 'warn', event: 'tui_session_snapshot_failed', reason, message })}\n`,
      );
      // A failed hydrate on a user-visible moment (attach / reconnect) leaves
      // the footer/run/approval state stale with no other signal — surface it
      // like every other daemon warning path. Background polls stay quiet to
      // avoid transcript spam. Audit: Kilo #744.
      if (reason === 'attach' || reason === 'reconnect') {
        addTranscriptEntry(
          tuiState,
          'warning',
          `Could not refresh session status from the daemon (${message}); showing last-known state.`,
        );
        tuiState.dirty.add('footer');
        scheduler?.schedule();
      }
      return false;
    }
  }

  async function attachExistingDaemonSession() {
    // INVARIANT: the truthy-`daemonSessionId` short-circuit here is the
    // double-attach guard — it assumes that on any disconnect the transient
    // `daemonSessionId` was reset to null. The socket `'close'` handler is the
    // single place that does this (it nulls `daemonSessionId`/`daemonAttachToken`
    // before arming `scheduleDaemonReconnect`). The durable handle lives on
    // `state.sessionId`, not here. If a future disconnect path forgets that
    // clear, this guard will silently skip re-attach — keep the close handler's
    // null in lockstep with this check. Audit: Kilo #744.
    if (!daemonClient || daemonSessionId || !sessionPersisted || !state?.sessionId) {
      return false;
    }
    try {
      const res = await daemonClient.request(
        'attach_session',
        {
          sessionId: state.sessionId,
          // Use `lastSeenDaemonSeq`, not `state.eventSeq`, so reconnect
          // resumes immediately after the last event we actually
          // rendered. `state.eventSeq` is the LOCAL counter and is
          // never advanced by inbound daemon events — using it here
          // re-replayed everything from seq 0 on any reconnect after
          // daemon output and duplicated the transcript (codex review
          // on PR #664).
          lastSeenSeq: lastSeenDaemonSeq,
          attachToken: state.attachToken || undefined,
          capabilities: [...TUI_DAEMON_CAPABILITIES],
        },
        null,
        1500,
      );
      daemonSessionId = state.sessionId;
      // Adopt the attach token from the response (Universal Session Bearer).
      // For a legacy tokenless session we attached with `undefined`; the
      // daemon's bootstrap grace claimed it and returned the freshly minted
      // token here. Adopt it into both the in-memory daemon token and
      // `state.attachToken` so the NEXT reconnect (which re-reads
      // `state.attachToken`) presents the real token instead of `undefined`
      // and is accepted — without this, the very next reconnect after a claim
      // would be rejected (the lockout the audit flagged). For an already-
      // tokened session the response echoes the same token we sent, so this
      // is a no-op. Fall back to the prior in-memory token if the daemon
      // (older build) omits it from the response.
      const adoptedToken =
        (typeof res.payload?.attachToken === 'string' && res.payload.attachToken) ||
        state.attachToken ||
        null;
      if (adoptedToken) state.attachToken = adoptedToken;
      daemonAttachToken = adoptedToken;
      // Daemon is the source of truth for session-scoped state. Hydrate
      // the local view from the attach response so a mid-session switch
      // from another client (or a stale state.json on disk) doesn't
      // leave the TUI showing the wrong provider/model after re-attach.
      hydrateSessionStateFromDaemon(res.payload);
      // Fire-and-forget: the attach response already hydrated provider/model,
      // so don't block the "Reconnected" message + transcript refresh on the
      // snapshot RPC's blocking 1500ms window. It hydrates run/approval state a
      // tick later and schedules its own redraw (and surfaces its own failure).
      // Safe to leave unawaited — the helper catches and reports internally.
      // Audit: Kilo #744.
      void refreshDaemonSessionSnapshot('attach');
      return true;
    } catch {
      return false;
    }
  }

  async function ensureDaemonSession() {
    if (!daemonClient || daemonSessionId) return;
    if (await attachExistingDaemonSession()) return;
    try {
      const res = await daemonClient.request('start_session', {
        provider: state.provider,
        model: state.model,
        repo: { rootPath: state.cwd },
        mode: 'tui',
        capabilities: [...TUI_DAEMON_CAPABILITIES],
      });
      daemonSessionId = res.payload.sessionId;
      daemonAttachToken = res.payload.attachToken;
    } catch (err) {
      addTranscriptEntry(
        tuiState,
        'warning',
        `Daemon session failed: ${err.message}. Using inline mode.`,
      );
      daemonClient.close();
      daemonClient = null;
      tuiState.dirty.add('footer');
      scheduler?.schedule();
    }
  }

  async function ensureDaemonConnected({ announce = true } = {}) {
    if (daemonClient?.connected) return true;

    // Fast probe first — if pushd is already running this stays below
    // a second and avoids an unnecessary spawn path.
    if (await tryDaemonConnect()) {
      if (announce) {
        addTranscriptEntry(
          tuiState,
          'status',
          'Connected to pushd daemon. Sessions persist in background.',
        );
      }
      // Reused a pre-existing daemon (not spawned here). If its code predates
      // the current source, self-heal (drain + respawn) or, failing that, warn.
      await assessReusedDaemon();
      return true;
    }

    if (!isTuiDaemonAutoStartEnabled(config) || daemonAutoStartAttempted) {
      return false;
    }
    daemonAutoStartAttempted = true;

    try {
      const started = await startDaemonForTui();
      if (started.ready && (await tryDaemonConnect())) {
        if (announce) {
          const verb = started.status === 'already-running' ? 'Connected to' : 'Started';
          addTranscriptEntry(
            tuiState,
            'status',
            `${verb} pushd daemon. Sessions persist in background.`,
          );
        }
        // Only the reuse path can be stale; a fresh spawn matches current
        // source by construction.
        if (started.status === 'already-running') await assessReusedDaemon();
        return true;
      }
      // Spawn succeeded but the socket never answered. Show the log
      // tail so the user can see what pushd actually wrote on its way
      // up (most common cause: a missing dep, an unhandled exception
      // in the dispatcher, or a bind failure that didn't throw at the
      // spawn level). The tail is best-effort — when the log isn't
      // readable we still print the headline.
      addTranscriptEntry(
        tuiState,
        'warning',
        `pushd ${started.status === 'started' ? 'spawned' : 'is running'} but is not responsive yet. Falling back to inline mode. Log: ${started.logPath}`,
      );
      await appendDaemonLogTail();
      return false;
    } catch (err) {
      // Classify the spawn-path exception into a structured headline
      // + actionable hint instead of dumping the raw `err.message`.
      // EACCES / EADDRINUSE / TSX_LOADER_MISSING etc. now read like
      // diagnostics instead of opaque errno codes.
      const classified = classifyDaemonSpawnError(err);
      addTranscriptEntry(tuiState, 'warning', classified.headline);
      if (classified.hint) addTranscriptEntry(tuiState, 'warning', classified.hint);
      // Even on spawn failure, a previous run's log tail may explain
      // the problem (the spawn-path exception often fires before
      // pushd writes anything, so this surfaces last-known state).
      await appendDaemonLogTail();
      return false;
    }
  }

  // Try daemon on startup; start it if TUI daemon autostart is enabled.
  await ensureDaemonConnected({ announce: true });

  const runtimeOriginWarning = getRuntimeOriginWarning(state.cwd);
  if (runtimeOriginWarning) {
    addTranscriptEntry(tuiState, 'warning', runtimeOriginWarning);
  }

  // Periodic git status refresh (every 5 seconds)
  let gitStatusInterval = setInterval(() => {
    void refreshGitStatus();
  }, 5000);

  // ── Frame ticker ────────────────────────────────────────────────
  // 10 FPS interval that drives spinner frame cycling and the
  // running-state activity row's elapsed-time update. The interval is
  // alive iff at least one consumer is active; calling refreshTicker()
  // after any state change starts or stops it as needed.
  //
  // Spinner resolution: reduced-motion → 'off', else PUSH_SPINNER /
  // config.spinner, else 'off'.
  const FRAME_FPS = 10;
  const FRAME_TICK_MS = Math.round(1000 / FRAME_FPS);
  const reducedMotion = isReducedMotion();
  let frameTick = 0;
  const spinner = { name: reducedMotion ? 'off' : (detectSpinnerName() ?? 'off') };
  let frameInterval = null;
  // Is there any on-screen consumer that cares about the next tick? Keeps
  // us from invalidating the screen 10×/s when the user has pinned a
  // spinner but isn't currently running (spinner is only painted while
  // runState === 'running' on Unicode-capable terminals). The interval
  // itself stays alive while any consumer is *eligible*, so the first
  // frame of a new run paints immediately.
  const activityRowVisible = () => tuiState.runState === 'running';
  // The spinner glyph only animates when it is actually drawn: a pinned spinner,
  // a live run, and a Unicode-capable terminal. Used to decide whether the
  // header needs repainting on a frame tick (reduced-motion / non-Unicode runs
  // animate only the footer's elapsed-time row).
  const spinnerVisible = () =>
    spinner.name !== 'off' && tuiState.runState === 'running' && theme.unicode;
  // The daemon-reconnect chip is a second animated footer consumer: while
  // the coordinator is mid-wait, the `reconnect Ns (try N)` countdown needs
  // to tick down once per second. Reusing the frame ticker is cheaper than
  // a separate interval and avoids drift between the two.
  const reconnectChipVisible = () => daemonReconnectState.phase === 'reconnecting';
  const anyConsumerVisible = () =>
    spinnerVisible() || activityRowVisible() || reconnectChipVisible();
  const anyConsumerEligible = () =>
    spinner.name !== 'off' || activityRowVisible() || reconnectChipVisible();
  // Throttle the reconnect chip's repaint to whole-second granularity.
  // The frame ticker fires at 10 FPS so spinner / activity row stay
  // smooth, but the chip displays integer seconds and dirtying the
  // footer 10×/s for an unchanged number wastes CPU during a 30s
  // backoff wait (copilot review on PR #664). Tracking the
  // last-emitted seconds value here means we only mark the footer
  // dirty when the displayed text actually changes — and -1 as the
  // sentinel guarantees the first tick after a disconnect always
  // paints once even if seconds happens to be 0.
  let lastReconnectChipSecs = -1;
  const startFrameTicker = () => {
    if (frameInterval) return;
    frameInterval = setInterval(() => {
      frameTick = (frameTick + 1) % TICK_MODULUS;
      if (anyConsumerVisible()) {
        // Reconnect chip repaints only on whole-second transitions —
        // see `lastReconnectChipSecs` comment above. Spinner /
        // activity row repaint every tick because they encode
        // sub-second motion.
        let reconnectChipNeedsPaint = false;
        if (reconnectChipVisible()) {
          const curSecs = secondsUntilNextRetry(daemonReconnectState, Date.now());
          if (curSecs !== lastReconnectChipSecs) {
            lastReconnectChipSecs = curSecs;
            reconnectChipNeedsPaint = true;
          }
        } else {
          lastReconnectChipSecs = -1;
        }
        // Dirtying 'all' made render() take the full-redraw path
        // (ESC.clearScreen + full repaint) 10×/s, flickering the whole screen
        // for the run. Scope the redraw to only the region(s) that actually
        // animate so render() stays on the partial-redraw path: the elapsed-time
        // row (footer) animates whenever a run is active; the spinner glyph
        // (header) only when it is actually drawn.
        if (spinnerVisible() || activityRowVisible() || reconnectChipNeedsPaint) {
          tuiState.dirty.add('footer');
          if (spinnerVisible()) tuiState.dirty.add('header');
          scheduler.flush();
        }
      }
    }, FRAME_TICK_MS);
    // Don't keep the Node event loop alive just for the frame ticker —
    // if the rest of the TUI tears down, this shouldn't block exit.
    if (typeof frameInterval.unref === 'function') frameInterval.unref();
  };
  const stopFrameTicker = () => {
    if (!frameInterval) return;
    clearInterval(frameInterval);
    frameInterval = null;
  };
  const refreshTicker = () => {
    if (anyConsumerEligible()) startFrameTicker();
    else stopFrameTicker();
  };
  refreshTicker();
  // Late-bind the reconnect coordinator's animator hook — now that
  // `refreshTicker` is in scope (out of the TDZ), reconnect-state
  // transitions can wake the frame ticker so the `reconnect Ns` chip
  // counts down once per second instead of freezing at its initial
  // value until the next unrelated repaint.
  invalidateReconnectAnimators = () => refreshTicker();

  // Single point that mutates runState. Manages the turn-start timestamp
  // (idle → running starts the clock; running → idle clears it; awaiting_*
  // ↔ running preserves it because a tool-approval round-trip is part of
  // the same turn) and wakes the frame ticker so the activity row can
  // update its elapsed-time display while running.
  const setRunState = (next) => {
    const prev = tuiState.runState;
    // Start the turn-clock on any leave-from-idle, not only idle → running.
    // Some paths can transition straight from idle into an awaiting_*
    // state (e.g. a user-question prompt that fires before the engine
    // enters its run loop), and we want elapsed time to count from that
    // moment so the indicator reads correctly when we eventually hit
    // 'running'.
    if (prev === 'idle' && next !== 'idle') {
      tuiState.turnStartedAt = Date.now();
    } else if (next === 'idle') {
      tuiState.turnStartedAt = null;
      // A run is no longer in flight — drop the snapshot-derived daemon cancel
      // handle so a stale id can't target a finished run.
      daemonActiveRunId = null;
    }
    tuiState.runState = next;
    // Mark footer dirty so the activity-indicator row clears or appears
    // promptly on a transition, even if the triggering event handler
    // didn't queue a footer redraw.
    tuiState.dirty.add('footer');
    refreshTicker();
  };

  // Git status will be refreshed periodically and after certain events

  // ── File awareness tracking ─────────────────────────────────────
  // TUI-local file ledger, updated from engine tool_call/tool_result events.
  const tuiFileLedger = createFileLedger();
  const pendingToolArgs = new Map(); // map toolName → args[] queue (parallel-safe)

  const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file']);

  function updateFileAwarenessFromToolEvent(toolName, args, isResult, isError) {
    if (!FILE_TOOLS.has(toolName)) return;

    const filePath = args?.path || args?.file;
    if (!filePath || typeof filePath !== 'string') return;

    if (isResult && !isError) {
      const simulatedCall = { tool: toolName };
      const simulatedResult = { ok: true, meta: { path: filePath } };

      if (toolName === 'read_file') {
        simulatedResult.meta.total_lines = 0; // triggers partial_read
      }

      updateFileLedger(tuiFileLedger, simulatedCall, simulatedResult);
      tuiState.fileAwareness = getLedgerSummary(tuiFileLedger);
      tuiState.dirty.add('footer');
    }
  }

  // ── Abort controller ─────────────────────────────────────────────

  let runAbort = null;

  // ── Enter alternate screen ───────────────────────────────────────

  io.stdout.write(
    ESC.altScreenOn + ESC.cursorHide + ESC.clearScreen + ESC.bracketedPasteOn + ESC.mouseOn,
  );

  if (io.stdin.isTTY) {
    io.stdin.setRawMode(true);
  }
  io.stdin.resume();
  io.stdin.setEncoding(null);

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
      renderFrameMeta = {
        rows,
        cols,
        layoutKey: '',
        hadOverlay: false,
        tooSmall: true,
        initialized: true,
      };
      return;
    }

    const composerLines = composer.getLines().length;
    const headerHeight = 1;
    const layoutKey = `${rows}x${cols}:${tuiState.toolPaneOpen ? 1 : 0}:${composerLines}`;
    let layout = layoutCache?.key === layoutKey ? layoutCache.layout : null;
    if (!layout) {
      layout = computeLayout(rows, cols, {
        toolPaneOpen: tuiState.toolPaneOpen,
        composerLines,
        headerHeight,
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
    const mustFullRedraw = shouldFullRedraw({
      prev: renderFrameMeta,
      rows,
      cols,
      layoutKey,
      dirtyAll: tuiState.dirty.has('all'),
      overlayActive: Boolean(overlayKind),
    });

    const renderHeaderRegion = () => {
      renderHeader(screenBuf, layout, theme, {
        provider: state.provider,
        model: state.model,
        session: state.sessionId,
        cwd: state.cwd,
        runState: tuiState.runState,
        branch,
        spinner: { name: spinner.name, tick: frameTick },
        activity: tuiState.activity,
      });
      // No divider under the header — the gap row above the transcript
      // is enough visual separation; the line is what makes the screen
      // feel busy.
    };

    const renderFooterRegion = () => {
      const isStreaming = tuiState.runState === 'running' && tuiState.streamBuf.length > 0;
      // The canonical transcript in state.messages is append-only — the
      // engine never mutates it during distillation. The actual prompt
      // sent to the provider is the per-hop post-transform view, which
      // the engine writes into state.lastPromptTokens after each round.
      // Fall back to estimating from the full transcript only when no
      // round has run yet (fresh session).
      const lastPromptTokens =
        typeof state.lastPromptTokens === 'number' ? state.lastPromptTokens : null;
      const tokens = lastPromptTokens ?? estimateContextTokens(state.messages || []);
      const budget = getContextBudget(state.provider, state.model);
      // Persistent chip — read live so a reconnect/disconnect that
      // already marked the footer dirty renders the new state. While
      // the coordinator is mid-retry we expose the live attempt count
      // and countdown so the user can see we're working on it.
      const connected = Boolean(daemonClient?.connected);
      const reconnecting = !connected && daemonReconnectState.phase === 'reconnecting';
      const daemonStatus = connected
        ? { connected: true, phase: 'connected' as const, reconnect: null }
        : reconnecting
          ? {
              connected: false,
              phase: 'reconnecting' as const,
              reconnect: {
                attempt: daemonReconnectState.attempts + 1,
                secondsUntilNextRetry: secondsUntilNextRetry(daemonReconnectState, Date.now()),
              },
            }
          : { connected: false, phase: 'inline' as const, reconnect: null };

      renderStatusBar(screenBuf, layout, theme, {
        gitStatus: tuiState.gitStatus,
        cwd: state.cwd,
        tokens,
        isStreaming,
        messageCount: state.messages?.length || 0,
        contextBudget: budget,
        fileAwareness: tuiState.fileAwareness,
        daemonStatus,
      });
      tuiState.session = state.sessionId;
      renderKeybindHints(screenBuf, layout, theme, tuiState);
      renderActivityIndicator(screenBuf, layout, theme, tuiState, tokens, state.sessionId);
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
        tuiState.approvalPane?.render(screenBuf, rows, cols, theme);
        break;
      case 'question':
        renderQuestionModal(screenBuf, theme, rows, cols, tuiState.userQuestion, questionInputBuf);
        break;
      case 'reasoning':
        renderReasoningModal(screenBuf, theme, rows, cols, tuiState);
        break;
      case 'provider':
        renderProviderModal(
          screenBuf,
          theme,
          rows,
          cols,
          state.provider,
          state.model,
          tuiState.providerModalCursor,
        );
        break;
      case 'resume':
        if (tuiState.resumeModalState) {
          renderResumeModal(
            screenBuf,
            theme,
            rows,
            cols,
            tuiState.resumeModalState,
            state.sessionId,
          );
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

  // Visible-emission counter for the active run. Reset at `runPrompt()` start.
  // Incremented whenever an engine event causes a transcript-length delta,
  // so `run_complete` can detect a fully silent run (no text, no tool calls,
  // no status/warning/error entries) and surface a diagnostic instead of
  // rendering nothing. Silent runs are a known failure mode when the CLI
  // tool-call parser drops a malformed fenced tool call before either the
  // assistant prose or `tool.call_malformed` events can reach the transcript
  // — see docs/decisions/Tool-Call Parser Convergence Gap.md.
  let runVisibleEmissionCount = 0;
  const renderDelegationEvent = createDelegationTranscriptRenderer();

  function flushPendingAssistantStream() {
    if (!tuiState.streamBuf) return;
    addTranscriptEntry(tuiState, 'assistant', tuiState.streamBuf);
    tuiState.streamBuf = '';
  }

  // Rebuild the daemon-mode transcript from the daemon's persisted
  // `state.messages` after a transcript-mutation event (revert / unrevert /
  // summarize) tells us the local copy is stale. The daemon's
  // `get_session_messages` returns the user/assistant history only, so the
  // rebuilt view drops this session's tool-call / status decoration — the same
  // fidelity the web shows on attach-time hydration, and consistent across
  // surfaces by construction. Bearer-gated like every session-ful verb. A
  // failed/empty fetch leaves the existing transcript untouched (and logs)
  // rather than blanking it. `triggerType` is the event that prompted the
  // resync, surfaced in the status line so the user knows the history changed
  // under them rather than seeing it silently rewritten.
  function resyncDaemonTranscript(triggerType, payload = null) {
    if (!daemonClient?.connected || !daemonSessionId) return;
    daemonClient
      .request(
        'get_session_messages',
        { sessionId: daemonSessionId, attachToken: daemonAttachToken },
        daemonSessionId,
      )
      .then((res) => {
        if (!res.ok || !Array.isArray(res.payload?.messages)) {
          // Symmetric structured log — a resync miss must be distinguishable
          // from "still in sync" for ops; the transcript stays as-is.
          io.stderr.write(
            `${JSON.stringify({ level: 'warn', event: 'tui_transcript_resync_failed', triggerType, reason: res.ok ? 'no_messages' : res.error?.code || 'request_failed' })}\n`,
          );
          return;
        }
        // Replace in place so the array reference (and MAX_TRANSCRIPT splice
        // invariant) is preserved. Drop any half-streamed buffer so a rebuild
        // mid-stream doesn't strand a partial assistant line.
        tuiState.streamBuf = '';
        tuiState.transcript.length = 0;
        for (const msg of res.payload.messages) {
          if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
          pushTranscriptEntry(
            tuiState,
            {
              role: msg.role,
              text: typeof msg.content === 'string' ? msg.content : '',
              timestamp: Date.now(),
            },
            { autoScroll: false },
          );
        }
        // Enrich the status with the counts the daemon already put in the
        // event payload, so a TUI-initiated verb (and a phone-initiated one
        // this client merely observes) both report specifics rather than a
        // bare "resynced". Fields degrade to a plain label when absent.
        const p = payload && typeof payload === 'object' ? payload : {};
        let label;
        if (triggerType === 'session_reverted') {
          const detail =
            typeof p.removedCount === 'number'
              ? ` (${p.turns ?? '?'} turn(s), ${p.removedCount} message(s) dropped${
                  typeof p.remainingTurns === 'number' ? `, ${p.remainingTurns} remaining` : ''
                })`
              : '';
          label = `Conversation reverted on the daemon${detail} — transcript resynced. /unrevert to restore.`;
        } else if (triggerType === 'session_unreverted') {
          const detail =
            typeof p.restoredCount === 'number' ? ` (${p.restoredCount} message(s) restored)` : '';
          label = `Conversation restored on the daemon${detail} — transcript resynced.`;
        } else {
          const detail =
            typeof p.beforeTokens === 'number' && typeof p.afterTokens === 'number'
              ? ` (~${p.beforeTokens} -> ~${p.afterTokens} tokens)`
              : '';
          label = `Conversation compacted on the daemon${detail} — transcript resynced.`;
        }
        addTranscriptEntry(tuiState, 'status', label);
        tuiState.dirty.add('all');
        scheduler.schedule();
      })
      .catch((err) => {
        const reason = err instanceof Error ? err.message : String(err);
        io.stderr.write(
          `${JSON.stringify({ level: 'warn', event: 'tui_transcript_resync_failed', triggerType, reason })}\n`,
        );
      });
  }

  function handleEngineEvent(event) {
    // Track the highest daemon-emitted seq we've seen so the next
    // attach (after a disconnect / reconnect) asks for events strictly
    // after this point. Inline events have no `seq` field; daemon
    // events always do. See `lastSeenDaemonSeq` declaration above for
    // why this isn't `state.eventSeq`.
    if (typeof event.seq === 'number' && event.seq > lastSeenDaemonSeq) {
      lastSeenDaemonSeq = event.seq;
    }
    const transcriptLenBefore = tuiState.transcript.length;
    const streamBufBefore = tuiState.streamBuf;
    const reasoningBufBefore = tuiState.reasoningBuf;
    switch (event.type) {
      case 'assistant_thinking_token':
        if (!tuiState.reasoningStreaming) {
          thinkingPhaseStart = tuiState.reasoningBuf.length; // mark start of this chunk
        }
        tuiState.reasoningBuf += event.payload.text;
        tuiState.reasoningStreaming = true;
        if (tuiState.activity?.kind !== 'thinking') {
          tuiState.activity = { kind: 'thinking' };
          tuiState.dirty.add('header');
        }
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
        if (tuiState.activity?.kind !== 'streaming') {
          tuiState.activity = { kind: 'streaming' };
          tuiState.dirty.add('header');
        }
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

      case 'assistant_citations': {
        // Native web-search sources. Dispatched after `assistant_done`, so the
        // assistant entry is already committed and this renders directly below
        // it as a `sources` transcript entry (see sourcesFramer).
        const citations = event.payload?.citations ?? [];
        if (Array.isArray(citations) && citations.length > 0) {
          pushTranscriptEntry(tuiState, { role: 'sources', citations, timestamp: Date.now() });
        }
        scheduler.schedule();
        break;
      }

      case 'tool_call':
      case 'tool.execution_start': {
        const argsQueue = pendingToolArgs.get(event.payload.toolName) || [];
        argsQueue.push(event.payload.args);
        pendingToolArgs.set(event.payload.toolName, argsQueue);
        addToolFeedEntry(tuiState, {
          type: 'call',
          name: event.payload.toolName,
          args: event.payload.args,
        });
        pushTranscriptEntry(tuiState, {
          role: 'tool_call',
          text: event.payload.toolName,
          args: event.payload.args,
          error: false,
          timestamp: Date.now(),
        });
        tuiState.activity = { kind: 'tool', toolName: event.payload.toolName };
        tuiState.dirty.add('header');
        scheduler.schedule();
        break;
      }

      case 'tool_result':
      case 'tool.execution_complete': {
        const isError = event.payload.isError;
        const text = event.payload.text || event.payload.preview || '';
        tuiState.lastToolResult = { name: event.payload.toolName, text, isError };
        addToolFeedEntry(tuiState, {
          type: 'result',
          name: event.payload.toolName,
          duration: event.payload.durationMs,
          error: isError,
          preview: text.slice(0, 100),
        });
        // Track file awareness — shift args from the per-tool queue (parallel-safe)
        const resultArgsQueue = pendingToolArgs.get(event.payload.toolName);
        const matchedArgs = resultArgsQueue?.shift() ?? null;
        if (resultArgsQueue && resultArgsQueue.length === 0)
          pendingToolArgs.delete(event.payload.toolName);
        updateFileAwarenessFromToolEvent(event.payload.toolName, matchedArgs, true, isError);
        // Update the last tool_call transcript entry with result info and preview
        let updatedTranscriptToolCall = false;
        for (let i = tuiState.transcript.length - 1; i >= 0; i--) {
          const candidate = tuiState.transcript[i];
          if (candidate.role === 'tool_call' && candidate.text === event.payload.toolName) {
            candidate.error = isError;
            candidate.duration = event.payload.durationMs;
            candidate.resultPreview = text.slice(0, 200);
            // Structured edit diff (edit_file / write_file) — rendered as an
            // edit card by the tool_call framer instead of the preview line.
            if (isEditDiff(event.payload.diff)) candidate.editDiff = event.payload.diff;
            // This entry was framed before its result landed; drop its cached
            // frame so the reconciler reframes it (the identity-keyed cache
            // can't observe an in-place edit). This is the one sanctioned
            // mutation of a committed entry — see tui-transcript-cache.ts.
            tuiState.entryRenderCache.delete(candidate);
            updatedTranscriptToolCall = true;
            break;
          }
        }
        if (updatedTranscriptToolCall) {
          tuiState.dirty.add('transcript');
        }
        // Tool finished — model resumes reasoning. The next assistant_*
        // event will overwrite this; we set 'thinking' here so the gap
        // between tool result and the next reasoning token doesn't show
        // a stale tool verb.
        if (tuiState.activity?.kind !== 'thinking') {
          tuiState.activity = { kind: 'thinking' };
          tuiState.dirty.add('header');
        }
        scheduler.schedule();
        // Refresh git status after file-modifying operations
        if (
          !isError &&
          ['write_file', 'edit_file', 'git_commit', 'exec'].includes(event.payload.toolName)
        ) {
          setTimeout(() => refreshGitStatus(), 300);
        }
        break;
      }

      case 'status':
        addTranscriptEntry(tuiState, 'status', event.payload.detail || event.payload.phase);
        scheduler.schedule();
        break;

      case 'tool.call_malformed':
        addTranscriptEntry(tuiState, 'warning', `Malformed tool call: ${event.payload.reason}`);
        scheduler.schedule();
        break;

      case 'warning':
        addTranscriptEntry(tuiState, 'warning', event.payload.message || event.payload.code);
        scheduler.schedule();
        break;

      case 'error':
        // Preserve any partial streamed assistant text/tool-call JSON before
        // logging the provider/tool error, so failures do not look blank.
        flushPendingAssistantStream();
        addTranscriptEntry(tuiState, 'error', event.payload.message);
        scheduler.schedule();
        break;

      case 'approval_required':
        // Daemon mode: show approval modal and send decision back
        if (daemonClient?.connected && event.payload?.approvalId) {
          const approvalId = event.payload.approvalId;
          setRunState('awaiting_approval');
          openApprovalPane({
            kind: event.payload.kind || 'action',
            summary: event.payload.summary || event.payload.title,
            patternIndex: -1,
            suggestedPrefix: null,
            daemonApprovalId: approvalId,
          });
          approvalResolve = (approved) => {
            daemonClient
              ?.request(
                'submit_approval',
                {
                  sessionId: daemonSessionId,
                  approvalId,
                  decision: approved ? 'approve' : 'deny',
                  // Bearer required since submit_approval is now session-gated
                  // (matches cancel_run). Without this the daemon rejects the
                  // decision with INVALID_TOKEN.
                  attachToken: daemonAttachToken,
                },
                daemonSessionId,
              )
              .catch(() => {});
          };
          tuiState.dirty.add('all');
          scheduler.flush();
        }
        break;

      case 'session_state_changed':
        // Daemon broadcasts this after `update_session` /
        // `configure_role_routing` mutates session-scoped state. Mirror
        // the change into the local view so the footer + next inline
        // fallback stay consistent with daemon truth (and so another
        // client switching provider/model is visible here without
        // polling).
        hydrateSessionStateFromDaemon(event.payload);
        break;

      case 'context_compacted':
      case 'session_reverted':
      case 'session_unreverted':
        // Another client (or this one via a session verb) rewrote the
        // daemon's persisted transcript. Refetch it so the local view stops
        // showing turns the daemon dropped / summarized away. The event
        // payload carries only metadata (counts / a summary marker), not the
        // new transcript, so a refetch is the only way to converge — see
        // lib/session-transcript-events.ts. The payload carries the counts the
        // resync surfaces in its status line.
        resyncDaemonTranscript(event.type, event.payload);
        break;

      case 'approval_received':
        // Daemon mode: approval was processed, resume display
        if (tuiState.runState === 'awaiting_approval') {
          setRunState('running');
          closeApprovalPane();
          approvalResolve = null;
          tuiState.dirty.add('all');
          scheduler.schedule();
        }
        break;

      case 'run_complete': {
        setRunState('idle');
        tuiState.activity = null;
        tuiState.dirty.add('header');
        // assistant_done normally flushes the stream; this is a fallback for
        // failed/aborted runs that ended after partial output.
        flushPendingAssistantStream();
        tuiState.reasoningStreaming = false;
        if (tuiState.reasoningBuf.trim()) {
          tuiState.lastReasoning = tuiState.reasoningBuf;
        }
        // Layer 3 safety net for the tool-call parser convergence gap:
        // if the run produced zero visible output (no streamed prose, no
        // tool calls, no status/warning/error entries), the TUI would
        // otherwise render nothing and the user would see silence. The
        // most common cause is the CLI's `detectAllToolCalls` silently
        // dropping a malformed fenced tool call emitted by a model that
        // knows tool-call *shape* but omits the opening fence. Surface a
        // diagnostic so "empty transcript on daemon" stops being invisible.
        // See docs/decisions/Tool-Call Parser Convergence Gap.md.
        if (runVisibleEmissionCount === 0) {
          addTranscriptEntry(
            tuiState,
            'warning',
            'Assistant response was empty — no text, tool calls, or status events. ' +
              'This can happen when the model emits a malformed fenced tool call ' +
              'that the CLI parser silently drops. See ' +
              'docs/decisions/Tool-Call Parser Convergence Gap.md.',
          );
        }
        runVisibleEmissionCount = 0;
        tuiState.dirty.add('all');
        io.stdout.write('\x07'); // bell
        scheduler.schedule();
        break;
      }

      default:
        // Delegation lifecycle events (`subagent.*`, `task_graph.*`) are
        // routed through a single renderer so the list of handled types lives
        // in one place (cli/tui-delegation-events.ts). The renderer is
        // transcript-compatible but stateful for task graph node-focus views.
        if (isDelegationEvent(event)) {
          const entry = renderDelegationEvent(event);
          if (entry) {
            addTranscriptEntry(tuiState, entry.role, entry.text);
            scheduler.schedule();
          }
        } else if (shouldWarnAboutUnknownEvent(unknownEventWarnedTypes, event.type)) {
          // Anything that isn't an explicit case, isn't a delegation
          // event, and isn't on the known-noop allowlist
          // (`TUI_KNOWN_NOOP_EVENT_TYPES`) is real protocol drift —
          // typically a newer daemon emitting a new event family the
          // TUI doesn't know about. Surface it once per type so the
          // user (and ops) see the drift the first time it happens
          // instead of getting a silent drop forever.
          addTranscriptEntry(tuiState, 'warning', formatUnknownEventWarning(event.type));
          scheduler.schedule();
        }
        break;
    }

    // Track whether this event produced user-visible output for the current
    // run. A transcript-length delta captures every case that calls
    // `addTranscriptEntry` / `pushTranscriptEntry` (assistant text,
    // tool_call, tool.call_malformed, status, warning, error, delegation
    // entries). A streamBuf delta captures partial prose that has not yet
    // been flushed to the transcript — we still count the run as having
    // produced output, so a later flush on `run_complete` does not
    // double-count. A reasoningBuf delta captures thinking tokens
    // streamed before any `assistant_thinking_done` — a run that only
    // streams reasoning (model thinking but no final answer) should
    // NOT trigger the empty-run diagnostic, because the user saw live
    // thinking output in the footer / reasoning modal. See the
    // comment on `runVisibleEmissionCount`.
    if (
      tuiState.transcript.length > transcriptLenBefore ||
      (streamBufBefore === '' && tuiState.streamBuf !== '') ||
      (reasoningBufBefore === '' && tuiState.reasoningBuf !== '')
    ) {
      runVisibleEmissionCount += 1;
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
    return (question, choices) =>
      new Promise((resolve) => {
        questionInputBuf = '';
        questionResolve = resolve;
        setRunState('awaiting_user_question');
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
      setRunState('running');
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
      setRunState('running');
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
    if (
      key.sequence &&
      !key.ctrl &&
      !key.meta &&
      key.sequence.length === 1 &&
      key.sequence.charCodeAt(0) >= 32
    ) {
      questionInputBuf += key.sequence;
      tuiState.dirty.add('all');
      scheduler.schedule();
    }
  }

  function makeApprovalFn() {
    return (tool, detail) => {
      const patternIndex = matchingRiskPatternIndex(detail);
      const suggestedPrefix = suggestApprovalPrefix(detail);

      // Session trust: auto-approve if this risk pattern was previously trusted
      if (patternIndex >= 0 && trustedPatterns.has(patternIndex)) {
        addTranscriptEntry(tuiState, 'status', `[auto-approved] ${tool}: ${detail}`);
        scheduler.schedule();
        return Promise.resolve(true);
      }

      return new Promise((resolve) => {
        setRunState('awaiting_approval');
        openApprovalPane({ kind: tool, summary: detail, patternIndex, suggestedPrefix });
        approvalResolve = resolve;
        tuiState.dirty.add('all');
        scheduler.flush();
      });
    };
  }

  // ── Skills ────────────────────────────────────────────────────────

  // Skill-lint diagnostics for the current workspace, collected on every (re)load so a malformed
  // skill file no longer silently vanishes. Unlike the line-based REPL, the TUI does NOT write these
  // to stderr: `/skills reload` runs while the TUI owns the alternate screen, and stderr to a TTY
  // isn't isolated from it — structured JSON would render directly over the live UI. Diagnostics are
  // surfaced in-app instead, via the `/skills` listing footer and `/skills lint`.
  let skillDiagnostics: SkillDiagnostic[] = [];
  const skills = await loadSkills(state.cwd, { diagnostics: skillDiagnostics });
  // Sibling map filtered for the current environment — feeds the completer so hidden
  // skills don't tab-complete. Dispatch still uses the full `skills` map.
  const skillFilterEnv = {
    platform: getCurrentSkillPlatform(),
    availableCapabilities: new Set(ALL_CAPABILITIES),
  };
  const visibleSkills = filterSkillsForEnvironment(skills, skillFilterEnv);
  function rebuildVisibleSkills() {
    const fresh = filterSkillsForEnvironment(skills, skillFilterEnv);
    visibleSkills.clear();
    for (const [name, skill] of fresh) {
      visibleSkills.set(name, skill);
    }
  }

  async function reloadSkillsMap() {
    const freshDiagnostics: SkillDiagnostic[] = [];
    const fresh = await loadSkills(state.cwd, { diagnostics: freshDiagnostics });
    skills.clear();
    for (const [name, skill] of fresh) {
      skills.set(name, skill);
    }
    skillDiagnostics = freshDiagnostics;
    rebuildVisibleSkills();
    tabCompleter.reset();
    return skills.size;
  }

  function createCurrentTabCompleter() {
    return createTabCompleter({
      ctx,
      skills: visibleSkills,
      getCuratedModels,
      getProviderList,
      workspaceRoot: state.cwd,
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
    setRunState('running');
    tuiState.reasoningBuf = '';
    tuiState.reasoningStreaming = false;
    // Reset visible-emission counter so the run_complete safety net can
    // detect a fully silent run (see docs/decisions/Tool-Call Parser Convergence Gap.md).
    runVisibleEmissionCount = 0;
    tuiState.dirty.add('all');
    scheduler.flush();

    // ── Stale-daemon refresh in flight: pause new runs ──
    // A drain is underway (an in-flight run is finishing on the old daemon
    // before it refreshes). Starting a run now would land on stale code, so
    // hold it. The daemon also rejects with DAEMON_DRAINING as a backstop.
    if (daemonStale) {
      addTranscriptEntry(
        tuiState,
        'warning',
        'The pushd daemon is refreshing to current code; new runs are paused. Resend in a moment, once the fresh daemon is ready.',
      );
      setRunState('idle');
      tuiState.activity = null;
      tuiState.dirty.add('all');
      scheduler.flush();
      return;
    }

    // ── Daemon mode: delegate to pushd over socket ──
    if (daemonClient?.connected) {
      await ensureDaemonSession();
      if (daemonClient?.connected && daemonSessionId) {
        runAbort = new AbortController();
        try {
          // Register listener BEFORE sending the request to avoid missing
          // a fast run_complete that arrives before the listener is attached.
          let runId = null;
          const completionPromise = new Promise((resolve) => {
            const unsub = daemonClient.onEvent((event) => {
              // Filter by sessionId; also by runId once known
              if (event.sessionId !== daemonSessionId) return;
              if (runId && event.runId && event.runId !== runId) return;
              if (event.type === 'run_complete') {
                unsub();
                resolve();
              }
            });
            // On user-initiated abort (Ctrl+C), cancel the daemon run.
            // On TUI exit/teardown, just detach — let the run continue.
            runAbort.signal.addEventListener(
              'abort',
              () => {
                if (runAbort?._userInitiated) {
                  daemonClient
                    ?.request(
                      'cancel_run',
                      {
                        sessionId: daemonSessionId,
                        runId,
                        // Bearer required since cancel_run gates the session-ful
                        // path (Addressable Session Verbs phase 2). Without this
                        // the daemon rejects the cancel with INVALID_TOKEN.
                        attachToken: daemonAttachToken,
                      },
                      daemonSessionId,
                    )
                    .catch(() => {});
                }
                unsub();
                resolve();
              },
              { once: true },
            );
          });

          const res = await daemonClient.request(
            'send_user_message',
            {
              sessionId: daemonSessionId,
              text,
              attachToken: daemonAttachToken,
              capabilities: [...TUI_DAEMON_CAPABILITIES],
              // Provider/model intentionally omitted — the daemon owns
              // session-scoped state. Mid-session switches route through
              // `update_session` in switchModel/switchProvider.
            },
            daemonSessionId,
          );
          if (!res.ok) {
            addTranscriptEntry(tuiState, 'error', res.error?.message || 'Daemon rejected message');
          } else {
            runId = res.payload?.runId;
          }

          await completionPromise;
        } catch (err) {
          if (err.name !== 'AbortError') {
            addTranscriptEntry(tuiState, 'error', `Daemon error: ${err.message}`);
          }
        } finally {
          setRunState('idle');
          tuiState.activity = null;
          runAbort = null;
          tuiState.dirty.add('all');
          scheduler.flush();
        }
        return;
      }
      // Fall through to inline mode if daemon session failed
    }

    // ── Inline mode: run engine directly ──
    await ensureSessionPersisted();
    await appendUserMessageWithFileReferences(state, text, state.cwd, {
      referenceSourceText: options.referenceSourceText,
    });
    await appendSessionEvent(state, 'user_message', {
      chars: text.length,
      preview: text.slice(0, 280),
    });

    runAbort = new AbortController();

    try {
      // runAssistantTurn runs the single conversational lead in-loop by
      // default (Agent Runtime Decisions §10) — no planner pre-pass. With
      // PUSH_DELEGATION_MODE=delegated it plans first: null/1-feature plans
      // fall back to the single-agent loop on the already-appended user
      // message; 2+-feature plans execute as a task graph and emit canonical
      // subagent.*/task_graph.* events handled by handleEngineEvent.
      await runAssistantTurn(state, ctx.providerConfig, ctx.apiKey, text, maxRounds, {
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
      setRunState('idle');
      tuiState.activity = null;
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
      // Clamp mirrors the daemon's own cap (session_summarize:
      // parsePositiveIntField(preserveTurns, 6, 64)); the client bound is a UX
      // hint, the daemon enforces.
      preserveTurns = Math.max(1, Math.min(64, Number.parseInt(arg, 10)));
    }

    // Daemon mode: the daemon owns the authoritative transcript (this client's
    // `state.messages` is never appended to over the socket — see the
    // send_user_message path), so compacting the local mirror is a no-op that
    // the next resync would overwrite. Route to the bearer-gated
    // `session_summarize` verb instead. The `context_compacted` broadcast it
    // emits drives `resyncDaemonTranscript`, which renders the success status;
    // we only surface the no-op / error outcomes here (they emit no broadcast).
    if (await ensureDaemonSessionReady()) {
      // A successful compaction converges via the `context_compacted` broadcast
      // → resync; only the ok-but-no-op outcome is surfaced here. Error
      // envelopes (RUN_IN_PROGRESS, etc.) reject into catch.
      try {
        const res = await sendDaemonSessionVerb('session_summarize', { preserveTurns });
        if (res?.payload?.compacted === false) {
          addTranscriptEntry(
            tuiState,
            'status',
            `Nothing to compact (turns: ${res.payload?.totalTurns ?? '?'}, preserve: ${
              res.payload?.preserveTurns ?? preserveTurns
            }).`,
          );
        }
      } catch (err) {
        addTranscriptEntry(
          tuiState,
          'error',
          `Summarize failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      scheduler.flush();
      return;
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
    // Force a log rewrite — /compact is a wholesale replacement and
    // can produce same-length output (drop one, insert digest) that
    // saveSessionState's length-only fast path would skip.
    await rewriteMessagesLog(state);

    addTranscriptEntry(
      tuiState,
      'status',
      `Compacted context: ${result.compactedCount} messages -> 1 summary (kept last ${result.preserveTurns} turns, ~${result.beforeTokens} -> ~${result.afterTokens} tokens).`,
    );
    scheduler.flush();
  }

  // Send a bearer-gated session verb to the daemon for the current session.
  // Returns the response envelope, or `null` when there is no daemon session
  // (the caller prints mode-specific guidance). `sessionId` + `attachToken` are
  // attached uniformly — every session-ful daemon verb requires both.
  async function sendDaemonSessionVerb(type, extraPayload = {}) {
    if (!daemonClient?.connected || !daemonSessionId) return null;
    return daemonClient.request(
      type,
      { sessionId: daemonSessionId, attachToken: daemonAttachToken, ...extraPayload },
      daemonSessionId,
    );
  }

  // True when a daemon-backed session is available to address. The session id is
  // populated lazily — a fresh connect (e.g. after /resume) has `daemonClient`
  // connected but `daemonSessionId` still null until the first send. The
  // session-verb commands need it eagerly, so attach/start here the same way the
  // send path does (`ensureDaemonSession` is a no-op once the id is set).
  async function ensureDaemonSessionReady() {
    if (!daemonClient?.connected) return false;
    if (!daemonSessionId) await ensureDaemonSession();
    return Boolean(daemonSessionId);
  }

  // `/revert [n]` — undo the last N user turns on the daemon (default 1).
  // Transcript-only; sandbox/git state is untouched (use the typed branch tools
  // for code rollback). Success converges via the `session_reverted` broadcast →
  // `resyncDaemonTranscript`; only the no-op / error outcomes are surfaced here.
  async function revertDaemonSession(rawArg) {
    const arg = String(rawArg || '').trim();
    let turns = 1;
    if (arg) {
      if (!/^\d+$/.test(arg)) {
        addTranscriptEntry(tuiState, 'warning', 'Usage: /revert [turns] (positive integer)');
        scheduler.flush();
        return;
      }
      // Clamp mirrors the daemon's own cap (session_revert:
      // parsePositiveIntField(turns, 1, 1024)) — higher than /compact's 64
      // because turns-to-revert and turns-to-preserve are different limits.
      turns = Math.max(1, Math.min(1024, Number.parseInt(arg, 10)));
    }
    if (!(await ensureDaemonSessionReady())) {
      addTranscriptEntry(
        tuiState,
        'warning',
        '/revert needs a daemon session. Use /checkpoint for local rollback.',
      );
      scheduler.flush();
      return;
    }
    // `request()` rejects on an error envelope (RUN_IN_PROGRESS, etc.) — those
    // land in catch. A successful revert (reverted:true) converges via the
    // `session_reverted` broadcast → resync, so only the ok-but-no-op outcome
    // (no user turns) is surfaced here.
    try {
      const res = await sendDaemonSessionVerb('session_revert', { turns });
      if (res?.payload?.reverted === false) {
        addTranscriptEntry(tuiState, 'status', 'Nothing to revert (no user turns yet).');
      }
    } catch (err) {
      addTranscriptEntry(
        tuiState,
        'error',
        `Revert failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    scheduler.flush();
  }

  // `/unrevert` — restore the messages dropped by the most recent run of
  // /revert(s). Fails if a new message already committed the fork. Success
  // converges via the `session_unreverted` broadcast → `resyncDaemonTranscript`.
  async function unrevertDaemonSession() {
    if (!(await ensureDaemonSessionReady())) {
      addTranscriptEntry(tuiState, 'warning', '/unrevert needs a daemon session.');
      scheduler.flush();
      return;
    }
    // Success converges via the `session_unreverted` broadcast → resync. The
    // daemon rejects with NOTHING_TO_UNREVERT when no revert is pending (a new
    // message committed the fork) — that's an expected outcome, not an error,
    // so it renders as a status; every other rejection is a real error.
    try {
      await sendDaemonSessionVerb('session_unrevert', {});
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? (err as { code?: unknown }).code
          : undefined;
      addTranscriptEntry(
        tuiState,
        code === 'NOTHING_TO_UNREVERT' ? 'status' : 'error',
        err instanceof Error ? err.message : String(err),
      );
    }
    scheduler.flush();
  }

  // `/children` — list delegated child runs for the current daemon session;
  // `/children <subagentId>` inspects one (descriptor + event summary). Pure
  // read verbs, so the result is rendered directly (no broadcast / resync).
  async function inspectDaemonChildren(rawArg) {
    const arg = String(rawArg || '').trim();
    if (!(await ensureDaemonSessionReady())) {
      addTranscriptEntry(
        tuiState,
        'warning',
        '/children needs a daemon session (delegations route through pushd).',
      );
      scheduler.flush();
      return;
    }
    // Pure reads: render the result directly (no broadcast / resync). An error
    // envelope (CHILD_NOT_FOUND, etc.) rejects into catch.
    try {
      if (arg) {
        const res = await sendDaemonSessionVerb('get_child_session', { subagentId: arg });
        const c = res?.payload?.child || {};
        const ev = res?.payload?.eventSummary || {};
        const lines = [
          `child ${c.subagentId ?? '?'} — ${c.agent || 'subagent'} (${c.status || '?'})`,
        ];
        // typeof-string guards (not just truthy) — these fields are untyped
        // across the daemon↔TUI seam (finding #7), so a non-string drift value
        // would reach .slice and throw rather than degrade gracefully.
        if (typeof c.task === 'string') lines.push(`  task: ${c.task.slice(0, 200)}`);
        if (c.outcomeStatus) lines.push(`  outcome: ${c.outcomeStatus}`);
        if (typeof c.summary === 'string') lines.push(`  summary: ${c.summary.slice(0, 200)}`);
        if (typeof c.rounds === 'number') lines.push(`  rounds: ${c.rounds}`);
        if (c.terminalType) lines.push(`  terminal: ${c.terminalType}`);
        lines.push(
          `  events: ${ev.eventCount ?? 0} (seq ${ev.firstSeq ?? '-'}..${ev.lastSeq ?? '-'})`,
        );
        addTranscriptEntry(tuiState, 'status', lines.join('\n'));
      } else {
        const res = await sendDaemonSessionVerb('list_children', { includeEventDerived: true });
        const children = Array.isArray(res?.payload?.children) ? res.payload.children : [];
        if (children.length === 0) {
          addTranscriptEntry(tuiState, 'status', 'No delegated children for this session.');
        } else {
          const lines = [
            `Children: ${children.length} (${res.payload?.activeCount ?? 0} active, ${
              res.payload?.completedCount ?? 0
            } completed)`,
          ];
          for (const c of children) {
            const tag = c.outcomeStatus ? `${c.status}/${c.outcomeStatus}` : c.status;
            const task = typeof c.task === 'string' ? ` — ${c.task.slice(0, 60)}` : '';
            lines.push(`  ${c.subagentId ?? '?'}  [${c.agent || 'subagent'} ${tag}]${task}`);
          }
          lines.push('Inspect one with /children <subagentId>.');
          addTranscriptEntry(tuiState, 'status', lines.join('\n'));
        }
      }
    } catch (err) {
      addTranscriptEntry(
        tuiState,
        'error',
        `Children query failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    scheduler.flush();
  }

  async function renameCurrentSession(rawName) {
    const trimmed = typeof rawName === 'string' ? rawName.trim() : '';
    if (!trimmed) {
      addTranscriptEntry(
        tuiState,
        'warning',
        'Usage: /session rename <name> | /session rename --clear',
      );
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

  // TUI renderer: route every channel through the transcript and flush
  // the scheduler once per message so output appears immediately. Bold/dim
  // are no-ops because the transcript renderer strips ANSI styling and
  // wrapping the text would just look like noise.
  const tuiCheckpointRenderer = {
    status: (text) => {
      addTranscriptEntry(tuiState, 'status', text);
      scheduler.flush();
    },
    warning: (text) => {
      addTranscriptEntry(tuiState, 'warning', text);
      scheduler.flush();
    },
    error: (text) => {
      addTranscriptEntry(tuiState, 'error', `checkpoint: ${text}`);
      scheduler.flush();
    },
    bold: (text) => text,
    dim: (text) => text,
    // Backtick-wrap command-formatted tokens so they stay visually
    // distinct in the transcript even though styling is stripped. This
    // restores the explicit backticks the original TUI handler used
    // around `push resume <id>` before the shared dispatcher.
    code: (text) => `\`${text}\``,
  };

  async function handleCheckpointCommand(rawArg) {
    await runCheckpointCommand(
      rawArg,
      {
        workspaceRoot: state.cwd,
        sessionId: state.sessionId,
        messages: state.messages,
        provider: state.provider,
        model: state.model,
      },
      tuiCheckpointRenderer,
    );
  }

  function resetTUIViewForSessionChange() {
    setRunState('idle');
    tuiState.activity = null;
    tuiState.streamBuf = '';
    closeApprovalPane();
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
    tuiState.entryRenderCache = new WeakMap();
    tuiState.streamFrameState = null;
    tuiState.toolFeed = [];
    tuiState.scrollOffset = 0;
    tuiState.fileAwareness = null;
    tuiFileLedger.files = {};
    pendingToolArgs.clear();
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
      addTranscriptEntry(
        tuiState,
        'warning',
        'Cannot resume another session while a run is active.',
      );
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
      addTranscriptEntry(
        tuiState,
        'error',
        `Failed to load session ${targetSessionId}: ${formatError(err)}`,
      );
      scheduler.flush();
      return false;
    }

    const nextProviderConfig = PROVIDER_CONFIGS[nextState.provider];
    if (!nextProviderConfig) {
      addTranscriptEntry(
        tuiState,
        'error',
        `Cannot resume ${targetSessionId}: unknown provider "${nextState.provider}".`,
      );
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
      mode: 'list', // 'list', 'rename', 'filter'
      scope: 'workspace', // 'workspace' (cwd-matched) | 'all'
      scopedOutCount: 0,
      renameTargetId: null,
      renameBuf: '',
      renameCursor: 0,
      filterBuf: '',
      filterCursor: 0,
      preview: null, // { messages: [], loading }
    };
    tuiState.dirty.add('all');
    scheduler.flush();

    try {
      const rows = await listSessions();
      // Default to the active workspace's sessions — the REPL picker has
      // always cwd-scoped, but this modal listed every workspace and the
      // current project's sessions drowned in unrelated history. Fall back
      // to 'all' when the workspace has none, so the picker is never
      // mysteriously empty. `a` toggles.
      const workspaceRows = scopeSessionsToWorkspace(rows, state.cwd);
      const scope = workspaceRows.length > 0 ? 'workspace' : 'all';
      const scopedRows = scope === 'workspace' ? workspaceRows : rows;
      const currentIndex = scopedRows.findIndex((row) => row.sessionId === state.sessionId);
      const ms = {
        loading: false,
        rows,
        filteredRows: scopedRows.map((r) => ({ item: r, score: 1 })),
        cursor: currentIndex >= 0 ? currentIndex : 0,
        error: null,
        confirmDeleteId: null,
        mode: 'list',
        scope,
        scopedOutCount: rows.length - scopedRows.length,
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
        scope: 'workspace',
        scopedOutCount: 0,
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
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-6);
      ms.preview = { loading: false, messages };
    } catch {
      ms.preview = { loading: false, messages: [], error: 'Failed to load preview' };
    }
    tuiState.dirty.add('all');
    scheduler.schedule();
  }

  function updateFilteredRows(ms) {
    // Workspace scope applies before the fuzzy filter, so `/` searches
    // within the selected scope. `scopedOutCount` is precomputed here (not
    // in the renderer) so the draw path stays pure over modal state.
    const base = ms.scope === 'workspace' ? scopeSessionsToWorkspace(ms.rows, state.cwd) : ms.rows;
    ms.scopedOutCount = ms.rows.length - base.length;
    if (!ms.filterBuf) {
      ms.filteredRows = base.map((r) => ({ item: r, score: 1 }));
    } else {
      ms.filteredRows = filterSessions(base, ms.filterBuf);
    }
    // Keep cursor in bounds
    ms.cursor = Math.min(ms.cursor, Math.max(0, ms.filteredRows.length - 1));
  }

  async function handleResumeModalInput(key) {
    const ms = tuiState.resumeModalState;
    if (!ms) return;

    const renameRequested =
      ms.mode === 'list' &&
      key.ch &&
      !key.ctrl &&
      !key.meta &&
      String(key.ch).toLowerCase() === 'r';
    const deleteRequested =
      ms.mode !== 'rename' &&
      ms.mode !== 'filter' &&
      (key.name === 'delete' ||
        (key.ch && !key.ctrl && !key.meta && ['d', 'x'].includes(String(key.ch).toLowerCase())));
    const filterRequested = ms.mode === 'list' && key.ch === '/' && !key.ctrl && !key.meta;
    const scopeToggleRequested =
      ms.mode === 'list' &&
      key.ch &&
      !key.ctrl &&
      !key.meta &&
      String(key.ch).toLowerCase() === 'a';

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
          const displayName = row.sessionName
            ? `${JSON.stringify(row.sessionName)} (${row.sessionId})`
            : row.sessionId;
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
        ms.cursor =
          nextIndex >= 0 ? nextIndex : Math.min(ms.cursor, Math.max(0, ms.filteredRows.length - 1));
        ms.error = null;
        exitRenameMode();

        if (trimmed) {
          addTranscriptEntry(
            tuiState,
            'status',
            `Session renamed: ${JSON.stringify(trimmed)} (${targetId})`,
          );
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
      const edit = applySingleLineEditKey(ms.filterBuf, ms.filterCursor, key, {
        submitOnReturn: true,
      });
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

    // Scope toggle is handled BEFORE the empty-list early-return: a
    // workspace scope that just lost its last session (delete, prune) must
    // still be able to widen to 'all' instead of stranding the user on an
    // empty pane.
    if (scopeToggleRequested) {
      ms.scope = ms.scope === 'workspace' ? 'all' : 'workspace';
      ms.confirmDeleteId = null;
      ms.error = null;
      updateFilteredRows(ms);
      ms.cursor = 0;
      await loadSessionPreview(ms);
      markDirty();
      return;
    }

    if (visibleRows.length === 0 || ms.loading) {
      return;
    }

    if (ms.mode === 'rename') {
      const edit = applySingleLineEditKey(ms.renameBuf, ms.renameCursor, key, {
        submitOnReturn: true,
      });
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

    // Daemon mode: route through `update_session` so the daemon stays the
    // source of truth for session-scoped state. Local mutation happens
    // only after the daemon confirms — a rejection (active run, bad
    // provider) surfaces in the transcript and the picker stays open
    // with the old value selected.
    if (daemonClient?.connected && daemonSessionId) {
      try {
        const res = await daemonClient.request(
          'update_session',
          {
            sessionId: daemonSessionId,
            attachToken: daemonAttachToken,
            patch: { model: target },
          },
          daemonSessionId,
        );
        if (!res.ok) {
          addTranscriptEntry(
            tuiState,
            'error',
            res.error?.message || 'Daemon rejected model switch',
          );
          scheduler.flush();
          return;
        }
        // The broadcast event handler will mirror provider/model into
        // local state, but apply it inline here too so the post-switch
        // status entry below reflects the new value without depending
        // on event-ordering against the response.
        hydrateSessionStateFromDaemon(res.payload);
      } catch (err) {
        addTranscriptEntry(tuiState, 'error', `Daemon error during model switch: ${err.message}`);
        scheduler.flush();
        return;
      }
    } else {
      state.model = target;
      await saveSessionState(state);
    }

    // Persist per-provider model default (matches classic REPL behavior).
    // This is a *user* preference for new sessions, not session-scoped
    // state, so it lives in the global config even in daemon mode.
    if (!config[ctx.providerConfig.id]) config[ctx.providerConfig.id] = {};
    config[ctx.providerConfig.id].model = target;
    await saveConfig(config);
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
      target = num >= 1 && num <= providers.length ? providers[num - 1] : null;
    } else {
      target = providers.find((p) => p.id === arg.toLowerCase());
    }

    if (!target) {
      addTranscriptEntry(tuiState, 'error', `Unknown provider: ${arg}`);
      scheduler.flush();
      return;
    }

    await switchProvider(providers.indexOf(target));
  }

  async function requestDaemonAdmin(
    type,
    payload = {},
    { timeoutMs = 2000, startDaemon = false } = {},
  ) {
    if (!daemonClient?.connected && startDaemon) {
      await ensureDaemonConnected({ announce: false });
    }

    if (daemonClient?.connected) {
      try {
        const response = await daemonClient.request(type, payload, null, timeoutMs);
        return {
          ok: Boolean(response.ok),
          payload: response.payload || {},
        };
      } catch (err) {
        return {
          ok: false,
          code: err.code || 'UNKNOWN',
          error: err.message || String(err),
        };
      }
    }

    const { tryConnect } = await import('./daemon-client.js');
    const { getSocketPath } = await import('./pushd.js');
    const client = await tryConnect(getSocketPath(), 500);
    if (!client) return { ok: false, code: 'DAEMON_OFFLINE', error: 'daemon not running' };
    try {
      const response = await client.request(type, payload, null, timeoutMs);
      return {
        ok: Boolean(response.ok),
        payload: response.payload || {},
      };
    } catch (err) {
      return {
        ok: false,
        code: err.code || 'UNKNOWN',
        error: err.message || String(err),
      };
    } finally {
      client.close();
    }
  }

  function formatRelayStatusLines(payload, { offline = false } = {}) {
    const persisted = payload?.persisted || null;
    const live = payload?.live || null;
    if (!persisted) {
      return [`Remote relay: disabled${offline ? ' (daemon offline)' : ''}`];
    }

    const lines = [
      `Remote relay: enabled${offline ? ' (daemon offline)' : ''}`,
      `  deployment: ${persisted.deploymentUrl}`,
    ];
    if (persisted.enabledAt) {
      lines.push(`  enabled at: ${new Date(persisted.enabledAt).toISOString()}`);
    }
    if (live?.running) {
      lines.push(`  client: running`);
      lines.push(`  state: ${live.state || 'unknown'}`);
      if (typeof live.attempt === 'number' && live.attempt > 0) {
        lines.push(`  attempt: ${live.attempt}`);
      }
      if (live.exhausted) lines.push(`  exhausted: true`);
      if (live.closeCode !== null && live.closeCode !== undefined) {
        lines.push(`  last close: ${live.closeCode} ${live.closeReason || ''}`.trimEnd());
      }
      if (live.fatal) {
        lines.push("  ⚠ won't retry — fix the cause above, then re-run `/remote enable`");
      }
      if (typeof live.allowlistSize === 'number') {
        lines.push(`  allowlist: ${live.allowlistSize} attach token(s)`);
      }
    } else if (!offline) {
      lines.push(`  client: not running`);
    }
    return lines;
  }

  async function getRemoteStatusLabel() {
    const response = await requestDaemonAdmin('relay_status', {}, { timeoutMs: 1000 });
    if (response.ok) {
      const persisted = response.payload?.persisted || null;
      const live = response.payload?.live || null;
      if (!persisted) return 'off';
      if (live?.running) return live.state ? String(live.state) : 'running';
      return 'enabled';
    }

    const { readRelayConfig } = await import('./pushd-relay-config.js');
    const cfg = await readRelayConfig();
    return cfg ? 'config only' : 'off';
  }

  async function handleDaemonCommand(arg) {
    const parts = (arg || '').trim().split(/\s+/).filter(Boolean);
    const sub = (parts[0] || 'status').toLowerCase();

    if (sub === 'status' || sub === 'show') {
      const lines = [];

      // Effective autostart setting. Don't attribute a "from env" vs
      // "from config" source — the TUI itself writes
      // PUSH_TUI_DAEMON_AUTOSTART into process.env when /config daemon
      // toggles, so any source attribution after a config change would
      // lie ("from env" when the value actually came from config).
      const autostart = isTuiDaemonAutoStartEnabled(config);
      lines.push(`Autostart: ${autostart ? 'auto' : 'off'}`);

      // Connection state from the TUI's POV. Order matters: check
      // !autostart BEFORE daemonAutoStartAttempted. `ensureDaemonConnected`
      // returns early without setting `daemonAutoStartAttempted = true`
      // when autostart is off (cli/tui.ts:1651), so the
      // `attempted && !autostart` combination is unreachable.
      if (daemonClient?.connected) {
        lines.push('Connected: yes');
        if (daemonSessionId) lines.push(`Session: ${daemonSessionId}`);
      } else if (!autostart) {
        lines.push('Connected: no (autostart off, running inline)');
      } else if (daemonAutoStartAttempted) {
        lines.push('Connected: no (autostart attempted, fell back to inline)');
      } else {
        lines.push('Connected: no (inline mode, autostart pending)');
      }

      // Process state from the pid file. isProcessRunning's EPERM
      // handling means "running under another uid" reads as running,
      // which is what we want here.
      const { getPidPath, getSocketPath, getLogPath } = await import('./pushd.js');
      const pidPath = getPidPath();
      try {
        const pidRaw = await fs.readFile(pidPath, 'utf8');
        const pid = Number.parseInt(pidRaw.trim(), 10);
        if (Number.isFinite(pid) && isProcessRunning(pid)) {
          lines.push(`Process: pid ${pid} (running)`);
        } else if (Number.isFinite(pid)) {
          lines.push(`Process: pid ${pid} in pidfile but not running (stale)`);
        } else {
          lines.push('Process: pid file unreadable');
        }
      } catch {
        lines.push('Process: not running (no pid file)');
      }

      lines.push('');
      lines.push('Paths:');
      lines.push(`  socket: ${getSocketPath()}`);
      lines.push(`  log:    ${getLogPath()}`);
      const { getAuditLogPath, getAuditMaxBytes } = await import('./pushd-audit-log.js');
      const auditPath = getAuditLogPath();
      lines.push(`  audit:  ${auditPath}`);

      // Audit log size + rotation threshold so the user can tell how
      // close they are to a rotation event. Reuse the audit module's
      // own env parser + default so this row can't drift from the
      // value the rotator actually consults.
      try {
        const stat = await fs.stat(auditPath);
        const sizeMb = (stat.size / 1024 / 1024).toFixed(2);
        const maxMb = (getAuditMaxBytes() / 1024 / 1024).toFixed(0);
        lines.push(`  audit size: ${sizeMb} MB (rotates at ${maxMb} MB)`);
      } catch {
        // No audit log on disk yet — fine, just skip the size row.
      }

      addTranscriptEntry(tuiState, 'status', lines.join('\n'));
      scheduler.flush();
      return;
    }

    if (sub === 'restart' || sub === 'refresh') {
      // Manual trigger of the same drain + respawn the stale-runtime self-heal
      // uses. Intentionally NOT the primary path — the buildStamp check fires
      // this automatically on a stale reuse — but useful when the user wants to
      // force a clean daemon (e.g. after an uncommitted edit the stamp can't
      // see, or just to be sure).
      if (!daemonClient?.connected) {
        // No daemon to drain. If autostart is on, spawn a fresh one; otherwise
        // there's nothing to restart.
        const connected = await ensureDaemonConnected({ announce: true });
        addTranscriptEntry(
          tuiState,
          connected ? 'status' : 'warning',
          connected
            ? 'No daemon was running; started a fresh one from current code.'
            : 'No daemon running and autostart is off. Nothing to restart.',
        );
        scheduler.flush();
        return;
      }
      addTranscriptEntry(tuiState, 'status', 'Restarting pushd daemon…');
      scheduler.flush();
      await refreshDaemon({ reason: 'manual /daemon restart' });
      return;
    }

    addTranscriptEntry(
      tuiState,
      'warning',
      `Unknown daemon subcommand: ${sub}. Try: /daemon status | /daemon restart`,
    );
    scheduler.flush();
  }

  // Shared by /remote (setup|pair) and /rc: mint a phone pairing
  // bundle targeting the CURRENT TUI session, so pasting it on the phone
  // lands in this exact conversation.
  async function mintPairBundleForActiveSession() {
    await ensureDaemonConnected({ announce: false });
    if (!daemonClient?.connected) {
      return { ok: false, code: 'DAEMON_OFFLINE', error: 'daemon not running' };
    }
    await ensureDaemonSession();
    if (!daemonSessionId) {
      return {
        ok: false,
        code: 'NO_DAEMON_SESSION',
        error: 'no active daemon session',
      };
    }
    return requestDaemonAdmin(
      'mint_remote_pair_bundle',
      {
        targetSessionId: daemonSessionId,
        ...(daemonAttachToken ? { targetAttachToken: daemonAttachToken } : {}),
      },
      { timeoutMs: 5000 },
    );
  }

  // Shared by /remote and /rc: render a freshly minted pairing
  // bundle into the transcript (and adopt any newly minted session
  // attach token).
  function renderPairBundle(payload) {
    const bundle = String(payload?.bundle || '');
    const deviceTokenId = String(payload?.deviceTokenId || '');
    const attachTokenId = String(payload?.attachTokenId || '');
    const deploymentUrl = String(payload?.deploymentUrl || '');
    const relaySessionId = String(payload?.sessionId || '');
    const targetSessionId = String(payload?.targetSessionId || daemonSessionId || '');
    // If the daemon minted a fresh attach token for this (previously
    // tokenless) session, adopt it: update the live token and the in-memory
    // session state so a reconnect carries the now-required bearer. The
    // daemon already persisted it to the shared session-store, so no
    // TUI-side write is needed (and skipping it avoids racing that write).
    const mintedTargetAttachToken = String(payload?.mintedTargetAttachToken || '');
    if (mintedTargetAttachToken) {
      daemonAttachToken = mintedTargetAttachToken;
      if (state && typeof state === 'object') state.attachToken = mintedTargetAttachToken;
    }
    tuiState.lastRemotePairBundle = bundle || null;
    const lines = [
      'Remote pairing bundle minted for this TUI session.',
      `  deployment: ${deploymentUrl || 'unknown'}`,
      `  relay route: ${relaySessionId || 'unknown'}`,
      `  target session: ${targetSessionId || 'unknown'}`,
      `  device id: ${deviceTokenId || 'unknown'}`,
      `  attach id: ${attachTokenId || 'unknown'}`,
      '',
      'Bundle (copy now - this is the only time the bearer is shown):',
      '',
      `  ${bundle}`,
      '',
      'Copy it with: /copy remote',
      'Paste this into the phone Remote pairing screen.',
      deviceTokenId ? `Revoke this phone with: push daemon revoke ${deviceTokenId}` : '',
    ].filter(Boolean);
    addTranscriptEntry(tuiState, 'status', lines.join('\n'));
    scheduler.flush();
  }

  // Shared by /remote enable and /remote setup: resolve the deployment
  // URL + token from positional args, falling back to the persisted
  // relay config / PUSH_RELAY_TOKEN for whichever is omitted.
  //
  // With two args the mapping is unambiguous (url, token), same order
  // as before this fallback existed. With exactly one arg it's ambiguous
  // positionally — but the two real values look nothing alike, so shape
  // disambiguates: a `pushd_relay_...` string can never be a deployment
  // URL and vice versa. The rotate-token-only case (the actual reason
  // this fallback exists — keep dialing the same Worker, mint a fresh
  // bearer) is exactly a lone token argument, so check that first.
  async function resolveRelayEnableArgs(parts) {
    const { isValidRelayToken, readRelayConfig } = await import('./pushd-relay-config.js');
    const first = parts[1];
    const second = parts[2];
    let explicitUrl;
    let explicitToken;
    if (first && second) {
      explicitUrl = first;
      explicitToken = second;
    } else if (first) {
      if (isValidRelayToken(first)) {
        explicitToken = first;
      } else {
        explicitUrl = first;
      }
    }
    const persisted = explicitUrl && explicitToken ? null : await readRelayConfig();
    return {
      deploymentUrl: explicitUrl || persisted?.deploymentUrl,
      token: explicitToken || process.env.PUSH_RELAY_TOKEN?.trim(),
    };
  }

  async function handleRemoteCommand(arg) {
    const parts = (arg || '').trim().split(/\s+/).filter(Boolean);
    const sub = (parts[0] || 'status').toLowerCase();

    if (sub === 'status' || sub === 'show') {
      const response = await requestDaemonAdmin('relay_status', {}, { timeoutMs: 1500 });
      if (response.ok) {
        addTranscriptEntry(tuiState, 'status', formatRelayStatusLines(response.payload).join('\n'));
        scheduler.flush();
        return;
      }
      if (response.code === 'DAEMON_OFFLINE') {
        const { readRelayConfig } = await import('./pushd-relay-config.js');
        const cfg = await readRelayConfig();
        const payload = cfg
          ? { persisted: { deploymentUrl: cfg.deploymentUrl, enabledAt: cfg.enabledAt } }
          : { persisted: null };
        addTranscriptEntry(
          tuiState,
          'status',
          formatRelayStatusLines(payload, { offline: true }).join('\n'),
        );
        scheduler.flush();
        return;
      }
      addTranscriptEntry(
        tuiState,
        'error',
        `Remote relay status failed: ${response.error || response.code || 'unknown'}`,
      );
      scheduler.flush();
      return;
    }

    if (sub === 'enable') {
      const { deploymentUrl, token } = await resolveRelayEnableArgs(parts);
      if (!deploymentUrl || !token) {
        addTranscriptEntry(
          tuiState,
          'warning',
          'Usage: /remote enable <deployment-url> <pushd_relay_...>\n' +
            '  <deployment-url> may be omitted if a relay was already configured on this machine.\n' +
            '  <pushd_relay_...> may be omitted if PUSH_RELAY_TOKEN is set in the environment.',
        );
        scheduler.flush();
        return;
      }
      const { isValidRelayToken } = await import('./pushd-relay-config.js');
      if (!isValidRelayToken(token)) {
        addTranscriptEntry(
          tuiState,
          'warning',
          'Remote relay token must start with pushd_relay_ and include a token body (yours looks truncated)',
        );
        scheduler.flush();
        return;
      }

      const response = await requestDaemonAdmin(
        'relay_enable',
        { deploymentUrl, token },
        { timeoutMs: 5000, startDaemon: true },
      );
      if (response.ok) {
        addTranscriptEntry(
          tuiState,
          'status',
          `Remote relay enabled: ${deploymentUrl} (${maskSecret(token)})`,
        );
        scheduler.flush();
        return;
      }
      if (response.code === 'DAEMON_OFFLINE') {
        const { writeRelayConfig } = await import('./pushd-relay-config.js');
        try {
          await writeRelayConfig({ deploymentUrl, token });
          addTranscriptEntry(
            tuiState,
            'status',
            `Remote relay config saved: ${deploymentUrl}. pushd will dial it on start.`,
          );
        } catch (err) {
          addTranscriptEntry(
            tuiState,
            'error',
            `Remote relay enable failed: ${err.message || String(err)}`,
          );
        }
        scheduler.flush();
        return;
      }

      addTranscriptEntry(
        tuiState,
        'error',
        `Remote relay enable failed: ${response.error || response.code || 'unknown'}`,
      );
      scheduler.flush();
      return;
    }

    if (sub === 'pair') {
      const response = await mintPairBundleForActiveSession();
      if (response.ok) {
        renderPairBundle(response.payload);
        return;
      }
      if (response.code === 'RELAY_NOT_ENABLED') {
        addTranscriptEntry(
          tuiState,
          'warning',
          'Remote relay is not enabled. Use: /remote setup <deployment-url> <pushd_relay_...>',
        );
      } else {
        addTranscriptEntry(
          tuiState,
          'error',
          `Remote pairing failed: ${response.error || response.code || 'unknown'}`,
        );
      }
      scheduler.flush();
      return;
    }

    if (sub === 'setup') {
      const { deploymentUrl, token } = await resolveRelayEnableArgs(parts);
      if (!deploymentUrl || !token) {
        addTranscriptEntry(
          tuiState,
          'warning',
          'Usage: /remote setup <deployment-url> <pushd_relay_...>\n' +
            '  <deployment-url> may be omitted if a relay was already configured on this machine.\n' +
            '  <pushd_relay_...> may be omitted if PUSH_RELAY_TOKEN is set in the environment.',
        );
        scheduler.flush();
        return;
      }
      const { isValidRelayToken } = await import('./pushd-relay-config.js');
      if (!isValidRelayToken(token)) {
        addTranscriptEntry(
          tuiState,
          'warning',
          'Remote relay token must start with pushd_relay_ and include a token body (yours looks truncated)',
        );
        scheduler.flush();
        return;
      }
      const enableResponse = await requestDaemonAdmin(
        'relay_enable',
        { deploymentUrl, token },
        { timeoutMs: 5000, startDaemon: true },
      );
      if (!enableResponse.ok) {
        addTranscriptEntry(
          tuiState,
          'error',
          `Remote relay enable failed: ${enableResponse.error || enableResponse.code || 'unknown'}`,
        );
        scheduler.flush();
        return;
      }
      addTranscriptEntry(
        tuiState,
        'status',
        `Remote relay enabled: ${deploymentUrl} (${maskSecret(token)})`,
      );
      const pairResponse = await mintPairBundleForActiveSession();
      if (pairResponse.ok) {
        renderPairBundle(pairResponse.payload);
        return;
      }
      addTranscriptEntry(
        tuiState,
        'error',
        `Remote pairing failed after enabling relay: ${pairResponse.error || pairResponse.code || 'unknown'}`,
      );
      scheduler.flush();
      return;
    }

    if (sub === 'disable') {
      const response = await requestDaemonAdmin('relay_disable', {}, { timeoutMs: 3000 });
      if (response.ok) {
        const removed = Boolean(response.payload?.configRemoved);
        const stopped = Boolean(response.payload?.clientStopped);
        addTranscriptEntry(
          tuiState,
          'status',
          `Remote relay disabled${removed ? '' : ' (no config was present)'}${stopped ? ' (closed live connection)' : ''}`,
        );
        scheduler.flush();
        return;
      }
      if (response.code === 'DAEMON_OFFLINE') {
        const { deleteRelayConfig } = await import('./pushd-relay-config.js');
        const removed = await deleteRelayConfig();
        addTranscriptEntry(
          tuiState,
          'status',
          `Remote relay config ${removed ? 'removed' : 'was not set'} (daemon offline)`,
        );
        scheduler.flush();
        return;
      }
      addTranscriptEntry(
        tuiState,
        'error',
        `Remote relay disable failed: ${response.error || response.code || 'unknown'}`,
      );
      scheduler.flush();
      return;
    }

    addTranscriptEntry(
      tuiState,
      'warning',
      'Usage: /remote status | /remote setup <deployment-url> <pushd_relay_...> | /remote pair | /remote enable <deployment-url> <pushd_relay_...> | /remote disable',
    );
    scheduler.flush();
  }

  /**
   * /rc — remote control: one-shot "continue this session on my phone."
   *
   * Claude Code-style ergonomics over the existing relay pieces: instead
   * of the /remote enable → pair → paste dance, a single command drives
   * whatever state the relay is in toward "this session is visible in the
   * phone's Chats drawer":
   *
   *   - relay never configured        → point at the one-time /remote setup
   *   - relay stopped / disconnected /
   *     given up (exhausted, fatal)   → re-enable from the saved config;
   *                                     if still not open/connecting after
   *                                     the re-dial, report the real state
   *                                     instead of confirming
   *   - no phone paired yet           → mint + render a pairing bundle
   *   - phone already paired          → confirm reachability (the phone's
   *                                     Connected list shows this session)
   *
   * `/rc pair` forces a fresh bundle even when a phone is already
   * paired (pairing an additional device re-uses the same path).
   *
   * The "phone already paired" signal is the relay allowlist size (device
   * attach tokens registered with the relay client) — NOT `list_devices`,
   * which only reflects live loopback WS connections and never sees
   * relay-paired phones.
   */
  async function handleRemoteControlCommand(arg) {
    const sub = (arg || '').trim().toLowerCase();
    if (sub && sub !== 'pair') {
      addTranscriptEntry(
        tuiState,
        'warning',
        'Usage: /rc  (make this session reachable on your phone) | /rc pair  (mint a bundle for a new phone)',
      );
      scheduler.flush();
      return;
    }

    const status = await requestDaemonAdmin(
      'relay_status',
      {},
      { timeoutMs: 2000, startDaemon: true },
    );
    if (!status.ok) {
      addTranscriptEntry(
        tuiState,
        'error',
        status.code === 'DAEMON_OFFLINE'
          ? '/rc needs the pushd daemon, and it is not running (autostart may be off). Try /daemon restart, then /rc again.'
          : `Remote control failed reading relay status: ${status.error || status.code || 'unknown'}`,
      );
      scheduler.flush();
      return;
    }

    const persisted = status.payload?.persisted || null;
    let live = status.payload?.live || null;
    if (!persisted) {
      addTranscriptEntry(
        tuiState,
        'warning',
        [
          'Remote relay is not configured yet. One-time setup:',
          '  /remote setup <deployment-url> <pushd_relay_...>',
          'After that, /rc hands any TUI session to your phone.',
        ].join('\n'),
      );
      scheduler.flush();
      return;
    }

    // "Healthy" = the relay client is connected or actively dialing on
    // its own. `running` alone is NOT enough: a client whose socket
    // closed (`state: 'closed' | 'unreachable'`) — or that gave up
    // (`exhausted` / `fatal`) — still reports `running: true` because
    // the daemon holds an activeRelayClient. Confirming reachability in
    // that state would be a lie (Codex P2 on #1309).
    const relayLiveHealthy = (l) =>
      Boolean(l?.running) &&
      !l.exhausted &&
      !l.fatal &&
      (l.state === 'open' || l.state === 'connecting');

    // Relay client stopped, disconnected, or given up — re-enable from
    // the saved config so the phone can reach us again (relay_enable
    // restarts the client with an immediate dial).
    if (!relayLiveHealthy(live)) {
      const { readRelayConfig } = await import('./pushd-relay-config.js');
      const cfg = await readRelayConfig();
      if (cfg) {
        const enable = await requestDaemonAdmin(
          'relay_enable',
          { deploymentUrl: cfg.deploymentUrl, token: cfg.token },
          { timeoutMs: 5000 },
        );
        if (!enable.ok) {
          addTranscriptEntry(
            tuiState,
            'error',
            `Remote control could not restart the relay client: ${enable.error || enable.code || 'unknown'}`,
          );
          scheduler.flush();
          return;
        }
        const refreshed = await requestDaemonAdmin('relay_status', {}, { timeoutMs: 2000 });
        if (refreshed.ok) live = refreshed.payload?.live || live;
      }
      // Still not healthy after the re-dial attempt: report the real
      // state instead of minting a bundle or claiming reachability the
      // relay can't deliver.
      if (!relayLiveHealthy(live)) {
        const closeInfo =
          live?.closeCode !== null && live?.closeCode !== undefined
            ? ` (last close: ${live.closeCode}${live.closeReason ? ` ${live.closeReason}` : ''})`
            : '';
        addTranscriptEntry(
          tuiState,
          'error',
          `Remote relay is not connected (state: ${live?.state || 'unknown'})${closeInfo}. Check /remote status, then /rc again.`,
        );
        scheduler.flush();
        return;
      }
    }

    const pairedPhones = typeof live?.allowlistSize === 'number' ? live.allowlistSize : 0;

    if (sub === 'pair' || pairedPhones === 0) {
      const response = await mintPairBundleForActiveSession();
      if (response.ok) {
        renderPairBundle(response.payload);
        addTranscriptEntry(
          tuiState,
          'status',
          'Once pasted on the phone, this session appears in the Chats drawer under Connected.',
        );
        scheduler.flush();
        return;
      }
      addTranscriptEntry(
        tuiState,
        'error',
        response.code === 'NO_DAEMON_SESSION'
          ? 'Remote control failed: this TUI has no daemon session yet. Enable daemon autostart (/config daemon auto), then retry.'
          : `Remote control pairing failed: ${response.error || response.code || 'unknown'}`,
      );
      scheduler.flush();
      return;
    }

    // A phone is already paired — make sure THIS session lives on the
    // daemon (an inline TUI session is invisible to the phone), then
    // confirm. requestDaemonAdmin can succeed over a transient socket
    // even when the TUI itself runs inline, so re-check the TUI's own
    // daemon attachment explicitly.
    await ensureDaemonConnected({ announce: false });
    if (daemonClient?.connected) await ensureDaemonSession();
    if (!daemonClient?.connected || !daemonSessionId) {
      addTranscriptEntry(
        tuiState,
        'warning',
        'A phone is paired, but this TUI is running inline (no daemon session), so the phone cannot see this chat. Enable daemon autostart (/config daemon auto), then /rc again.',
      );
      scheduler.flush();
      return;
    }

    const sessionLabel = state.sessionName ? `"${state.sessionName}"` : daemonSessionId;
    addTranscriptEntry(
      tuiState,
      'status',
      [
        `Session ${sessionLabel} is reachable from your phone.`,
        `  relay: ${live?.state || 'connected'}`,
        `  paired phones: ${pairedPhones}`,
        '  Open the Chats drawer on the phone — this session is listed under Connected; tap it to continue there.',
        '  /rc pair adds another phone.',
      ].join('\n'),
    );
    scheduler.flush();
  }

  /** Handle /config [subcommand] [args]. */
  async function handleConfigCommand(arg) {
    if (!arg) {
      await openConfigModal();
      return;
    }

    const parts = arg.split(/\s+/);
    const sub = parts[0];

    if (sub === 'key') {
      if (parts.length < 2) {
        addTranscriptEntry(
          tuiState,
          'warning',
          'Usage: /config key <secret> or /config key <provider> <secret>',
        );
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

      // Shared with the config modal: persists, updates this process's env +
      // the live session key, AND nudges the daemon to reload (so the slash
      // command isn't a second key-edit path that skips daemon propagation).
      await saveConfigKey(targetId, secret);

      addTranscriptEntry(
        tuiState,
        'status',
        `API key saved for ${targetId} (${maskSecret(secret)})`,
      );
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
      await notifyDaemonConfigReload();

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
      await saveConfigKey('tavily', secret); // persists + env + daemon reload

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

    if (sub === 'daemon') {
      const value = parts[1]?.toLowerCase();
      if (value !== 'auto' && value !== 'off') {
        addTranscriptEntry(tuiState, 'warning', 'Usage: /config daemon auto|off');
        scheduler.flush();
        return;
      }
      const enabled = value === 'auto';
      config.tuiDaemonAutoStart = enabled;
      process.env.PUSH_TUI_DAEMON_AUTOSTART = String(enabled);
      await saveConfig(config);
      if (enabled) {
        daemonAutoStartAttempted = false;
        await ensureDaemonConnected({ announce: true });
      }
      addTranscriptEntry(tuiState, 'status', `TUI daemon autostart: ${enabled ? 'auto' : 'off'}`);
      scheduler.flush();
      return;
    }

    if (sub === 'remote') {
      await handleRemoteCommand(parts.slice(1).join(' '));
      return;
    }

    addTranscriptEntry(
      tuiState,
      'warning',
      `Unknown config subcommand: ${sub}. Try: key, url, tavily, sandbox, explain, daemon, remote`,
    );
    scheduler.flush();
  }

  async function handleThemeCommand(arg) {
    const parts = (arg || '').trim().split(/\s+/).filter(Boolean);
    const sub = (parts[0] || 'show').toLowerCase();

    if (sub === 'show') {
      addTranscriptEntry(tuiState, 'status', `theme: ${theme.name}`);
      scheduler.flush();
      return;
    }

    if (sub === 'list') {
      const lines = THEME_NAMES.map((name) => {
        const marker = name === theme.name ? '*' : ' ';
        return `  ${marker} ${name.padEnd(10)}  ${VARIANTS[name].description}`;
      });
      addTranscriptEntry(tuiState, 'status', ['Themes:', ...lines].join('\n'));
      scheduler.flush();
      return;
    }

    if (sub === 'preview') {
      const target = parts[1];
      const names = target ? [target] : THEME_NAMES;
      for (const name of names) {
        if (!isThemeName(name)) {
          addTranscriptEntry(
            tuiState,
            'warning',
            `Unknown theme: ${name}. Available: ${THEME_NAMES.join(', ')}`,
          );
          scheduler.flush();
          return;
        }
      }
      const body = names
        .map((name) => renderThemePreview(name, { tier: theme.tier, unicode: theme.unicode }))
        .join('\n\n');
      addTranscriptEntry(tuiState, 'status', body);
      scheduler.flush();
      return;
    }

    // `/theme <name>` and `/theme set <name>` both switch live.
    const name = sub === 'set' ? parts[1] : sub;
    if (!name || !isThemeName(name)) {
      addTranscriptEntry(
        tuiState,
        'warning',
        `Unknown theme: ${name || '(missing)'}. Available: ${THEME_NAMES.join(', ')}`,
      );
      scheduler.flush();
      return;
    }

    // Build the new theme preserving the detected tier/unicode of the
    // current session — `createTheme()` would re-read env, which is fine,
    // but we pin tier/unicode so a config change can't mid-flight flip
    // glyph sets or color tiers unexpectedly.
    theme = createTheme({ tier: theme.tier, unicode: theme.unicode, name });
    config.theme = name;
    process.env.PUSH_THEME = name;
    await saveConfig(config);

    tuiState.dirty.add('all');
    addTranscriptEntry(tuiState, 'status', `theme: ${name} (saved)`);
    scheduler.flush();
  }

  async function handleSpinnerCommand(arg) {
    const parts = (arg || '').trim().split(/\s+/).filter(Boolean);
    const sub = (parts[0] || '').toLowerCase();

    if (!sub || sub === 'show') {
      const pinned = isSpinnerName(config.spinner) ? ' (pinned)' : '';
      const rm = isReducedMotion() ? ' — reduced-motion active' : '';
      addTranscriptEntry(tuiState, 'status', `spinner: ${spinner.name}${pinned}${rm}`);
      scheduler.flush();
      return;
    }

    if (sub === 'list') {
      const lines = SPINNER_NAMES.map((name) => {
        const marker = name === spinner.name ? '*' : ' ';
        // Preview the first frame alongside the name so the list is
        // self-explanatory when choosing.
        const preview = name === 'off' ? ' ' : (SPINNERS[name].frames[0] ?? ' ');
        return `  ${marker} ${preview}  ${name.padEnd(10)}  ${SPINNERS[name].description}`;
      });
      addTranscriptEntry(tuiState, 'status', ['Spinners:', ...lines].join('\n'));
      scheduler.flush();
      return;
    }

    const sub0 = ((sub === 'set' ? parts[1] : sub) || '').toLowerCase().trim();
    if (sub0 === 'unpin') {
      delete config.spinner;
      delete process.env.PUSH_SPINNER;
      await saveConfig(config);
      // The unpinned default is always 'off' — spinner has no per-theme
      // bundling, and the only motion the TUI carries today is the
      // running-state spinner, so 'off' is the resting state.
      const next = 'off';
      spinner.name = next;
      refreshTicker();
      tuiState.dirty.add('all');
      addTranscriptEntry(tuiState, 'status', `spinner: ${next} (unpinned)`);
      scheduler.flush();
      return;
    }

    if (!isSpinnerName(sub0)) {
      addTranscriptEntry(
        tuiState,
        'warning',
        `Unknown spinner: ${sub0 || '(missing)'}. Available: ${SPINNER_NAMES.join(', ')}. Use 'unpin' to clear.`,
      );
      scheduler.flush();
      return;
    }

    // Reduced-motion is a hard guard — refuse to turn spinner on. Saving
    // 'off' is still a valid (and effectively no-op) choice.
    if (isReducedMotion() && sub0 !== 'off') {
      addTranscriptEntry(
        tuiState,
        'warning',
        'Spinner disabled: reduced-motion is set (PUSH_REDUCED_MOTION / REDUCED_MOTION). Unset it to enable.',
      );
      scheduler.flush();
      return;
    }

    spinner.name = sub0;
    refreshTicker();

    config.spinner = sub0;
    process.env.PUSH_SPINNER = sub0;
    await saveConfig(config);

    tuiState.dirty.add('all');
    addTranscriptEntry(tuiState, 'status', `spinner: ${sub0} (saved)`);
    scheduler.flush();
  }

  function handleDebugCommand(arg) {
    const sub = (arg || '').trim();
    if (!sub) {
      addTranscriptEntry(tuiState, 'warning', 'Usage: /debug runtime');
      scheduler.flush();
      return;
    }

    if (sub !== 'runtime') {
      addTranscriptEntry(tuiState, 'warning', `Unknown debug subcommand: ${sub}. Try: runtime`);
      scheduler.flush();
      return;
    }

    const mismatch = getRuntimeOriginMismatch(state.cwd);
    const sessionRoot = getSessionRoot();
    const runtimeEntry = process.argv[1] ? safeRealpath(process.argv[1]) : '(unknown)';
    const runtimeDir = process.argv[1] ? path.dirname(runtimeEntry) : '(unknown)';
    const repoRoot = mismatch?.repoRoot || '(not detected)';
    const expectedLauncher = mismatch?.repoRoot
      ? path.join(mismatch.repoRoot, 'push')
      : '(not detected)';

    const lines = [
      'Runtime Debug:',
      `  cwd: ${process.cwd()}`,
      `  workspace: ${state.cwd}`,
      `  node: ${process.execPath}`,
      `  argv[1]: ${runtimeEntry}`,
      `  runtime dir: ${runtimeDir}`,
      `  repo root (detected): ${repoRoot}`,
      `  repo launcher (expected): ${expectedLauncher}`,
      `  repo runtime mismatch: ${mismatch ? (mismatch.mismatched ? 'yes' : 'no') : 'n/a'}`,
      `  provider: ${ctx.providerConfig.id}`,
      `  provider url: ${ctx.providerConfig.url}`,
      `  model: ${state.model}`,
      `  session id: ${state.sessionId}`,
      `  session root: ${sessionRoot}`,
      `  session dir (current root): ${path.join(sessionRoot, state.sessionId)}`,
      `  api key loaded: ${ctx.apiKey ? 'yes' : 'no'}`,
    ];

    addTranscriptEntry(tuiState, 'status', lines.join('\n'));
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

      case 'remote':
        await handleRemoteCommand(arg || null);
        return true;

      case 'rc':
        await handleRemoteControlCommand(arg || null);
        return true;

      case 'daemon':
        await handleDaemonCommand(arg || null);
        return true;

      case 'theme':
        await handleThemeCommand(arg || null);
        return true;

      case 'spinner':
        await handleSpinnerCommand(arg || null);
        return true;

      case 'debug':
        handleDebugCommand(arg || null);
        return true;

      case 'help':
        addTranscriptEntry(
          tuiState,
          'status',
          [
            'Commands:',
            '  /new | /clear        Start a new session (same provider/model/cwd)',
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
            '  /config daemon auto|off  Toggle TUI pushd autostart',
            '  /remote status|setup|pair|enable|disable  Manage Remote relay + phone pairing',
            '  /rc [pair]           Remote control: hand this session to your phone (one-shot; pairs if needed)',
            '  /daemon status       Show pushd connection, process, and log paths',
            '  /daemon restart      Drain + respawn pushd from current code (auto on stale)',
            '  /theme               Show current theme',
            '  /theme list          List available themes',
            '  /theme preview [<name>]  Preview theme swatches (all themes if omitted)',
            '  /theme <name>        Switch theme live and persist (mono|default|neon|metallic|solarized|forest)',
            '  /spinner             Show current running-dot spinner',
            '  /spinner list        List Braille spinners (with frame previews)',
            '  /spinner <name>      Pin a spinner (off|braille|orbit|breathe|pulse|helix)',
            '  /spinner unpin       Unpin: revert to static status dot',
            '  /debug runtime       Show runtime path/provider/session diagnostics',
            '  /skills              List available skills',
            '  /skills reload       Reload workspace + Claude skills',
            '  /skills lint         Report dropped/degraded skill files',
            `  /compact [turns]      Compact older context (default keep ${DEFAULT_COMPACT_TURNS} turns; daemon: session_summarize)`,
            '  /revert [n]           Daemon: undo last n user turns (default 1; transcript only)',
            '  /unrevert             Daemon: restore the messages a /revert dropped',
            '  /children [id]        Daemon: list delegated child runs (or inspect one by subagentId)',
            '  /checkpoint           Snapshot/rollback (create | list | load | delete)',
            '  /worktree             Show the git-worktree sandbox status (if any)',
            '  /copy [last|code|tool|remote]  Copy content to clipboard via OSC 52 (default: last)',
            '  /<skill> [args]      Run a skill (e.g. /commit, /review)',
            '  /resume              Open resumable session picker',
            '  /resume <session-id> Switch to a saved session',
            '  @path[:line[-end]]   Preload file refs into context',
            '  /session             Print session id',
            '  /session rename <name>  Rename current session (--clear to unset)',
            '  /exit                Exit TUI',
            '',
            'Selecting text:',
            '  Shift+drag    Native selection (Linux/WSL/Windows Terminal, xterm)',
            '  Option+drag   Native selection (iTerm2, macOS Terminal)',
            '  /copy         Push semantic chunks to clipboard (survives scrollback)',
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
            '  Ctrl+R        Session picker (resume/switch)',
            '  Ctrl+Y        Approve',
            '  Ctrl+N        Deny',
            '  Ctrl+P        Provider switcher',
            '  Payload inspector: j/k or arrows move, Enter toggles block, a toggles all',
          ].join('\n'),
        );
        scheduler.flush();
        return true;

      case 'new':
      case 'clear':
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
        addTranscriptEntry(
          tuiState,
          'warning',
          'Usage: /session | /session rename <name> | /session rename --clear',
        );
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
        if (arg === 'lint') {
          const diags = await lintSkills(state.cwd);
          skillDiagnostics = diags;
          addTranscriptEntry(
            tuiState,
            diags.some((d) => d.severity === 'error') ? 'warning' : 'status',
            formatSkillDiagnostics(diags),
          );
          scheduler.flush();
          return true;
        }
        if (arg) {
          addTranscriptEntry(tuiState, 'warning', 'Usage: /skills | /skills reload | /skills lint');
          scheduler.flush();
          return true;
        }
        {
          if (skills.size === 0) {
            addTranscriptEntry(tuiState, 'status', 'No skills loaded.');
          } else if (visibleSkills.size === 0) {
            addTranscriptEntry(
              tuiState,
              'status',
              `All ${skills.size} skills hidden by platform or capability constraints.`,
            );
          } else {
            const lines = [];
            for (const [name, skill] of visibleSkills) {
              const tag =
                skill.source === 'workspace'
                  ? ' (workspace)'
                  : skill.source === 'claude'
                    ? ' (claude)'
                    : '';
              const hint = skill.argumentHint ? ` ${skill.argumentHint}` : '';
              lines.push(`  /${name}${hint}  ${skill.description}${tag}`);
            }
            const hidden = skills.size - visibleSkills.size;
            if (hidden > 0) {
              lines.push(`  (${hidden} hidden — platform or capability constraints unmet)`);
            }
            const summary = skillDiagnosticSummaryLine(skillDiagnostics);
            if (summary) {
              lines.push(`  (${summary})`);
            }
            addTranscriptEntry(tuiState, 'status', lines.join('\n'));
          }
        }
        scheduler.flush();
        return true;

      case 'compact':
        await compactSessionContext(arg || null);
        return true;

      case 'checkpoint':
        await handleCheckpointCommand(arg || null);
        return true;

      case 'worktree':
        addTranscriptEntry(tuiState, 'status', await formatWorktreeStatus(state));
        return true;

      case 'revert':
        await revertDaemonSession(arg || null);
        return true;

      case 'unrevert':
        await unrevertDaemonSession();
        return true;

      case 'children':
        await inspectDaemonChildren(arg || null);
        return true;

      case 'copy': {
        const target = (arg || 'last').toLowerCase();
        let content = null;
        let label = '';
        if (target === 'last' || target === 'message') {
          content = findLastAssistantText(tuiState);
          label = 'last assistant message';
        } else if (target === 'code') {
          content = findLastCodeBlock(tuiState);
          label = 'last code block';
        } else if (target === 'tool') {
          const t = tuiState.lastToolResult;
          if (t && t.text) {
            content = t.text;
            label = `last tool result (${t.name})`;
          } else {
            label = 'last tool result';
          }
        } else if (target === 'remote' || target === 'bundle') {
          content = tuiState.lastRemotePairBundle;
          label = 'last Remote pairing bundle';
        } else {
          addTranscriptEntry(tuiState, 'warning', 'Usage: /copy [last|code|tool|remote]');
          scheduler.flush();
          return true;
        }
        if (!content) {
          addTranscriptEntry(tuiState, 'warning', `Nothing to copy: no ${label} yet.`);
          scheduler.flush();
          return true;
        }
        let truncated = false;
        if (content.length > OSC52_MAX_BYTES) {
          content = content.slice(0, OSC52_MAX_BYTES);
          truncated = true;
        }
        io.stdout.write(osc52Copy(content));
        const size = formatByteSize(content.length);
        const suffix = truncated ? ` (truncated to ${size})` : ` (${size})`;
        addTranscriptEntry(tuiState, 'status', `Copied ${label}${suffix} via OSC 52.`);
        scheduler.flush();
        return true;
      }

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
          await appendSessionEvent(state, 'user_message', {
            chars: prompt.length,
            preview: prompt.slice(0, 280),
            skill: cmd,
          });
          await runPrompt(prompt, { referenceSourceText: arg });
          return true;
        }

        addTranscriptEntry(
          tuiState,
          'warning',
          `Unknown command: /${cmd}. Type /help for commands.`,
        );
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
      runAbort._userInitiated = true;
      runAbort.abort();
      addTranscriptEntry(tuiState, 'status', 'Run cancelled.');
    }
  }

  // Cancel a daemon-owned run we don't have a local `runAbort` for — i.e. a run
  // we learned about from a snapshot on reattach. Sends the same bearer-gated
  // `cancel_run` RPC the local daemon-turn abort path sends; the resulting
  // `run_complete` event flips the TUI back to idle. Returns true if a cancel
  // was dispatched. Audit: Codex #744 (without this, Ctrl+C on a reattached run
  // hit `cancelRun()`'s null-`runAbort` no-op — neither cancelling nor exiting).
  function cancelDaemonRun() {
    if (!daemonClient?.connected || !daemonSessionId || !daemonActiveRunId) return false;
    daemonClient
      .request(
        'cancel_run',
        {
          sessionId: daemonSessionId,
          runId: daemonActiveRunId,
          attachToken: daemonAttachToken,
        },
        daemonSessionId,
      )
      .catch(() => {});
    addTranscriptEntry(tuiState, 'status', 'Cancelling daemon run…');
    return true;
  }

  // Open / close the approval Pane in lockstep with `tuiState.approval`.
  // Hoisted as a function declaration so the set sites earlier in runTUI
  // can reference it; the action callbacks below are likewise hoisted.
  function openApprovalPane(payload) {
    tuiState.approval = payload;
    tuiState.approvalPane = createApprovalPane(payload, {
      approve: approveAction,
      alwaysApprove: alwaysApproveAction,
      persistPrefix: () =>
        runAsync(() => persistPrefixApprovalAction(), 'failed to persist trusted prefix'),
      deny: denyAction,
    });
  }

  function closeApprovalPane() {
    tuiState.approval = null;
    tuiState.approvalPane = null;
  }

  function approveAction() {
    if (approvalResolve) {
      if (tuiState.approval) {
        pushTranscriptEntry(tuiState, {
          role: 'verdict',
          verdict: 'APPROVED',
          kind: tuiState.approval.kind,
          summary: tuiState.approval.summary,
          timestamp: Date.now(),
        });
      }
      approvalResolve(true);
      approvalResolve = null;
      closeApprovalPane();
      setRunState('running');
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
        pushTranscriptEntry(tuiState, {
          role: 'verdict',
          verdict: 'APPROVED',
          kind: tuiState.approval.kind,
          summary: tuiState.approval.summary,
          trusted: true,
          timestamp: Date.now(),
        });
      }
      approvalResolve(true);
      approvalResolve = null;
      closeApprovalPane();
      setRunState('running');
      tuiState.dirty.add('all');
      scheduler.schedule();
    }
  }

  async function persistPrefixApprovalAction() {
    if (!approvalResolve) return;

    const suggestedPrefix =
      typeof tuiState.approval?.suggestedPrefix === 'string'
        ? tuiState.approval.suggestedPrefix
        : '';

    if (suggestedPrefix) {
      if (!safeExecPatterns.includes(suggestedPrefix)) {
        safeExecPatterns.push(suggestedPrefix);
        config.safeExecPatterns = [...new Set(safeExecPatterns)];
        try {
          await saveConfig(config);
          addTranscriptEntry(tuiState, 'status', `[saved prefix] ${suggestedPrefix}`);
        } catch (err) {
          addTranscriptEntry(
            tuiState,
            'warning',
            `Failed to persist trusted prefix: ${err.message || String(err)}`,
          );
        }
      } else {
        addTranscriptEntry(tuiState, 'status', `[prefix already trusted] ${suggestedPrefix}`);
      }
    } else {
      addTranscriptEntry(tuiState, 'status', 'No prefix suggestion available; approved once.');
    }

    if (tuiState.approval) {
      pushTranscriptEntry(tuiState, {
        role: 'verdict',
        verdict: 'APPROVED',
        kind: tuiState.approval.kind,
        summary: tuiState.approval.summary,
        trustedPrefix: suggestedPrefix || null,
        timestamp: Date.now(),
      });
    }

    approvalResolve(true);
    approvalResolve = null;
    closeApprovalPane();
    setRunState('running');
    tuiState.dirty.add('all');
    scheduler.schedule();
  }

  function denyAction() {
    if (approvalResolve) {
      if (tuiState.approval) {
        pushTranscriptEntry(tuiState, {
          role: 'verdict',
          verdict: 'DENIED',
          kind: tuiState.approval.kind,
          summary: tuiState.approval.summary,
          timestamp: Date.now(),
        });
      }
      approvalResolve(false);
      approvalResolve = null;
      closeApprovalPane();
      setRunState('running');
      tuiState.dirty.add('all');
      scheduler.schedule();
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
    const fallback =
      visibleBlocks[visibleBlocks.length - 1] ||
      tuiState.payloadBlocks[tuiState.payloadBlocks.length - 1] ||
      null;
    if (!fallback) {
      io.stdout.write('\x07');
      return;
    }
    setActiveOverlayModal('payload_inspector');
    const cursorExists =
      tuiState.payloadCursorId &&
      tuiState.payloadBlocks.some((b) => b.id === tuiState.payloadCursorId);
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
    const nextIdx =
      currentIdx >= 0
        ? (currentIdx + delta + visibleBlocks.length) % visibleBlocks.length
        : delta >= 0
          ? 0
          : visibleBlocks.length - 1;
    tuiState.payloadCursorId = visibleBlocks[nextIdx].id;
    tuiState.dirty.add('transcript');
    scheduler.schedule();
  }

  function toggleFocusedPayloadBlock() {
    const visibleBlocks = getVisiblePayloadBlocks();
    const block =
      visibleBlocks.find((b) => b.id === tuiState.payloadCursorId) || visibleBlocks[0] || null;
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
      tuiState.scrollOffset = Math.max(
        0,
        tuiState.scrollOffset - Math.max(1, Math.floor(rows / 3)),
      );
      tuiState.dirty.add('transcript');
      scheduler.schedule();
    }
  }

  function clearViewport() {
    io.stdout.write(ESC.clearScreen);
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
    const targetModel = config[target.id]?.model || newConfig.defaultModel;

    // Daemon mode: route through `update_session`. Provider+model are
    // submitted together so the daemon applies the atomic-selection
    // rule (a provider change snaps the model to the new provider's
    // default if no model is supplied — we supply one explicitly here
    // to preserve any per-provider model preference from the config).
    if (daemonClient?.connected && daemonSessionId) {
      try {
        const res = await daemonClient.request(
          'update_session',
          {
            sessionId: daemonSessionId,
            attachToken: daemonAttachToken,
            patch: { provider: target.id, model: targetModel },
          },
          daemonSessionId,
        );
        if (!res.ok) {
          addTranscriptEntry(
            tuiState,
            'error',
            res.error?.message || 'Daemon rejected provider switch',
          );
          scheduler.flush();
          return;
        }
        hydrateSessionStateFromDaemon(res.payload);
      } catch (err) {
        addTranscriptEntry(
          tuiState,
          'error',
          `Daemon error during provider switch: ${err.message}`,
        );
        scheduler.flush();
        return;
      }
    } else {
      ctx.providerConfig = newConfig;
      ctx.apiKey = newApiKey;
      state.provider = target.id;
      state.model = targetModel;
      await saveSessionState(state);
    }

    // Persist current default provider (user preference for new sessions).
    config.provider = target.id;
    await saveConfig(config);
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
      tuiState.providerModalCursor = moveCursorCircular(
        tuiState.providerModalCursor,
        providers.length,
        action.delta,
      );
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

  async function openConfigModal() {
    setActiveOverlayModal('config');
    tuiState.configModalState = {
      mode: 'list',
      cursor: 0,
      editTarget: '',
      editBuf: '',
      editCursor: 0,
      pickCursor: 0,
      remoteStatusLabel: await getRemoteStatusLabel(),
    };
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
    return getProviderList().length + 6;
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
      const current =
        process.env.PUSH_LOCAL_SANDBOX ||
        (config.localSandbox !== undefined ? String(config.localSandbox) : 'off');
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
    } else if (index === providers.length + 4) {
      // TUI daemon autostart → toggle directly
      const isOn = isTuiDaemonAutoStartEnabled(config);
      config.tuiDaemonAutoStart = !isOn;
      process.env.PUSH_TUI_DAEMON_AUTOSTART = String(!isOn);
      await saveConfig(config);
      if (!isOn) {
        daemonAutoStartAttempted = false;
        await ensureDaemonConnected({ announce: true });
      }
    } else if (index === providers.length + 5) {
      // Remote relay → show status + command hints in the transcript.
      await handleRemoteCommand('status');
      ms.remoteStatusLabel = await getRemoteStatusLabel();
    }
    tuiState.dirty.add('all');
    scheduler.flush();
  }

  // After a config secret is persisted, tell the running daemon to re-read
  // config.json and overwrite its inherited provider-key env. pushd resolves
  // keys live from process.env per run but inherited that env at spawn, so
  // without this nudge a key rotated in the TUI would never reach the daemon
  // that actually serves the turn — the bug this whole path fixes. Best-effort:
  // the on-disk write already succeeded, so a daemon that's gone, mid-restart,
  // or too old to know the verb just picks the key up on its next (re)start.
  async function notifyDaemonConfigReload() {
    const client = daemonClient;
    if (!client?.connected) return;
    try {
      await client.request('reload_config', {}, null, 3000);
    } catch (err) {
      if (err?.code === 'UNSUPPORTED_REQUEST_TYPE') return; // older daemon — expected
      const message = err instanceof Error ? err.message : String(err);
      io.stderr.write(
        `${JSON.stringify({ level: 'warn', event: 'tui_config_reload_notify_failed', message })}\n`,
      );
    }
  }

  async function saveConfigKey(targetId, secret) {
    if (targetId === 'tavily') {
      config.tavilyApiKey = secret;
      await saveConfig(config);
      process.env.PUSH_TAVILY_API_KEY = secret;
      await notifyDaemonConfigReload();
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

    await notifyDaemonConfigReload();
  }

  // ── Exit promise ─────────────────────────────────────────────────

  let exitResolve;
  const exitPromise = new Promise((resolve) => {
    exitResolve = resolve;
  });

  // ── Bracketed paste state ────────────────────────────────────────

  const PASTE_START = '\x1b[200~';
  const PASTE_END = '\x1b[201~';
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
      ms.editBuf =
        ms.editBuf.slice(0, ms.editCursor) + normalized + ms.editBuf.slice(ms.editCursor);
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
      ms.renameBuf =
        ms.renameBuf.slice(0, ms.renameCursor) + normalized + ms.renameBuf.slice(ms.renameCursor);
      ms.renameCursor += normalized.length;
      tuiState.dirty.add('all');
      scheduler.schedule();
      return;
    }

    // For non-text modals, ignore paste rather than mutating the hidden composer.
    if (
      getActiveOverlayModal() ||
      (tuiState.runState === 'awaiting_approval' && tuiState.approval)
    ) {
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

  // Focus stack: ordered key-scope resolution (highest priority first).
  // Borrowed from giggles' "each component owns its keys" model — scopes
  // claim the keys they own and let the rest fall through to the next scope.
  // The whole dispatch now lives here, in precedence order:
  //   approval pane → ask-user → overlay modal → tab completion →
  //   global keybinds → composer.
  // The composer is the bottom scope; a key no scope claims is a deliberate
  // no-op. Behavior is identical to the prior hand-rolled cascade.
  const focusStack = new FocusStack({
    // A scope that throws is surfaced into the transcript (the display-safe
    // error path) rather than crashing the input loop or corrupting the frame.
    onError: (scopeId, _key, err) => handleAsyncError(err, `focus scope ${scopeId}`),
  })
    .register({
      // Approval pane is the only *soft* scope today: its handleKey returns
      // true for every key while open (hard-modal in practice), but we honor
      // the fall-through contract so future non-modal panes can let unhandled
      // keys reach the global keybind map.
      id: 'approval_pane',
      isActive: () => tuiState.runState === 'awaiting_approval' && !!tuiState.approvalPane,
      handleKey: (key) => tuiState.approvalPane?.handleKey?.(key) === true,
    })
    .register({
      // Ask-user modal captures typed text — hard-modal, consumes everything.
      id: 'ask_user',
      isActive: () => tuiState.runState === 'awaiting_user_question' && !!tuiState.userQuestion,
      handleKey: (key) => {
        handleQuestionInput(key);
        return true;
      },
    })
    .register({
      // UI overlay modals (config / reasoning / payload / model / provider /
      // resume) — hard-modal; each consumes everything while open.
      id: 'overlay_modal',
      isActive: () => getActiveOverlayModal() !== null,
      handleKey: (key) => {
        switch (getActiveOverlayModal()) {
          case 'config':
            runAsync(() => handleConfigModalInput(key), 'config input failed');
            return true;
          case 'reasoning':
            handleReasoningModalInput(key);
            return true;
          case 'payload_inspector':
            handlePayloadInspectorInput(key);
            return true;
          case 'model':
            runAsync(() => handleModelModalInput(key), 'model picker input failed');
            return true;
          case 'provider':
            runAsync(() => handleProviderModalInput(key), 'provider switch failed');
            return true;
          case 'resume':
            runAsync(() => handleResumeModalInput(key), 'resume picker input failed');
            return true;
          default:
            return false;
        }
      },
    })
    .register({
      // Tab completion owns Tab while idle; any non-Tab key resets the
      // completer's state before falling through. Mirrors the prior
      // tab-intercept + reset that sat just above the keybind map.
      id: 'tab_completion',
      isActive: () => true,
      handleKey: (key) => {
        if (key.name === 'tab') {
          // Tab outside idle falls through (it may be a configured keybind).
          if (tuiState.runState !== 'idle') return false;
          const result = tabCompleter.tab(composer.getText(), key.shift);
          if (result) {
            composer.setText(result.text);
            tuiState.dirty.add('composer');
            scheduler.schedule();
          }
          return true;
        }
        // Any non-Tab keystroke resets completion, then falls through.
        tabCompleter.reset();
        return false;
      },
    })
    .register({
      // Global keybind map — the configurable action layer. Unbound keys
      // fall through to the composer scope below.
      id: 'global_keybinds',
      isActive: () => true,
      handleKey: (key) => {
        const action = keybinds.lookup(key);
        switch (action) {
          case 'send':
            runAsync(() => sendMessage(), 'send failed');
            return true;
          case 'newline':
            composer.insertNewline();
            tuiState.dirty.add('composer');
            scheduler.schedule();
            return true;
          case 'cancel_or_exit':
            if (tuiState.runState === 'running') {
              // Local turn → abort its controller (which also cancels the daemon
              // run for a local daemon turn). Reattached daemon run → cancel over
              // the socket. Neither handle available → fall through to exit so
              // Ctrl+C is never a dead key (Codex #744).
              if (runAbort) {
                cancelRun();
              } else if (!cancelDaemonRun()) {
                exitResolve();
              }
            } else {
              exitResolve();
            }
            return true;
          case 'toggle_tools':
            toggleTools();
            return true;
          case 'toggle_tool_json_payloads':
            toggleToolJsonPayloads();
            return true;
          case 'toggle_reasoning':
            toggleReasoningModal();
            return true;
          case 'clear_viewport':
            clearViewport();
            return true;
          case 'reattach':
            runAsync(() => openResumeModal(), 'session picker failed');
            return true;
          case 'approve':
            approveAction();
            return true;
          case 'deny':
            denyAction();
            return true;
          case 'provider_switcher':
            openProviderSwitcher();
            return true;
          case 'close_modal':
            closeModal();
            return true;
          case 'line_start':
            composer.moveHome();
            tuiState.dirty.add('composer');
            scheduler.schedule();
            return true;
          case 'line_end':
            composer.moveEnd();
            tuiState.dirty.add('composer');
            scheduler.schedule();
            return true;
          case 'kill_line_backward':
            composer.killLineBackward();
            tuiState.dirty.add('composer');
            scheduler.schedule();
            return true;
          case 'kill_line_forward':
            composer.killLineForward();
            tuiState.dirty.add('composer');
            scheduler.schedule();
            return true;
          case 'kill_word_backward':
            composer.killWordBackward();
            tuiState.dirty.add('composer');
            scheduler.schedule();
            return true;
          case 'delete_or_exit':
            if (composer.isEmpty() && tuiState.runState === 'idle') {
              exitResolve();
            } else {
              composer.deleteForward();
              tuiState.dirty.add('composer');
              scheduler.schedule();
            }
            return true;
          case 'word_left':
            composer.moveWordLeft();
            tuiState.dirty.add('composer');
            scheduler.schedule();
            return true;
          case 'word_right':
            composer.moveWordRight();
            tuiState.dirty.add('composer');
            scheduler.schedule();
            return true;
          case 'scroll_up': {
            const { rows } = getTermSize();
            const step = Math.max(1, Math.floor(rows / 3));
            tuiState.scrollOffset += step;
            tuiState.dirty.add('transcript');
            scheduler.schedule();
            return true;
          }
          case 'scroll_down': {
            const { rows } = getTermSize();
            const step = Math.max(1, Math.floor(rows / 3));
            tuiState.scrollOffset = Math.max(0, tuiState.scrollOffset - step);
            tuiState.dirty.add('transcript');
            scheduler.schedule();
            return true;
          }
          default:
            return false;
        }
      },
    })
    .register({
      // Composer is the bottom scope: printable input, editing keys, and
      // single-line input-history recall. Keys it doesn't recognize fall
      // through to a deliberate no-op (handledBy: null), exactly as before.
      id: 'composer',
      isActive: () => true,
      handleKey: (key) => {
        // Printable char (no modifiers) → insert.
        if (key.ch && !key.ctrl && !key.meta) {
          composer.insertChar(key.ch);
          tuiState.dirty.add('composer');
          scheduler.schedule();
          return true;
        }
        switch (key.name) {
          case 'backspace':
            composer.backspace();
            tuiState.dirty.add('composer');
            scheduler.schedule();
            return true;
          case 'delete':
            composer.deleteForward();
            tuiState.dirty.add('composer');
            scheduler.schedule();
            return true;
          case 'left':
            composer.moveLeft();
            tuiState.dirty.add('composer');
            scheduler.schedule();
            return true;
          case 'right':
            composer.moveRight();
            tuiState.dirty.add('composer');
            scheduler.schedule();
            return true;
          case 'up': {
            // Input history: recall older entry when on first line with
            // single-line content.
            if (composer.getLines().length === 1 && composer.getCursor().line === 0) {
              const recalled = inputHistory.up(composer.getText());
              if (recalled !== null) {
                composer.setText(recalled);
                tuiState.dirty.add('composer');
                scheduler.schedule();
                return true;
              }
            }
            composer.moveUp();
            tuiState.dirty.add('composer');
            scheduler.schedule();
            return true;
          }
          case 'down': {
            // Input history: recall newer entry when navigating.
            if (inputHistory.isNavigating()) {
              const recalled = inputHistory.down(composer.getText());
              if (recalled !== null) {
                composer.setText(recalled);
                tuiState.dirty.add('composer');
                scheduler.schedule();
                return true;
              }
            }
            composer.moveDown();
            tuiState.dirty.add('composer');
            scheduler.schedule();
            return true;
          }
          case 'home':
            composer.moveHome();
            tuiState.dirty.add('composer');
            scheduler.schedule();
            return true;
          case 'end':
            composer.moveEnd();
            tuiState.dirty.add('composer');
            scheduler.schedule();
            return true;
          default:
            return false;
        }
      },
    });

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

    // Resolve the key through the focus stack: approval pane → ask-user →
    // overlay modal → tab completion → global keybinds → composer (bottom).
    // A key no scope claims (`handledBy: null`) is a deliberate no-op, exactly
    // as the prior hand-rolled cascade left unrecognized keys.
    focusStack.dispatch(key);
  }

  io.stdin.on('data', onData);

  // Test-only seam (TUI Decomposition Phase 0): the input listener is now
  // wired, so a headless harness can begin feeding keystrokes. Polling earlier
  // signals (e.g. the "Connected" status, emitted near the top of setup) races
  // this registration and drops the first keystrokes. Production passes nothing.
  options.onInputReady?.();

  // ── Signal handling ─────────────────────────────────────────────

  function dumpSessionTranscript(sessionState) {
    try {
      const messages = sessionState?.messages ?? [];
      const userAndAssistant = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
      if (userAndAssistant.length === 0) return;
      io.stdout.write('\n─── Session transcript ───\n\n');
      for (const msg of userAndAssistant) {
        if (msg.role === 'user') {
          const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          // Skip synthetic system-injected messages (e.g. [SESSION_RESUMED])
          if (text.startsWith('[') && text.includes(']')) continue;
          io.stdout.write(`> ${text.slice(0, 500)}\n\n`);
        } else if (msg.role === 'assistant') {
          const raw = typeof msg.content === 'string' ? msg.content : '';
          // Strip JSON tool call fences, keeping only prose
          const cleaned = raw.replace(/```(?:json)?\s*\n?\{[\s\S]*?\}\s*\n?```/g, '').trim();
          if (cleaned) io.stdout.write(`${cleaned.slice(0, 800)}\n\n`);
        }
      }
      io.stdout.write('─────────────────────────\n\n');
    } catch {
      /* best-effort */
    }
  }

  function emergencyCleanup() {
    try {
      if (sessionPersisted) dumpSessionTranscript(state);
    } catch {
      /* best-effort */
    }
    try {
      io.stdout.write(
        ESC.mouseOff + ESC.bracketedPasteOff + ESC.cursorShow + ESC.altScreenOff + ESC.reset,
      );
      if (io.stdin.isTTY) io.stdin.setRawMode(false);
    } catch {
      /* best-effort */
    }
  }

  function onSignal(sig) {
    emergencyCleanup();
    io.exit(128 + (sig === 'SIGTERM' ? 15 : sig === 'SIGHUP' ? 1 : 2));
  }

  function onUncaughtException(err) {
    emergencyCleanup();
    io.stderr.write(`\nPush TUI fatal: ${err?.message || err}\n`);
    io.exit(1);
  }

  io.addSignalHandler('SIGTERM', onSignal);
  io.addSignalHandler('SIGHUP', onSignal);
  io.addSignalHandler('uncaughtException', onUncaughtException);

  // ── Resize handler ───────────────────────────────────────────────

  function onResize() {
    tuiState.dirty.add('all');
    scheduler.flush();
  }
  io.stdout.on('resize', onResize);

  // ── Initial render ───────────────────────────────────────────────

  scheduler.flush();

  // ── Session picker on startup ──────────────────────────────────
  // When starting a fresh session (no --session flag), auto-show the
  // session picker if previous sessions exist so the user can resume.
  if (!options.sessionId) {
    try {
      const existingSessions = await deps.listSessions();
      if (existingSessions.length > 0) {
        await openResumeModal();
      }
    } catch {
      /* best-effort — just start fresh if listing fails */
    }
  }

  // ── Wait for exit ────────────────────────────────────────────────

  try {
    await exitPromise;
  } finally {
    // ── Cleanup ──────────────────────────────────────────────────
    clearInterval(gitStatusInterval);
    cancelPendingReconnectTimer();
    stopFrameTicker();
    scheduler.destroy();
    io.stdin.removeListener('data', onData);
    io.stdout.removeListener('resize', onResize);
    io.removeSignalHandler('SIGTERM', onSignal);
    io.removeSignalHandler('SIGHUP', onSignal);
    io.removeSignalHandler('uncaughtException', onUncaughtException);

    if (runAbort) runAbort.abort();

    // Disconnect from daemon (session continues in background)
    if (daemonClient) {
      daemonClient.close();
      daemonClient = null;
    }

    io.stdout.write(
      ESC.mouseOff + ESC.bracketedPasteOff + ESC.cursorShow + ESC.altScreenOff + ESC.reset,
    );
    if (io.stdin.isTTY) {
      io.stdin.setRawMode(false);
    }
    io.stdin.pause();

    if (sessionPersisted) {
      dumpSessionTranscript(state);
      await saveSessionState(state);
    }
  }

  return 0;
}
