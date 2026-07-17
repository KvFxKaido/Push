/**
 * tui-status.ts — status FACTS for the TUI header and footer.
 *
 * Token estimation, elapsed/count formatting, git status, workspace state.
 * No rendering: `cli/silvery/surface.tsx` composes these, and
 * `cli/silvery/visual-language.ts` decides how they look.
 *
 * It did render, once. `renderStatusBar`, `renderKeybindHints`,
 * `formatContextMeter` and `formatGitStatus` wrote ANSI into the `ScreenBuffer`
 * the Silvery migration deleted, and they outlived it by writing to a buffer no
 * caller could hand them — fully tested the whole time, which is exactly why
 * nothing went red. (`formatContextMeter` had also drifted past Visual Language
 * v2 law 2, ramping success-green → warn-yellow → error-red for a context
 * meter; the live `densityMeter` uses one density ramp and no color.) A local
 * `shortenPath` went with them — the surface had long since been calling
 * `visual-language.ts`'s copy.
 */

import { truncate } from './tui-renderer.js';
import { getGitInfo } from './workspace-context.js';
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
