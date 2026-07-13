/**
 * tui-status.ts — Status bar utilities for the Push TUI.
 * Context estimation, git status formatting, and status bar rendering.
 */

import { visibleWidth, truncate, padTo } from './tui-renderer.js';
import { getGitInfo } from './workspace-context.js';
import { liveFrame, moodVerb } from './tui-spinner.js';
import type { Theme, TokenName } from './tui-theme.js';
import type { WorkspaceStateView } from '../lib/workspace-state.js';

// ── Token estimation ────────────────────────────────────────────────

interface Message {
  content?: unknown;
}

/**
 * Rough token estimator (1 token ≈ 4 chars for English text).
 * Fast approximation for UI feedback.
 */
export function estimateTokens(text: string | Message[] | unknown): number {
  if (!text) return 0;
  // Handle arrays of messages (session.messages format)
  if (Array.isArray(text)) {
    return text.reduce((sum: number, msg: Message) => {
      const content = typeof msg?.content === 'string' ? msg.content : '';
      return sum + estimateTokens(content);
    }, 0);
  }
  // Handle single string
  const str = String(text);
  // Use character count / 4 as a rough heuristic
  return Math.ceil(str.length / 4);
}

/**
 * Format token count for display (compact).
 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}k`;
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}m`;
  }
  return `${Math.round(tokens / 1000)}k`;
}

/**
 * Format an elapsed duration as `Ys` for < 60s, otherwise `Xm Ys`.
 * Negative or NaN inputs are clamped to 0.
 *
 * Used by the running indicator to show how long the current turn
 * has been in progress. We deliberately don't show
 * sub-second precision — the row updates ~10×/s via the animation
 * ticker, but seconds-resolution is the right grain for "is the agent
 * stuck or making progress" reading.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${s}s`;
}

// ── Git status ──────────────────────────────────────────────────────

export interface CompactGitStatus {
  branch: string;
  dirty: number;
  ahead: number;
  behind: number;
}

/**
 * Get compact git status for the status bar.
 * Returns { branch, dirty, ahead, behind } or null if not a git repo.
 */
export async function getCompactGitStatus(cwd: string): Promise<CompactGitStatus | null> {
  const info = await getGitInfo(cwd);
  if (!info) return null;

  const dirtyCount =
    info.modified.length +
      info.added.length +
      info.deleted.length +
      info.untracked.length +
      info.renamed.length +
      info.copied.length +
      info.conflicted.length || 0;

  return {
    branch: info.branch,
    dirty: dirtyCount,
    ahead: info.ahead,
    behind: info.behind,
  };
}

/**
 * Format git status for status bar display.
 */
export function formatGitStatus(status: CompactGitStatus | null, maxWidth: number = 30): string {
  if (!status) return '—';

  const parts: string[] = [status.branch];

  if (status.dirty > 0) {
    parts.push(`+${status.dirty}`);
  }
  if (status.ahead > 0) {
    parts.push(`↑${status.ahead}`);
  }
  if (status.behind > 0) {
    parts.push(`↓${status.behind}`);
  }

  const result = parts.join(' ');
  return truncate(result, maxWidth);
}

/**
 * Format the reduced workspace-state timeline for compact ambient display.
 * This mirrors `formatGitStatus` but includes the runtime guards that are not
 * part of ordinary git status: Protect Main and sandbox readiness.
 */
export function formatWorkspaceStateView(
  view: WorkspaceStateView | null,
  maxWidth: number = 40,
): string {
  if (!view) return '—';

  const { state } = view;
  const parts: string[] = [state.activeBranch || 'HEAD'];
  parts.push(state.dirtyFiles.length > 0 ? `+${state.dirtyFiles.length}` : 'clean');
  if (typeof state.ahead === 'number' && state.ahead > 0) {
    parts.push(`↑${state.ahead}`);
  }
  if (typeof state.behind === 'number' && state.behind > 0) {
    parts.push(`↓${state.behind}`);
  }
  parts.push(state.protectMain ? 'protect-main' : 'no-protect-main');
  parts.push(state.sandboxReady ? 'sandbox-ready' : 'sandbox-wait');

  return truncate(parts.join(' '), maxWidth);
}

function formatWorkspaceStateGuardSuffix(view: WorkspaceStateView | null): string {
  if (!view) return '';

  const { state } = view;
  return [
    state.protectMain ? 'protect-main' : 'no-protect-main',
    state.sandboxReady ? 'sandbox-ready' : 'sandbox-wait',
  ].join(' ');
}

// ── Path formatting ─────────────────────────────────────────────────

/**
 * Shorten a path for display.
 * Replaces home directory with ~ and truncates if too long.
 */
