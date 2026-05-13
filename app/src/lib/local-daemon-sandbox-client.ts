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
 * Transport: two paths.
 *   - `LiveDaemonBinding` (preferred when the hook layer is on-screen):
 *     the per-tool helpers reuse the long-lived WebSocket owned by
 *     `useLocalDaemon` / `useRelayDaemon` via the bundled `request`
 *     fn. No per-call WS handshake; cancel_run routes through the
 *     same connection on AbortSignal.
 *   - Plain `DaemonBinding` (params only): each call opens a transient
 *     WebSocket via `withTransientBinding` (the original 2.f shape).
 *     Used by pairing-probe code paths (`identifyLocalDaemon` at
 *     onboarding, attach-token mint) and any non-hook caller that
 *     can't get to the live binding.
 */
import {
  DaemonRequestError,
  type LocalDaemonBinding,
  type RequestOptions,
  type SessionResponse,
  createLocalDaemonBinding,
} from './local-daemon-binding';
import { createRelayDaemonBinding } from './relay-daemon-binding';
import { LOCAL_PC_HOST } from './local-pc-binding';
import type { LocalPcBinding, RelayBinding } from '@/types';

/**
 * Discriminated union of every daemon binding shape the chat-layer
 * tool dispatch may carry. Phase 2.f introduced the second arm —
 * the relay binding routes through the Worker rather than the
 * loopback WS. The two shapes don't share a discriminator field, so
 * call sites pick by structural narrowing (`'deploymentUrl' in
 * binding` → relay, else local).
 *
 * Kept as a local alias instead of `LocalPcBinding | RelayBinding`
 * inline so a future third transport (e.g. a desktop wrapper IPC
 * shim from Phase 4) extends one type instead of every callsite's
 * union literal.
 */
export type DaemonBinding = LocalPcBinding | RelayBinding;

/** Shape-discriminator. Used by the per-call adapter factory and
 * by chat-layer code that needs to gate on relay-vs-local without
 * importing both binding types just for the check. */
export function isRelayBinding(binding: DaemonBinding): binding is RelayBinding {
  return 'deploymentUrl' in binding;
}

/**
 * Sandbox-client request signature, narrowed to what the tool
 * helpers need. The hook layer's `useLocalDaemon.request` /
 * `useRelayDaemon.request` already match this shape — they route
 * through the long-lived WS owned by the hook. Decoupling here
 * means a tool helper can be handed either the hook's bound
 * `request` or a transient adapter's `request` without the
 * helpers caring which side opened the connection.
 */
export type DaemonRequest = <T = unknown>(opts: RequestOptions) => Promise<SessionResponse<T>>;

/**
 * Live daemon binding: connection params plus a `request` fn bound
 * to an already-open WebSocket. When chat-layer dispatch passes
 * one of these, the per-tool helpers route through `request`
 * directly instead of opening a transient WS per call.
 *
 * `params` is preserved so chat-layer code that still needs to
 * differentiate relay-vs-local (e.g. session-card formatting) can
 * keep using `isRelayBinding(live.params)` without a separate API.
 *
 * The fn is owned by the React hook layer (`useLocalDaemon` /
 * `useRelayDaemon`). The hook closes the WS on unmount; passing
 * a stale `LiveDaemonBinding` reference after the hook unmounts
 * surfaces as "local daemon not connected" from the bound request
 * fn — which is the same failure shape an in-flight transient
 * adapter would surface mid-call.
 */
export interface LiveDaemonBinding {
  params: DaemonBinding;
  request: DaemonRequest;
}

/** Distinguishes a live (hook-bound) binding from a plain params
 * binding. */
export function isLiveDaemonBinding(
  binding: DaemonBinding | LiveDaemonBinding,
): binding is LiveDaemonBinding {
  return 'request' in binding && typeof (binding as LiveDaemonBinding).request === 'function';
}

/** What chat-layer tool dispatch carries — either shape works. */
export type ToolDispatchBinding = DaemonBinding | LiveDaemonBinding;

