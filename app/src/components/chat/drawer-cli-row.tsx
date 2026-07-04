/**
 * CliSessionRow — drawer row for a CLI/TUI-originated daemon session
 * surfaced via `useDaemonCliSessions` / `useConnectedCliSessions`.
 * Lives in its own file so the parent `RepoChatDrawer` module
 * satisfies the ESLint `react-refresh/only-export-components` rule
 * (can't co-locate a non-component export with a component), and so
 * the SSR test can serialize the row directly without instantiating
 * the radix Sheet (its portal is dropped by `renderToStaticMarkup`).
 *
 * Styled Claude Code-style: title, then a green "Connected" indicator
 * with the workspace tag and recency — these rows only render while a
 * live daemon connection is feeding them, so "Connected" is honest by
 * construction.
 *
 * Tap-to-resume: when `onResume` is present the row body renders as a
 * button — a tap asks the caller to attach to this session (the caller
 * owns the `grant_session_attach` round-trip; see RelayChatScreen).
 * Absent, the row is a plain read-only div (callers without a resume
 * path). Still no rename/delete: those verbs belong
 * to the terminal that owns the session.
 */
import { timeAgoCompact } from '@/lib/utils';
import type { DaemonCliSession } from '@/types';

interface CliSessionRowProps {
  session: DaemonCliSession;
  /** Resume this session on this device. Undefined → read-only row. */
  onResume?: () => void;
}

/** Last path segment of the session's cwd — the workspace tag. */
function workspaceTag(cwd: string): string {
  const trimmed = cwd.replace(/[/\\]+$/, '');
  const segments = trimmed.split(/[/\\]/).filter(Boolean);
  return segments[segments.length - 1] ?? '';
}

export function CliSessionRow({ session, onResume }: CliSessionRowProps) {
  const label = session.sessionName.trim() || session.lastUserMessage.trim() || session.sessionId;
  const tag = workspaceTag(session.cwd) || session.sessionId;
  const isRunning = session.state === 'running';
  const body = (
    <>
      <p className="truncate text-push-sm text-push-fg-secondary">{label}</p>
      <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-push-2xs text-push-fg-muted">
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
        <span className="shrink-0 text-emerald-300">Connected</span>
        <span className="truncate">
          · {tag} · {timeAgoCompact(session.updatedAt)}
        </span>
      </p>
    </>
  );
  return (
    <div
      className={`flex items-center gap-1 rounded-xl border border-transparent ${
        onResume
          ? 'transition-colors duration-200 hover:border-push-edge-subtle hover:bg-push-surface-hover/60'
          : ''
      }`}
      title={`${label}\n${session.cwd}\n${session.provider}/${session.model}\n${session.sessionId}`}
    >
      {onResume ? (
        <button
          type="button"
          onClick={onResume}
          className="min-w-0 flex-1 spring-press px-2.5 py-2 text-left"
          aria-label={`Resume ${label}`}
        >
          {body}
        </button>
      ) : (
        <div className="min-w-0 flex-1 px-2.5 py-2 text-left">{body}</div>
      )}
      <span
        className="mr-2 shrink-0 rounded-full border border-push-edge-subtle bg-push-surface/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-push-fg-muted"
        aria-label={isRunning ? 'CLI session, running' : 'CLI session'}
      >
        {isRunning ? 'CLI · live' : 'CLI'}
      </span>
    </div>
  );
}