export function shortenPath(cwd: string, maxWidth: number = 40): string {
  const homeDir = process.env.HOME || '';
  const shortCwd = homeDir && cwd.startsWith(homeDir) ? '~' + cwd.slice(homeDir.length) : cwd;
  return truncate(shortCwd, maxWidth);
}

// ── Context meter ────────────────────────────────────────────────────

interface ContextBudget {
  maxTokens?: number;
}

/**
 * Build a visual context meter bar showing token usage vs. budget.
 * Returns a styled string like "▰▰▰▰▱▱▱▱ 42k/100k"
 */
export function formatContextMeter(
  tokens: number,
  budget: ContextBudget | null,
  theme: Theme,
  barWidth: number = 8,
): string {
  const maxTokens = budget?.maxTokens || 100_000;
  const ratio = Math.max(0, Math.min(1, (tokens || 0) / maxTokens));
  const filled = Math.round(ratio * barWidth);
  const empty = barWidth - filled;

  // Color based on usage: green < 60%, yellow 60-85%, red > 85%
  const color: TokenName =
    ratio > 0.85 ? 'state.error' : ratio > 0.6 ? 'state.warn' : 'state.success';
  const filledChar = theme.unicode ? '▰' : '#';
  const emptyChar = theme.unicode ? '▱' : '-';
  const bar =
    theme.style(color, filledChar.repeat(filled)) + theme.style('fg.dim', emptyChar.repeat(empty));
  const label = `${formatTokenCount(tokens)}/${formatTokenCount(maxTokens)}`;
  return `${bar} ${theme.style('fg.dim', label)}`;
}

// ── Status bar rendering ────────────────────────────────────────────

interface StatusBarPart {
  icon: string;
  text: string;
  color: TokenName;
  width: number;
  raw?: boolean;
}

interface LayoutFooter {
  top: number;
  left: number;
  width: number;
}

interface Layout {
  footer: LayoutFooter;
}

interface ScreenBuffer {
  writeLine: (row: number, col: number, text: string) => void;
}

interface FileEntry {
  status: string;
}

interface FileAwareness {
  total: number;
  files: FileEntry[];
}

/**
 * Persistent indicator for whether the TUI is dispatching turns through
 * a paired `pushd` daemon or running them inline. Updated whenever the
 * TUI's daemon connection state changes; sits next to git/cwd/context
 * so a glance at the footer answers "where are my turns going."
 *
 * `phase` reflects the live connection state machine: `connected` (turns
 * flow through the daemon), `inline` (no daemon, never connected this
 * session), or `reconnecting` (daemon disconnected and the TUI is
 * retrying with exponential backoff — turns sent right now run inline
 * but the chip's countdown tells the user we'll be back). `reconnect`
 * carries the live retry metadata so the footer can render a
 * `reconnect Ns (try N)` countdown without needing extra state
 * plumbing from the TUI module.
 */
export interface DaemonStatusIndicator {
  /** True when the chip should render as "daemon" (green). Drives the
   * existing colour rules. Backwards-compatible with callers that only
   * pass `{ connected }`. */
  connected: boolean;
  phase?: 'connected' | 'inline' | 'reconnecting';
  reconnect?: {
    /** 1-based count of retry attempts since the disconnect. */
    attempt: number;
    /** Seconds remaining until the next attempt fires. Clamped to
     * non-negative; the footer rerenders on each frame tick. */
    secondsUntilNextRetry: number;
  } | null;
}

interface StatusBarOptions {
  gitStatus?: CompactGitStatus | null;
  workspaceStateView?: WorkspaceStateView | null;
  cwd?: string;
  tokens?: number;
  isStreaming?: boolean;
  messageCount?: number;
  contextBudget?: ContextBudget | null;
  fileAwareness?: FileAwareness | null;
  daemonStatus?: DaemonStatusIndicator | null;
  /** Frame tick for subtle LIVE / meter motion. */
  tick?: number;
}

/**
 * Render the enhanced status bar.
 * Shows: git branch | cwd | context meter | file awareness | [live indicator]
 */
