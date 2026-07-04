/**
 * reconnect-nudge.ts — shared "try now" wiring for the daemon/relay
 * connection hooks (GOpencode review, suggested-priority #3 — web side).
 *
 * The CLI relay client grew a `nudge()` in PR #1051: when the link is
 * parked in a backoff wait, an external "things changed" signal should
 * collapse the wait and re-dial instead of sitting out the full 30s.
 * On the web/Capacitor surface that signal is the browser environment
 * itself — the network coming back (`online`) or the app returning to
 * the foreground (`visibilitychange → visible`, which is what a
 * Capacitor webview resume fires too; the app deliberately uses
 * `visibilitychange` rather than the `@capacitor/app` plugin, matching
 * `useBackgroundCoderJob` / `useChatCheckpoint`).
 *
 * Daemon hooks share the same reconnect reducer shape, so the decision + the
 * listener wiring live here once.
 */
import type { ConnectionStatus } from '@/lib/local-daemon-binding';

/**
 * WS close code the daemon adapters use for an intentional,
 * consumer-initiated close (`ws.close(1000, 'client closing')`). A
 * connection closed this way is NOT eligible for a nudge — the consumer
 * dropped the binding on purpose. Mirrors the `CLIENT_INITIATED_CLOSE_CODE`
 * the two hooks already use for their auto-reconnect gate; kept in sync
 * by being the WS spec's "normal closure" code.
 */
export const CLIENT_INITIATED_CLOSE_CODE = 1000;

/**
 * Decide whether an environment "try now" signal should trigger an
 * immediate reconnect. Mirrors the relay client's `nudge()` no-op
 * guard: a healthy (`open`) or in-flight (`connecting`) link is left
 * untouched, and an intentional close is not revived. Everything else
 * — a pre-open `unreachable`, an abnormal `closed`, or a connection
 * sitting exhausted after the backoff ladder ran out (its last status
 * is still one of those terminals) — is a candidate.
 *
 * Pure, so the hooks can unit-test the decision without simulating DOM
 * events, exactly like `tui-daemon-reconnect.ts` on the CLI side.
 */
export function shouldNudgeReconnect(status: ConnectionStatus): boolean {
  if (status.state === 'open' || status.state === 'connecting') return false;
  if (status.state === 'unreachable') return true;
  if (status.state === 'closed') return status.code !== CLIENT_INITIATED_CLOSE_CODE;
  return false;
}

/**
 * Subscribe to the browser/Capacitor "things changed, retry now"
 * signals and invoke `handler` on each. Returns an unsubscribe fn.
 *
 * Signals:
 *  - `window` `online` — connectivity restored after an offline gap.
 *  - `document` `visibilitychange` → `visible` — the app/tab came back
 *    to the foreground (also fires on Capacitor webview resume).
 *
 * The caller owns the guard (whether a nudge is warranted right now via
 * `shouldNudgeReconnect`); this helper is purely the listener plumbing.
 * Safe in non-DOM environments (SSR / Node tests): if `window` or
 * `document` is absent the corresponding listener is simply skipped and
 * the returned cleanup is still callable.
 */
export function subscribeReconnectNudges(handler: () => void): () => void {
  const cleanups: Array<() => void> = [];

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const onOnline = () => handler();
    window.addEventListener('online', onOnline);
    cleanups.push(() => window.removeEventListener('online', onOnline));
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') handler();
    };
    document.addEventListener('visibilitychange', onVisibility);
    cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));
  }

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
