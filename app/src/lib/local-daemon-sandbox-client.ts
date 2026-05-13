/**
 * local-daemon-sandbox-client.ts — Non-React wrapper around the
 * loopback WebSocket adapter (`local-daemon-binding`) for callers
 * that can't reach the React hook layer (`useLocalDaemon`).
 *
 * Scope (PR 3c.1 → 3c.3):
 *   - `execLocalDaemon`: run a shell command via pushd's `sandbox_exec`
 *     handler and return an `ExecResult`-shaped payload. The dispatch
 *     seam in `sandbox-tools.ts` forks on session binding and calls
 *     this when the active session is `kind: 'local-pc'`.
 *   - `identifyLocalDaemon`: fetch `{ tokenId, boundOrigin, daemonVersion,
 *     protocolVersion }` via the `daemon_identify` handler. Used by
 *     LocalPcChatScreen (or its predecessors) to fill paired-state UI.
 *   - `readFileLocalDaemon` / `writeFileLocalDaemon` /
 *     `listDirLocalDaemon` / `getDiffLocalDaemon` (3c.3): per-tool
 *     daemon ops. Each mirrors a `sandbox_*` cloud helper. Result
 *     shapes are deliberately minimal — version cache, workspace
 *     revision, and cloud-side optimistic concurrency are not modeled
 *     yet; runtime callers treat the daemon return as authoritative.
 *
 * Transport: each call opens a transient binding. WS handshakes are
 * ~10ms on loopback so per-call cost is acceptable for proof-of-concept;
 * a future PR may reuse a long-lived binding for tighter latency once
 * the chat hot path actually drives this.
 */
import {
  DaemonRequestError,
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
  /**
   * Phase 3 slice 2: 'device' means the connection used the durable
   * device token; 'attach' means a short-lived device-attach token.
   * Optional for older daemons that don't yet emit this field.
   */
  authKind?: 'device' | 'attach';
}

/**
 * Phase 3 slice 2: result shape of `mint_device_attach_token`. The
 * secret `token` is exposed exactly once at mint time. The web
 * pairing flow persists it in IndexedDB (replacing the durable
 * device token) and uses it for subsequent WS upgrades.
 */
export interface LocalDaemonAttachTokenMintResult {
  token: string;
  tokenId: string;
  /** Server-side TTL in ms. The web can plan a re-mint before expiry. */
  ttlMs: number;
  /** Device tokenId this attach token is bound to. */
  parentTokenId: string;
}

export interface LocalDaemonExecOptions {
  cwd?: string;
  timeoutMs?: number;
  /**
   * Phase 1.f daemon-side mid-run cancellation. When supplied, the
   * client generates a `runId`, includes it in the `sandbox_exec`
   * payload, and — if the signal fires before the response arrives —
   * sends a `cancel_run` request over the SAME WS binding (so it
   * lands in the daemon's per-connection active-runs map). The
   * outer `withTransientBinding` promise rejects with an `AbortError`
   * once the cancel is dispatched; the daemon's eventual `cancelled:
   * true` response is observed and ignored by the binding's pending-
   * request cleanup. Absent signal preserves the legacy "best-effort"
   * behaviour where the child runs to its own 60s timeout.
   */
  abortSignal?: AbortSignal;
  /**
   * Optional caller-supplied runId. Tests pass a deterministic value
   * to assert the cancel envelope shape. Production callers leave
   * this empty and the client generates a UUID-shaped id.
   */
  runId?: string;
}

/**
 * Result shape of `sandbox_read_file` on the daemon. Intentionally
 * smaller than the cloud `FileReadResult`: the daemon doesn't run a
 * version cache or track workspace revisions yet, so `version` and
 * `workspace_revision` are omitted entirely (not stubbed). Dispatch
 * forks that need optimistic-concurrency edits should treat a
 * daemon-backed read as unversioned. A future PR may extend this
 * once the daemon side gains per-path versioning.
 */
export interface LocalDaemonReadFileResult {
  content: string;
  truncated: boolean;
  totalLines?: number;
  error?: string;
  code?: string;
}

/** Args for `sandbox_read_file` on the daemon. */
export interface LocalDaemonReadFileOptions {
  startLine?: number;
  endLine?: number;
}

/** Result of `sandbox_write_file` on the daemon. */
export interface LocalDaemonWriteFileResult {
  ok: boolean;
  bytesWritten?: number;
  error?: string;
}

/** One entry returned by `sandbox_list_dir` on the daemon. */
export interface LocalDaemonDirEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size?: number;
}