export function renderStatusBar(
  buf: ScreenBuffer,
  layout: Layout,
  theme: Theme,
  {
    gitStatus = null,
    workspaceStateView = null,
    cwd = '',
    tokens = 0,
    isStreaming = false,
    messageCount = 0,
    contextBudget = null,
    fileAwareness = null,
    daemonStatus = null,
    tick = 0,
  }: StatusBarOptions,
): void {
  const { top, left, width } = layout.footer;
  const { glyphs } = theme;

  // Build status components
  const parts: StatusBarPart[] = [];

  // Workspace / Git section
  if (gitStatus) {
    const gitStr = formatGitStatus(gitStatus, workspaceStateView ? 38 : 25);
    const guardSuffix = formatWorkspaceStateGuardSuffix(workspaceStateView);
    const workspaceStr = truncate([gitStr, guardSuffix].filter(Boolean).join(' '), 38);
    const workspaceColor: TokenName =
      gitStatus.dirty > 0 ||
      (workspaceStateView &&
        (!workspaceStateView.state.protectMain || !workspaceStateView.state.sandboxReady))
        ? 'state.warn'
        : 'accent.link';
    parts.push({
      icon: glyphs.branch || '',
      text: workspaceStr,
      color: workspaceColor,
      width: visibleWidth(workspaceStr),
    });
  } else if (workspaceStateView) {
    const workspaceStr = formatWorkspaceStateView(workspaceStateView, 38);
    const workspaceState = workspaceStateView.state;
    const workspaceColor: TokenName =
      workspaceState.dirtyFiles.length > 0 ||
      !workspaceState.protectMain ||
      !workspaceState.sandboxReady
        ? 'state.warn'
        : 'accent.link';
    parts.push({
      icon: glyphs.branch || '',
      text: workspaceStr,
      color: workspaceColor,
      width: visibleWidth(workspaceStr),
    });
  }

  // Path section
  const pathStr = shortenPath(cwd, 35);
  parts.push({
    icon: glyphs.folder || '',
    text: pathStr,
    color: 'fg.secondary',
    width: visibleWidth(pathStr),
  });

  // Daemon connection chip. Always shown when the indicator is
  // supplied so the user can tell at a glance whether the next turn
  // goes through pushd (sessions persist) or runs inline (vanishes
  // when the TUI exits). `connected` → green chip; otherwise dim. The
  // chip is dropped entirely when the caller passes null so callers
  // that don't track daemon state (e.g. a one-shot smoke test) don't
  // see a misleading "inline" label.
  //
  // `reconnecting` is a distinct third state: the daemon disconnected
  // and the TUI is retrying. We render an amber `reconnect Ns (try N)`
  // chip so the disconnect is visible the moment it happens and the
  // countdown tells the user we will be back without them having to
  // restart the TUI. Falls through to the `connected ? daemon : inline`
  // branch when no `phase` is supplied so old callers keep their two-
  // state behaviour.
  if (daemonStatus) {
    const phase = daemonStatus.phase ?? (daemonStatus.connected ? 'connected' : 'inline');
    let text: string;
    let color: TokenName;
    if (phase === 'connected') {
      text = 'daemon';
      color = 'state.success';
    } else if (phase === 'reconnecting') {
      const r = daemonStatus.reconnect;
      const secs = r ? Math.max(0, r.secondsUntilNextRetry) : 0;
      const attempt = r ? r.attempt : 0;
      text = `reconnect ${secs}s (try ${attempt})`;
      color = 'state.warn';
    } else {
      text = 'inline';
      color = 'fg.dim';
    }
    parts.push({
      icon: '',
      text,
      color,
      width: visibleWidth(text),
    });
  }

  // Context meter (visual bar + tokens/budget)
  if (contextBudget) {
    const meter = formatContextMeter(tokens, contextBudget, theme);
    parts.push({
      icon: '',
      text: meter,
      color: 'fg.dim',
      width: visibleWidth(meter),
      raw: true,
    });
  } else {
    // Fallback: simple token count
    const tokenStr = formatTokenCount(tokens);
    const ctxText = `${messageCount} msgs · ${tokenStr}tk`;
    parts.push({
      icon: '',
      text: ctxText,
      color: 'fg.dim',
      width: visibleWidth(ctxText),
    });
  }

  // File awareness section
  if (fileAwareness && fileAwareness.total > 0) {
    const reads = fileAwareness.files.filter(
      (f: FileEntry) => f.status === 'fully_read' || f.status === 'partial_read',
    ).length;
    const writes = fileAwareness.files.filter(
      (f: FileEntry) => f.status === 'model_authored',
    ).length;
    let fileText = `${fileAwareness.total} files`;
    if (writes > 0) fileText += ` (${writes}w)`;
    else if (reads > 0) fileText += ` (${reads}r)`;
    parts.push({
      icon: '',
      text: fileText,
      color: 'fg.dim',
      width: visibleWidth(fileText),
    });
  }

  // Live indicator (only when streaming) — cycling glyph signals "still live".
  let liveIndicator = '';
  if (isStreaming) {
    const glyph = liveFrame(tick);
    liveIndicator = theme.style('state.warn', ` ${glyph} LIVE `);
  }

  // Build the line
  let line = '';

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i > 0) {
      line += theme.style('fg.dim', ' │ ');
    }
    if (part.icon) {
      line += theme.style(part.color, part.icon + ' ');
    }
    if (part.raw) {
      line += part.text;
    } else {
      line += theme.style(part.color, part.text);
    }
  }

  // Pad and add live indicator
  const lineWidth = visibleWidth(line);
  const liveWidth = liveIndicator ? visibleWidth(liveIndicator) : 0;
  const padding = Math.max(0, width - lineWidth - liveWidth - 2);
  line += ' '.repeat(padding) + liveIndicator;

  buf.writeLine(top, left, padTo(line, width));
}