/**
 * Resolve a `ToolDispatchBinding` to the underlying connection
 * params. Use this for callsites that only care about transport
 * shape (e.g. "is this relay?") and don't need the request fn.
 */
export function bindingParams(binding: ToolDispatchBinding): DaemonBinding {
  return isLiveDaemonBinding(binding) ? binding.params : binding;
}

/**
 * Build a WS adapter for whichever transport the binding describes.
 * Centralises the structural discrimination so `withTransientBinding`
 * stays binding-agnostic. Accepts the same callback set
 * `createLocalDaemonBinding` does — both transports expose the same
 * `LocalDaemonBinding` interface, so callers downstream don't care
 * which kind opened the WS.
 *
 * Relay note: every tool call opens a new WS through the relay, the
 * same pattern Phase 1 uses for loopback. Loopback's ~10ms handshake
 * makes the per-call cost trivial; the relay path pays a real WAN
 * round-trip + DO routing each time. A future PR may reuse the
 * long-lived binding held by `useRelayDaemon` for chat-layer tool
 * dispatch; for 2.f, parity with the existing pattern is the
 * smaller change and isn't a regression from the loopback baseline.
 */
function createTransientAdapter(
  binding: DaemonBinding,
  callbacks: {
    onStatus?: Parameters<typeof createLocalDaemonBinding>[0]['onStatus'];
    onEvent?: Parameters<typeof createLocalDaemonBinding>[0]['onEvent'];
    onMalformed?: Parameters<typeof createLocalDaemonBinding>[0]['onMalformed'];
  } = {},
): LocalDaemonBinding {
  if (isRelayBinding(binding)) {
    return createRelayDaemonBinding({
      deploymentUrl: binding.deploymentUrl,
      sessionId: binding.sessionId,
      token: binding.token,
      ...callbacks,
    });
  }
  return createLocalDaemonBinding({
    port: binding.port,
    token: binding.token,
    host: LOCAL_PC_HOST,
    ...callbacks,
  });
}

const OPEN_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Run a one-shot daemon request against either transport. The
 * single entry point for the per-tool helpers below:
 *
 *   - Live binding → call `binding.request` directly. The hook
 *     layer owns the WS; we don't open or close anything.
 *     AbortSignal handling fires a `cancel_run` envelope (via the
 *     same long-lived WS) and rejects with `AbortError`, mirroring
 *     `withTransientBinding`'s post-open semantics.
 *   - Plain params → delegate to `withTransientBinding`, which
 *     opens a fresh WS, awaits `open`, runs the fn, and closes.
 */
export async function runWithBinding<T>(
  binding: ToolDispatchBinding,
  fn: (request: DaemonRequest) => Promise<SessionResponse<T>>,
  opts: WithTransientBindingOptions = {},
): Promise<SessionResponse<T>> {
  if (isLiveDaemonBinding(binding)) {
    return runWithLiveBinding(binding, fn, opts);
  }
  return withTransientBinding(binding, (handle) => fn((reqOpts) => handle.request(reqOpts)), opts);
}