/** Result of `sandbox_list_dir` on the daemon. */
export interface LocalDaemonListDirResult {
  entries: LocalDaemonDirEntry[];
  truncated: boolean;
  error?: string;
}

/** Result of `sandbox_diff` on the daemon. */
export interface LocalDaemonDiffResult {
  diff: string;
  truncated: boolean;
  gitStatus?: string;
  error?: string;
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
  // Generate a per-call runId when the caller passes an abortSignal so
  // the cancel envelope has a stable target on the daemon side. The id
  // is also included in the exec payload so the daemon registers the
  // child in its per-WS activeRuns map keyed by this id. Without a
  // signal we still mint an id so any future cancel surface (e.g. a
  // dropped connection cleanup) has something to address — registration
  // is cheap and the daemon clears the entry in its `finally`.
  const runId = opts.runId ?? generateRunId();
  const payload: Record<string, unknown> = { command, runId };
  if (opts.cwd) payload.cwd = opts.cwd;
  if (opts.timeoutMs !== undefined) payload.timeoutMs = opts.timeoutMs;

  const response = await withTransientBinding(
    binding,
    (handle) =>
      handle.request<LocalDaemonExecResult>({
        type: 'sandbox_exec',
        payload,
        // Give the WS request itself a slightly larger window than the
        // command's own timeout so the daemon has time to surface a
        // timeout-killed response without us beating it with a transport
        // timeout. Default 60s command + 5s slack.
        timeoutMs: (opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) + 5_000,
      }),
    { abortSignal: opts.abortSignal, runId },
  );
  return response.payload;
}

function generateRunId(): string {
  const buf = new Uint8Array(8);
  globalThis.crypto.getRandomValues(buf);
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  return `run_${Date.now().toString(36)}_${hex}`;
}

/**
 * Read a file via the paired pushd. `path` is interpreted on the
 * daemon's local filesystem — the daemon resolves it relative to its
 * cwd or as an absolute path; the web layer does not assume a
 * `/workspace` prefix here. Optional `startLine` / `endLine` are
 * 1-based inclusive when provided.
 */
export async function readFileLocalDaemon(
  binding: LocalPcBinding,
  path: string,
  opts: LocalDaemonReadFileOptions = {},
): Promise<LocalDaemonReadFileResult> {
  const payload: Record<string, unknown> = { path };
  if (opts.startLine !== undefined) payload.startLine = opts.startLine;
  if (opts.endLine !== undefined) payload.endLine = opts.endLine;

  const response = await withTransientBinding(binding, (handle) =>
    handle.request<LocalDaemonReadFileResult>({
      type: 'sandbox_read_file',
      payload,
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    }),
  );
  return response.payload;
}

/**
 * Write a file via the paired pushd. Creates intermediate directories.
 * The daemon does not enforce version-cache concurrency today — the
 * write is unconditional. A future PR can pass `expectedVersion` once
 * the daemon side tracks per-path versions.
 */
export async function writeFileLocalDaemon(
  binding: LocalPcBinding,
  path: string,
  content: string,
): Promise<LocalDaemonWriteFileResult> {
  const response = await withTransientBinding(binding, (handle) =>
    handle.request<LocalDaemonWriteFileResult>({
      type: 'sandbox_write_file',
      payload: { path, content },
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    }),
  );
  return response.payload;
}

/**
 * List a directory via the paired pushd. `path` is optional and
 * defaults to the daemon's cwd.
 */
export async function listDirLocalDaemon(
  binding: LocalPcBinding,
  path?: string,
): Promise<LocalDaemonListDirResult> {
  const payload: Record<string, unknown> = {};
  if (path) payload.path = path;

  const response = await withTransientBinding(binding, (handle) =>
    handle.request<LocalDaemonListDirResult>({
      type: 'sandbox_list_dir',
      payload,
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    }),
  );
  return response.payload;
}

/**
 * Fetch `git diff HEAD` + `git status --porcelain` via the paired
 * pushd. The daemon shells out git in its cwd.
 */