type RunState = 'running' | 'awaiting_approval' | 'awaiting_user_question' | string;

interface TuiState {
  runState: RunState;
  payloadInspectorOpen: boolean;
  toolJsonPayloadsExpanded: boolean;
  activityInspectorOpen?: boolean;
  // Session id used to seed the mood-verb pick when running without an
  // activity-specific verb.
  session?: string;
}

/**
 * Render keybind hints line (secondary footer line).
 */
export function renderKeybindHints(
  buf: ScreenBuffer,
  layout: Layout,
  theme: Theme,
  tuiState: TuiState,
  keybindHints: unknown,
): void {
  const { top, left, width } = layout.footer;
  const line = top + 1;

  // Muted token for the key labels so the whole hint row sits close to
  // the divider — matches the reserved bullet-led shape used elsewhere.
  const keyToken = 'fg.muted';

  // Left: keybind hints
  let leftHints: string;
  if (tuiState.runState === 'awaiting_approval') {
    leftHints = [
      theme.style(keyToken, 'Ctrl+Y / y') + theme.style('fg.dim', ' approve'),
      theme.style(keyToken, 'a') + theme.style('fg.dim', ' always'),
      theme.style(keyToken, 'Ctrl+N / n') + theme.style('fg.dim', ' deny'),
      theme.style(keyToken, 'Esc') + theme.style('fg.dim', ' dismiss'),
    ].join('  ');
  } else if (tuiState.runState === 'awaiting_user_question') {
    leftHints = [
      theme.style(keyToken, 'Enter') + theme.style('fg.dim', ' submit answer'),
      theme.style(keyToken, 'Esc') + theme.style('fg.dim', ' skip'),
    ].join('  ');
  } else if (tuiState.activityInspectorOpen) {
    leftHints = [
      theme.style(keyToken, 'j/k,↑↓') + theme.style('fg.dim', ' move'),
      theme.style(keyToken, 'Enter') + theme.style('fg.dim', ' toggle phase'),
      theme.style(keyToken, 'Space') + theme.style('fg.dim', ' details'),
      theme.style(keyToken, 'a') + theme.style('fg.dim', ' toggle all'),
      theme.style(keyToken, 'Esc / Ctrl+T') + theme.style('fg.dim', ' close'),
    ].join('  ');
  } else if (tuiState.payloadInspectorOpen) {
    leftHints = [
      theme.style(keyToken, 'j/k,↑↓') + theme.style('fg.dim', ' move'),
      theme.style(keyToken, 'Enter') + theme.style('fg.dim', ' toggle'),
      theme.style(keyToken, 'a') +
        theme.style(
          'fg.dim',
          tuiState.toolJsonPayloadsExpanded ? ' all:expanded' : ' all:collapsed',
        ),
      theme.style(keyToken, 'Esc / Ctrl+O') + theme.style('fg.dim', ' close'),
    ].join('  ');
  } else {
    leftHints = [
      theme.style(keyToken, 'Ctrl+T') + theme.style('fg.dim', ' activity'),
      theme.style(keyToken, 'Ctrl+O') + theme.style('fg.dim', ' payloads'),
      theme.style(keyToken, 'Ctrl+G') + theme.style('fg.dim', ' reasoning'),
      theme.style(keyToken, 'Ctrl+C') + theme.style('fg.dim', ' cancel'),
      theme.style(keyToken, 'Ctrl+R') + theme.style('fg.dim', ' sessions'),
      theme.style(keyToken, 'Ctrl+P') + theme.style('fg.dim', ' provider'),
    ].join('  ');
  }

  // Right: state indicator. Swaps the mechanical 'running' for the same
  // mood verb the header picks, so both ends of the screen agree.
  const runningLabel = moodVerb(tuiState.session);
  const stateLabel =
    tuiState.runState === 'running'
      ? theme.style('state.warn', runningLabel)
      : tuiState.runState === 'awaiting_approval'
        ? theme.style('state.error', 'awaiting approval')
        : tuiState.runState === 'awaiting_user_question'
          ? theme.style('accent.primary', 'awaiting answer')
          : tuiState.activityInspectorOpen
            ? theme.style('accent.secondary', 'activity inspect')
            : tuiState.payloadInspectorOpen
              ? theme.style('accent.secondary', 'payload inspect')
              : theme.style('state.success', 'idle');

  // Layout left/right
  const rightWidth = visibleWidth(stateLabel);
  const leftWidth = width - rightWidth - 2;
  const leftStr = truncate(leftHints, leftWidth);
  const rightStr = stateLabel;

  buf.writeLine(line, left, padTo(leftStr, leftWidth) + '  ' + rightStr);
}
