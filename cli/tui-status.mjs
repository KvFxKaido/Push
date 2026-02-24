/**
 * tui-status.mjs — Status bar utilities for the Push TUI.
 * Context estimation, git status formatting, and status bar rendering.
 */

import { visibleWidth, truncate, padTo } from './tui-renderer.mjs';
import { getGitInfo } from './workspace-context.mjs';

// ── Token estimation ────────────────────────────────────────────────

/**
 * Rough token estimator (1 token ≈ 4 chars for English text).
 * Fast approximation for UI feedback.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  // Handle arrays of messages (session.messages format)
  if (Array.isArray(text)) {
    return text.reduce((sum, msg) => {
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
export function formatTokenCount(tokens) {
  if (tokens < 1000) return String(tokens);
  if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${Math.round(tokens / 1000)}k`;
}

// ── Git status ──────────────────────────────────────────────────────

/**
 * Get compact git status for the status bar.
 * Returns { branch, dirty, ahead, behind } or null if not a git repo.
 */
export async function getCompactGitStatus(cwd) {
  const info = await getGitInfo(cwd);
  if (!info) return null;
  
  const dirtyCount = info.dirtyFiles?.length || 0;
  
  // Parse ahead/behind from branch name if present (e.g., "main...origin/main [ahead 2, behind 1]")
  let ahead = 0;
  let behind = 0;
  const aheadMatch = info.branch.match(/\[ahead\s+(\d+)/);
  const behindMatch = info.branch.match(/behind\s+(\d+)\]/);
  if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
  if (behindMatch) behind = parseInt(behindMatch[1], 10);
  
  // Clean branch name (remove remote tracking info)
  const cleanBranch = info.branch.replace(/\.\.\..*$/, '').replace(/\s*\[.*\]$/, '').trim();
  
  return {
    branch: cleanBranch,
    dirty: dirtyCount,
    ahead,
    behind,
  };
}

/**
 * Format git status for status bar display.
 */
export function formatGitStatus(status, maxWidth = 30) {
  if (!status) return '—';
  
  let parts = [status.branch];
  
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

// ── Path formatting ─────────────────────────────────────────────────

/**
 * Shorten a path for display.
 * Replaces home directory with ~ and truncates if too long.
 */
export function shortenPath(cwd, maxWidth = 40) {
  const homeDir = process.env.HOME || '';
  const shortCwd = homeDir && cwd.startsWith(homeDir) ? '~' + cwd.slice(homeDir.length) : cwd;
  return truncate(shortCwd, maxWidth);
}

// ── Status bar rendering ────────────────────────────────────────────

/**
 * Render the enhanced status bar.
 * Shows: git branch | cwd | tokens | [live indicator]
 */
export function renderStatusBar(buf, layout, theme, {
  gitStatus = null,
  cwd = '',
  tokens = 0,
  isStreaming = false,
  messageCount = 0,
}) {
  const { top, left, width } = layout.footer;
  const { glyphs } = theme;
  
  // Build status components
  const parts = [];
  
  // Git section
  if (gitStatus) {
    const gitStr = formatGitStatus(gitStatus, 25);
    const branchColor = gitStatus.dirty > 0 ? 'state.warn' : 'accent.link';
    parts.push({
      icon: glyphs.branch || '',
      text: gitStr,
      color: branchColor,
      width: visibleWidth(gitStr) + (gitStatus.dirty > 0 ? 2 : 0),
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
  
  // Context section
  const tokenStr = formatTokenCount(tokens);
  const ctxText = `${messageCount} msgs · ${tokenStr}tk`;
  parts.push({
    icon: '',
    text: ctxText,
    color: 'fg.dim',
    width: visibleWidth(ctxText),
  });
  
  // Live indicator (only when streaming)
  let liveIndicator = '';
  if (isStreaming) {
    liveIndicator = theme.style('state.warn', ' ● LIVE ');
  }
  
  // Calculate spacing
  const totalContentWidth = parts.reduce((sum, p) => sum + p.width + 3, 0); // +3 for icon and spacing
  const liveWidth = liveIndicator ? visibleWidth(liveIndicator) : 0;
  const availableSpace = width - totalContentWidth - liveWidth - 4; // 4 for margins
  
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
    line += theme.style(part.color, part.text);
  }
  
  // Pad and add live indicator
  const lineWidth = visibleWidth(line);
  const padding = Math.max(0, width - lineWidth - liveWidth - 2);
  line += ' '.repeat(padding) + liveIndicator;
  
  buf.writeLine(top, left, padTo(line, width));
}

/**
 * Render keybind hints line (secondary footer line).
 */
export function renderKeybindHints(buf, layout, theme, tuiState, keybindHints) {
  const { top, left, width } = layout.footer;
  const line = top + 1;
  
  // Left: keybind hints
  let leftHints;
  if (tuiState.runState === 'awaiting_approval') {
    leftHints = [
      theme.style('accent.link', 'Ctrl+Y / y') + theme.style('fg.dim', ' approve'),
      theme.style('accent.link', 'a') + theme.style('fg.dim', ' always'),
      theme.style('accent.link', 'Ctrl+N / n') + theme.style('fg.dim', ' deny'),
      theme.style('accent.link', 'Esc') + theme.style('fg.dim', ' dismiss'),
    ].join('  ');
  } else if (tuiState.runState === 'awaiting_user_question') {
    leftHints = [
      theme.style('accent.link', 'Enter') + theme.style('fg.dim', ' submit answer'),
      theme.style('accent.link', 'Esc') + theme.style('fg.dim', ' skip'),
    ].join('  ');
  } else if (tuiState.payloadInspectorOpen) {
    leftHints = [
      theme.style('accent.link', 'j/k,↑↓') + theme.style('fg.dim', ' move'),
      theme.style('accent.link', 'Enter') + theme.style('fg.dim', ' toggle'),
      theme.style('accent.link', 'a') + theme.style('fg.dim', tuiState.toolJsonPayloadsExpanded ? ' all:expanded' : ' all:collapsed'),
      theme.style('accent.link', 'Esc / Ctrl+O') + theme.style('fg.dim', ' close'),
    ].join('  ');
  } else {
    leftHints = [
      theme.style('accent.link', 'Ctrl+T') + theme.style('fg.dim', ' tools'),
      theme.style('accent.link', 'Ctrl+O') + theme.style('fg.dim', ' payloads'),
      theme.style('accent.link', 'Ctrl+G') + theme.style('fg.dim', ' reasoning'),
      theme.style('accent.link', 'Ctrl+C') + theme.style('fg.dim', ' cancel'),
      theme.style('accent.link', 'Ctrl+P') + theme.style('fg.dim', ' provider'),
    ].join('  ');
  }
  
  // Right: state indicator
  const stateLabel = tuiState.runState === 'running'
    ? theme.style('state.warn', 'running')
    : tuiState.runState === 'awaiting_approval'
      ? theme.style('state.error', 'awaiting approval')
      : tuiState.runState === 'awaiting_user_question'
        ? theme.style('accent.primary', 'awaiting answer')
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
