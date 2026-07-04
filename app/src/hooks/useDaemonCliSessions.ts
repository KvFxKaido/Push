/**
 * useDaemonCliSessions — fetches the attached daemon's `list_sessions`
 * once the WS reaches `open` and surfaces it as a sorted, mode-filtered
 * read model for the drawer.
 *
 * Mobile shells today don't issue `start_session` at all — every
 * session the daemon knows about is CLI- or TUI-originated. Surfacing
 * those rows in the Remote drawer's Connected section closes the
 * "I started a chat in the CLI, why don't I see it on my phone" gap
 * without trying to import the message history into IndexedDB (which
 * would require a separate `attach_session` + event-replay flow this
 * hook intentionally does NOT pull in).
 *
 * Shape:
 *   - State-only. Submission lives in `request` (passed in) because
 *     it's the daemon hook's fn and the screen knows which hook it
 *     mounted (mirrors the `useApprovalQueue` decoupling).
 *   - Refresh policy: fires once per `connecting → open` transition,
 *     plus whenever the consumer calls `refresh()` — DaemonChatBody
 *     wires it to drawer-open so the Connected section repaints each
 *     time the user looks at it. A live `session_started` listener
 *     could keep the list warm mid-session but hasn't been needed.
 *   - Filter: drops `mode === 'headless'` rows. Headless runs aren't
 *     resumable as interactive chats; they shouldn't show up next to
 *     Remote conversations.
 *
 * The classifier (`parseListSessionsPayload`) is exported separately
 * so the field-by-field shape validation has a trivially-testable
 * surface — the React state plumbing is exercised at integration time
 * by the screens that mount the hook.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ConnectionStatus, RequestOptions, SessionResponse } from '@/lib/local-daemon-binding';
import type { DaemonCliSession } from '@/types';

const DEFAULT_LIST_LIMIT = 50;

export interface UseDaemonCliSessionsResult {
  sessions: DaemonCliSession[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Coerce a single `list_sessions` row into a `DaemonCliSession`.
 * Returns `null` when the row is missing required fields — defending
 * against a daemon-side schema change that the strict-mode validator
 * didn't catch (e.g. an additive field renamed). Strictness here is
 * cheap because the daemon ships the rows fresh on every refresh, so
 * partial drift surfaces as missing rows rather than crashes.
 */
function coerceRow(row: unknown): DaemonCliSession | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (typeof r.sessionId !== 'string' || !r.sessionId) return null;
  if (typeof r.updatedAt !== 'number' || !Number.isFinite(r.updatedAt)) return null;
  return {
    sessionId: r.sessionId,
    updatedAt: r.updatedAt,
    provider: typeof r.provider === 'string' ? r.provider : 'unknown',
    model: typeof r.model === 'string' ? r.model : 'unknown',
    cwd: typeof r.cwd === 'string' ? r.cwd : '',
    sessionName: typeof r.sessionName === 'string' ? r.sessionName : '',
    lastUserMessage: typeof r.lastUserMessage === 'string' ? r.lastUserMessage : '',
    mode: typeof r.mode === 'string' && r.mode.trim() ? r.mode.trim() : 'interactive',
    state: r.state === 'running' ? 'running' : 'idle',
    activeRunId: typeof r.activeRunId === 'string' ? r.activeRunId : null,
  };
}

/**
 * Pure parser: takes a `list_sessions` response payload, drops
 * headless rows, sorts by `updatedAt` desc. Exported for tests.
 */
export function parseListSessionsPayload(payload: unknown): DaemonCliSession[] {
  if (!payload || typeof payload !== 'object') return [];
  const sessions = (payload as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) return [];
  const rows: DaemonCliSession[] = [];
  for (const raw of sessions) {
    const row = coerceRow(raw);
    if (!row) continue;
    if (row.mode === 'headless') continue;
    rows.push(row);
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows;
}

export function useDaemonCliSessions(
  request: <T = unknown>(opts: RequestOptions) => Promise<SessionResponse<T>>,
  status: ConnectionStatus,
  options: { limit?: number } = {},
): UseDaemonCliSessionsResult {
  const [sessions, setSessions] = useState<DaemonCliSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  // Track the most recent fetch nonce so a slow earlier response
  // can't clobber a fresh manual refresh. Each call captures the
  // nonce at dispatch time; the setState is gated on the current
  // ref value still matching when the response lands.
  const fetchNonceRef = useRef(0);

  const fetchOnce = useCallback(async () => {
    // Coalesce concurrent fetches into one in-flight request so a
    // burst of triggers (e.g. a `connecting → open` transition that
    // races a programmatic `refresh()`) doesn't fan out into N
    // duplicate list_sessions RPCs. The drawer's CLI section can
    // tolerate "results match the moment the first fetch started"
    // because each subsequent refresh trigger has its own
    // `connecting → open` transition or explicit call ready to
    // re-fire once this one settles. `refresh()` is wired to
    // drawer-open (DaemonChatBody), so a coalesced drop only happens
    // when a fetch is already in flight — the list the user sees is
    // then at most milliseconds stale, which a pending-refresh queue
    // wouldn't meaningfully improve.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const nonce = ++fetchNonceRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await request<{ sessions?: unknown }>({
        type: 'list_sessions',
        payload: {
          limit: options.limit ?? DEFAULT_LIST_LIMIT,
          // Ask the daemon to drop headless rows BEFORE the limit
          // slice so a user with 50 consecutive `./push run` jobs
          // doesn't end up with an empty drawer section even though
          // older interactive sessions exist on disk. The
          // parseListSessionsPayload filter below stays as defense
          // in depth (older daemons predating the param ignore it
          // silently — the strict-mode envelope schema accepts
          // additive payload fields).
          excludeModes: ['headless'],
        },
      });
      if (fetchNonceRef.current !== nonce) return;
      setSessions(parseListSessionsPayload(res?.payload));
    } catch (err) {
      if (fetchNonceRef.current !== nonce) return;
      setError(err instanceof Error ? err.message : 'list_sessions failed');
      // Leave the previous `sessions` array in place — a transient
      // network blip on a refresh shouldn't wipe the drawer's CLI
      // section. The next successful fetch overwrites.
    } finally {
      if (fetchNonceRef.current === nonce) setLoading(false);
      inFlightRef.current = false;
    }
  }, [request, options.limit]);

  // Fire once when the WS first reaches `open`. We don't refire on
  // every status churn — the manual `refresh()` callback is the
  // escape hatch for "I just kicked off a CLI session, repaint the
  // drawer."
  const lastStatusRef = useRef<ConnectionStatus['state'] | null>(null);
  useEffect(() => {
    if (status.state === 'open' && lastStatusRef.current !== 'open') {
      void fetchOnce();
    }
    lastStatusRef.current = status.state;
  }, [status.state, fetchOnce]);

  return { sessions, loading, error, refresh: fetchOnce };
}