export async function getDiffLocalDaemon(binding: LocalPcBinding): Promise<LocalDaemonDiffResult> {
  const response = await withTransientBinding(binding, (handle) =>
    handle.request<LocalDaemonDiffResult>({
      type: 'sandbox_diff',
      payload: {},
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
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
 * Phase 3 slice 2: mint a device-attach token via the paired daemon.
 * Requires a device-token-authenticated WS — the call MUST be made
 * while the binding's bearer is still the durable device token. The
 * caller is responsible for persisting the result (replacing the
 * device token in the paired-device record) and discarding the
 * device token afterwards.
 *
 * Returns null when the daemon refuses the mint (most commonly:
 * the caller authed with an attach token already, which the daemon
 * gates with `DEVICE_TOKEN_REQUIRED`). The caller treats null as
 * "already upgraded, no-op."
 */
export async function mintAttachTokenViaDaemon(
  binding: LocalPcBinding,
): Promise<LocalDaemonAttachTokenMintResult | null> {
  try {
    const response = await withTransientBinding(binding, (handle) =>
      handle.request<LocalDaemonAttachTokenMintResult>({ type: 'mint_device_attach_token' }),
    );
    return response.payload;
  } catch (err) {
    // DEVICE_TOKEN_REQUIRED — the binding's already on an attach
    // token. That's a no-op from the caller's POV: pairing already
    // upgraded. Other DaemonRequestError codes (UNSUPPORTED_VIA_
    // TRANSPORT etc.) shouldn't reach here because we're calling
    // over WS, but we collapse to null defensively.
    if (
      err instanceof DaemonRequestError &&
      (err.code === 'DEVICE_TOKEN_REQUIRED' || err.code === 'UNSUPPORTED_VIA_TRANSPORT')
    ) {
      return null;
    }
    throw err;
  }
}

export interface WithTransientBindingOptions {
  /**
   * Phase 1.f daemon-side mid-run cancel. When supplied alongside a
   * `runId`, an abort fired before the response arrives sends a
   * `cancel_run` over the same binding to interrupt the daemon's
   * registered child process, then rejects the outer promise with
   * an `AbortError`. The cancel envelope is best-effort: if the
   * connection drops mid-send, the daemon's WS-close cleanup aborts
   * its active runs anyway.
   */
  abortSignal?: AbortSignal;
  /** runId to send with the cancel envelope. Required when abortSignal is set. */
  runId?: string;
}

/**
 * Open a binding, await it reaching `open`, run `fn`, and close.
 * Exported for tests so consumers can mock the transient lifecycle.
 */
export async function withTransientBinding<T>(
  binding: LocalPcBinding,
  fn: (handle: LocalDaemonBinding) => Promise<SessionResponse<T>>,
  opts: WithTransientBindingOptions = {},
): Promise<SessionResponse<T>> {
  return new Promise<SessionResponse<T>>((resolve, reject) => {
    // Two phases of "settled":
    //   - `dispatched`: the open/timeout/unreachable branch we took
    //     after the binding stabilized. Guards against double-dispatch
    //     of `fn` if multiple status transitions fire.
    //   - `outerSettled`: the outer promise has resolved or rejected.
    //     Guards against the race between `fn`'s normal completion and
    //     a mid-flight abort — the first to land wins; the other is
    //     swallowed. We also need this split because the abort path
    //     needs to reject the outer promise WHILE the in-flight `fn`
    //     is still awaiting the daemon response, which the previous
    //     "finish once" model didn't allow.
    let dispatched = false;
    let outerSettled = false;
    let openTimer: ReturnType<typeof setTimeout> | null = null;
    let abortListener: (() => void) | null = null;
    let handleRef: LocalDaemonBinding | null = null;

    const detachAbort = () => {
      if (abortListener && opts.abortSignal) {
        opts.abortSignal.removeEventListener('abort', abortListener);
      }
      abortListener = null;
    };
    const settleOuter = (settler: () => void) => {
      if (outerSettled) return;
      outerSettled = true;
      if (openTimer) {
        clearTimeout(openTimer);
        openTimer = null;
      }
      detachAbort();
      settler();
      // Close the handle once after the outer promise has settled.
      // Idempotent: createLocalDaemonBinding's close() guards against
      // double-close itself.
      if (handleRef) handleRef.close();
    };

    const rejectAbort = () => {
      if (outerSettled) return;
      outerSettled = true;
      if (openTimer) {
        clearTimeout(openTimer);
        openTimer = null;
      }
      detachAbort();
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    };

    const handle = createLocalDaemonBinding({
      port: binding.port,
      token: binding.token,
      host: LOCAL_PC_HOST,
      onStatus: (status) => {
        if (status.state === 'connecting') return;
        if (dispatched) return; // already routed past `open` or terminal
        if (status.state === 'open') {
          dispatched = true;
          // Replace the pre-open abort listener (if any) with the
          // post-open one. The post-open listener additionally sends
          // a `cancel_run` envelope so the daemon SIGTERMs the
          // registered child; pre-open the WS isn't authenticated yet
          // so cancel_run has nowhere to land and we just reject.
          detachAbort();
          if (opts.abortSignal && opts.runId) {
            const runId = opts.runId;
            const fireAbort = () => {
              // The cancel_run promise is observed only for its
              // close-coordination side effect: we want the WS to stay
              // open long enough for the cancel frame to leave the
              // socket. Closing the handle synchronously alongside
              // `reject(AbortError)` races the send buffer flush and
              // can drop the frame before the daemon sees it. Tying
              // the close to the cancel request's settlement (either
              // its 5s timeout or the daemon's reply) is the simplest
              // way to guarantee delivery without exposing a separate
              // "flush" knob on the binding.
              const cancelPromise = handle
                .request<{ accepted: boolean; runId?: string }>({
                  type: 'cancel_run',
                  payload: { runId },
                  timeoutMs: 5_000,
                })
                .catch(() => {});
              rejectAbort();
              // Defer the close until the cancel envelope has either
              // been acked or timed out — see comment above.
              void cancelPromise.then(() => {
                if (handleRef) handleRef.close();
              });
            };
            abortListener = fireAbort;
            opts.abortSignal.addEventListener('abort', abortListener, { once: true });
            if (opts.abortSignal.aborted) {
              fireAbort();
              return;
            }
          }
          void fn(handle)
            .then((response) => {
              settleOuter(() => resolve(response));
            })
            .catch((err) => {
              settleOuter(() => {
                if (opts.abortSignal?.aborted) {
                  const aborted = new Error('The operation was aborted');
                  aborted.name = 'AbortError';
                  reject(aborted);
                } else {
                  reject(err);
                }
              });
            });
          return;
        }
        // unreachable | closed before we sent — surface as a typed
        // error so the dispatch fork can decide whether to prompt
        // re-pair or fall back. The adapter intentionally collapses
        // auth-fail / wrong-port / network-error into "unreachable"
        // (browsers hide the upgrade response from JS); we honor that.
        dispatched = true;
        settleOuter(() => {
          if (opts.abortSignal?.aborted) {
            // The pre-open abort listener already closed the WS and
            // triggered the terminal status. Reject as AbortError so
            // callers can distinguish "user cancelled" from "daemon
            // unreachable" on `err.name` (#517 review).
            const aborted = new Error('The operation was aborted');
            aborted.name = 'AbortError';
            reject(aborted);
          } else {
            reject(new LocalDaemonUnreachableError(status.reason));
          }
        });
      },
    });
    handleRef = handle;

    // Pre-open abort handling. If the signal fires while the WS is
    // still `connecting`, we don't have an authenticated socket to
    // send `cancel_run` over, so the strategy is: close the WS
    // (terminating the connection attempt) and reject the outer
    // promise with AbortError. The post-open `onStatus` branch swaps
    // this for the cancel_run-aware listener once authenticated.
    // (#517 review: pre-open abort previously surfaced as
    // LocalDaemonUnreachableError, masking the user's cancel intent.)
    if (opts.abortSignal) {
      const preOpenAbort = () => {
        // If we've already advanced to `open`, the post-open listener
        // owns the abort path (and has the runId/cancel-run context).
        // The `dispatched` guard handles concurrent open + abort.
        if (dispatched) return;
        dispatched = true;
        rejectAbort();
        // Close the in-flight connect so the WS handshake doesn't
        // keep going. rejectAbort intentionally doesn't close (the
        // post-open path needs to defer close until cancel_run flushes
        // — see fireAbort above), so we explicitly close here.
        if (handleRef) handleRef.close();
      };
      abortListener = preOpenAbort;
      opts.abortSignal.addEventListener('abort', preOpenAbort, { once: true });
      if (opts.abortSignal.aborted) {
        preOpenAbort();
      }
    }

    // Backstop: if neither `open` nor a terminal status fires within
    // OPEN_TIMEOUT_MS, treat it as unreachable. The adapter's own
    // error events almost always fire faster than this, but a
    // pathological network state (SYN held by kernel) can hang it.
    openTimer = setTimeout(() => {
      if (dispatched) return;
      dispatched = true;
      settleOuter(() => {
        reject(new LocalDaemonUnreachableError('timed out before connection opened'));
      });
    }, OPEN_TIMEOUT_MS);
  });
}