async function runWithLiveBinding<T>(
  binding: LiveDaemonBinding,
  fn: (request: DaemonRequest) => Promise<SessionResponse<T>>,
  opts: WithTransientBindingOptions,
): Promise<SessionResponse<T>> {
  // Fast path: no abort signal. Just await the live request.
  if (!opts.abortSignal) {
    return fn(binding.request);
  }
  // Abort path: fire cancel_run on the same long-lived WS when the
  // signal trips, reject the outer promise with AbortError. We do
  // NOT close the WS — the hook owns its lifecycle.
  const abortSignal = opts.abortSignal;
  return new Promise<SessionResponse<T>>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      abortSignal.removeEventListener('abort', abortListener);
      action();
    };

    const onAbort = () => {
      if (settled) return;
      if (opts.runId) {
        // cancel_run is best-effort — the daemon's WS-close cleanup
        // covers the case where the request never makes it. Catch
        // and swallow so a cancel_run failure doesn't poison the
        // outer rejection.
        binding
          .request({ type: 'cancel_run', payload: { runId: opts.runId }, timeoutMs: 5_000 })
          .catch(() => {});
      }
      settle(() => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    };
    const abortListener = onAbort;
    abortSignal.addEventListener('abort', abortListener, { once: true });
    if (abortSignal.aborted) {
      onAbort();
      return;
    }

    fn(binding.request).then(
      (response) => settle(() => resolve(response)),
      (err) => {
        settle(() => {
          if (abortSignal.aborted) {
            const aborted = new Error('The operation was aborted');
            aborted.name = 'AbortError';
            reject(aborted);
          } else {
            reject(err);
          }
        });
      },
    );
  });
}

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
  binding: ToolDispatchBinding,
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

  const response = await runWithBinding(
    binding,
    (request) =>
      request<LocalDaemonExecResult>({
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
  binding: ToolDispatchBinding,
  path: string,
  opts: LocalDaemonReadFileOptions = {},
): Promise<LocalDaemonReadFileResult> {
  const payload: Record<string, unknown> = { path };
  if (opts.startLine !== undefined) payload.startLine = opts.startLine;
  if (opts.endLine !== undefined) payload.endLine = opts.endLine;

  const response = await runWithBinding(binding, (request) =>
    request<LocalDaemonReadFileResult>({
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
  binding: ToolDispatchBinding,
  path: string,
  content: string,
): Promise<LocalDaemonWriteFileResult> {
  const response = await runWithBinding(binding, (request) =>
    request<LocalDaemonWriteFileResult>({
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
  binding: ToolDispatchBinding,
  path?: string,
): Promise<LocalDaemonListDirResult> {
  const payload: Record<string, unknown> = {};
  if (path) payload.path = path;

  const response = await runWithBinding(binding, (request) =>
    request<LocalDaemonListDirResult>({
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
export async function getDiffLocalDaemon(
  binding: ToolDispatchBinding,
): Promise<LocalDaemonDiffResult> {
  const response = await runWithBinding(binding, (request) =>
    request<LocalDaemonDiffResult>({
      type: 'sandbox_diff',
      payload: {},
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    }),
  );
  return response.payload;
}

/** Fetch the daemon's identity for the authenticated bearer. */
export async function identifyLocalDaemon(
  binding: ToolDispatchBinding,
): Promise<LocalDaemonIdentity> {
  const response = await runWithBinding(binding, (request) =>
    request<LocalDaemonIdentity>({ type: 'daemon_identify' }),
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
  binding: ToolDispatchBinding,
): Promise<LocalDaemonAttachTokenMintResult | null> {
  try {
    const response = await runWithBinding(binding, (request) =>
      request<LocalDaemonAttachTokenMintResult>({ type: 'mint_device_attach_token' }),
    );
    return response.payload;
  } catch (err) {
    // Collapse the "already upgraded / not supported here" failure
    // modes to null so the pairing flow's "fall back to device
    // token" branch sees a clean no-op:
    //   - DEVICE_TOKEN_REQUIRED: caller is already on an attach
    //     token (re-pair after a manual upgrade attempt). No-op.
    //   - UNSUPPORTED_VIA_TRANSPORT: shouldn't reach here because
    //     we're calling over WS, but collapse defensively.
    //   - UNSUPPORTED_REQUEST_TYPE: a pre-slice-2 daemon (the
    //     dispatcher's default branch for unknown request types).
    //     This is the mixed-version case the pairing flow's
    //     fallback exists for. #519 review.
    if (
      err instanceof DaemonRequestError &&
      (err.code === 'DEVICE_TOKEN_REQUIRED' ||
        err.code === 'UNSUPPORTED_VIA_TRANSPORT' ||
        err.code === 'UNSUPPORTED_REQUEST_TYPE')
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
  binding: DaemonBinding,
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

    const handle = createTransientAdapter(binding, {
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
