/**
 * Pure renderer for a CLI-originated daemon session row in the chat
 * drawer. Lives in its own file so the parent `RepoChatDrawer`
 * module satisfies the ESLint `react-refresh/only-export-components`
 * rule (can't co-locate a non-component export with a component), and
 * so the SSR test can serialize the row without instantiating the
 * radix Sheet (its portal is dropped by `renderToStaticMarkup`).
 *
 * Read-only by design: no rename, no delete, no tap-to-resume.
 * Resume-into-mobile needs an `attach_session` + event-replay flow
 * that's out of scope for the visibility-first iteration this row
 * shipped with.
 */
import { timeAgoCompact } from '@/lib/utils';
import type { DaemonCliSession } from '@/types';

export function renderCliSessionRow(session: DaemonCliSession) {
  const label = session.sessionName.trim() || session.lastUserMessage.trim() || session.sessionId;
  const subtitle =
    session.lastUserMessage.trim() && session.sessionName.trim()
      ? session.lastUserMessage.trim()
      : session.cwd || session.sessionId;
  const isRunning = session.state === 'running';
  return (
    <div
      key={session.sessionId}
      className="flex items-center gap-1 rounded-xl border border-transparent"
      title={`${label}\n${session.cwd}\n${session.provider}/${session.model}\n${session.sessionId}`}
    >
      <div className="min-w-0 flex-1 px-2.5 py-2 text-left opacity-70">
        <p className="truncate text-push-sm text-push-fg-secondary">{label}</p>
        <p className="mt-0.5 truncate text-push-2xs text-push-fg-muted">
          {timeAgoCompact(session.updatedAt)} · {subtitle}
        </p>
      </div>
      <span
        className="mr-2 shrink-0 rounded-full border border-push-edge-subtle bg-push-surface/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-push-fg-muted"
        aria-label={isRunning ? 'CLI session, running' : 'CLI session'}
      >
        {isRunning ? 'CLI · live' : 'CLI'}
      </span>
    </div>
  );
}
