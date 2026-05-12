/**
 * local-daemon-sandbox-client.ts — Non-React wrapper around the
 * loopback WebSocket adapter (`local-daemon-binding`) for callers
 * that can't reach the React hook layer (`useLocalDaemon`).
 *
 * Scope (PR 3c.1):
 *   - `execLocalDaemon`: run a shell command via pushd's `sandbox_exec`
 *     handler and return an `ExecResult`-shaped payload. The dispatch
 *     seam in `sandbox-tools.ts` forks on session binding and calls
 *     this when the active session is `kind: 'local-pc'`.
 *   - `identifyLocalDaemon`: fetch `{ tokenId, boundOrigin, daemonVersion,
 *     protocolVersion }` via the `daemon_identify` handler. Used by
 *     LocalPcWorkspace to fill the "(unknown)" tokenId placeholder.
 *
 * Out of scope here: file ops, batch_write, diff, archive, etc. Those
 * land in 3c.2+ once the dispatch pattern is proven. Each tool follows
 * the same recipe (one pushd handler + one client method + one
 * `executeSandboxToolCall` fork case), so 3c.2+ can be Codex-friendly.
 *
 * Transport: each call opens a transient binding. WS handshakes are
 * ~10ms on loopback so per-call cost is acceptable for proof-of-concept;
 * a future PR may reuse a long-lived binding for tighter latency once
 * the chat hot path actually drives this.
 */
import {
  type LocalDaemonBinding,
  type SessionResponse,
  createLocalDaemonBinding,
} from './local-daemon-binding';
import { LOCAL_PC_HOST } from './local-pc-binding';
import type { LocalPcBinding } from '@/types';

const OPEN_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Shape of the `sandbox_exec` response payload from pushd. Mirrors
 * the cloud sandbox's `ExecResult` so the dispatch fork in
 * `executeSandboxToolCall` can return either shape without translation.
 */
export interface LocalDaemonExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
  timedOut?: boolean;
}

export interface LocalDaemonIdentity {
  tokenId: string;
  boundOrigin: string;
  daemonVersion: string;
  protocolVersion: string;
}

export interface LocalDaemonExecOptions {
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Error thrown when the transient binding can't reach the daemon
 * (token rejected, port wrong, pushd not running, origin mismatch).
 * The adapter intentionally collapses these into one bucket; callers
 * surface a "re-pair" prompt rather than guessing.
 */
export class LocalDaemonUnreachableError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`local daemon unreachable: ${reason}`);
    this.name = 'LocalDaemonUnreachableError';
    this.reason = reason;
  }
}

/**
 * Run a shell command on the paired pushd. Resolves with the
 * `sandbox_exec` response payload (non-zero exit codes included —
 * those are normal results, not errors).
 */
export async function execLocalDaemon(
  binding: LocalPcBinding,
  command: string,
  opts: LocalDaemonExecOptions = {},
): Promise<LocalDaemonExecResult> {
  const payload: Record<string, unknown> = { command };
  if (opts.cwd) payload.cwd = opts.cwd;
  if (opts.timeoutMs !== undefined) payload.timeoutMs = opts.timeoutMs;

  const response = await withTransientBinding(binding, (handle) =>
    handle.request<LocalDaemonExecResult>({
      type: 'sandbox_exec',
      payload,
      // Give the WS request itself a slightly larger window than the
      // command's own timeout so the daemon has time to surface a
      // timeout-killed response without us beating it with a transport
      // timeout. Default 60s command + 5s slack.
      timeoutMs: (opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) + 5_000,
    }),
  );
  return response.payload;
}

/** Fetch the daemon's identity for the authenticated bearer. */
export async function identifyLocalDaemon(binding: LocalPcBinding): Promise<LocalDaemonIdentity> {
  const response = await withTransientBinding(binding, (handle) =>
    handle.request<LocalDaemonIdentity>({ type: 'daemon_identify' }),
  );
  return response.payload;
}

/**
 * Open a binding, await it reaching `open`, run `fn`, and close.
 * Exported for tests so consumers can mock the transient lifecycle.
 */
export async function withTransientBinding<T>(
  binding: LocalPcBinding,
  fn: (handle: LocalDaemonBinding) => Promise<SessionResponse<T>>,
): Promise<SessionResponse<T>> {
  return new Promise<SessionResponse<T>>((resolve, reject) => {
    let settled = false;
    const finish = (handle: LocalDaemonBinding, fnArg: () => Promise<void>) => {
      if (settled) return;
      settled = true;
      void fnArg().finally(() => handle.close());
    };

    const handle = createLocalDaemonBinding({
      port: binding.port,
      token: binding.token,
      host: LOCAL_PC_HOST,
      onStatus: (status) => {
        if (status.state === 'connecting') return;
        if (status.state === 'open') {
          finish(handle, async () => {
            try {
              const response = await fn(handle);
              resolve(response);
            } catch (err) {
              reject(err);
            }
          });
          return;
        }
        // unreachable | closed before we sent — surface as a typed
        // error so the dispatch fork can decide whether to prompt
        // re-pair or fall back. The adapter intentionally collapses
        // auth-fail / wrong-port / network-error into "unreachable"
        // (browsers hide the upgrade response from JS); we honor that.
        finish(handle, async () => {
          reject(new LocalDaemonUnreachableError(status.reason));
        });
      },
    });

    // Backstop: if neither `open` nor a terminal status fires within
    // OPEN_TIMEOUT_MS, treat it as unreachable. The adapter's own
    // error events almost always fire faster than this, but a
    // pathological network state (SYN held by kernel) can hang it.
    setTimeout(() => {
      finish(handle, async () => {
        reject(new LocalDaemonUnreachableError('timed out before connection opened'));
      });
    }, OPEN_TIMEOUT_MS);
  });
}
