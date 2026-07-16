/**
 * remote-execution-handlers.ts — daemon-backed sandbox execution and identity.
 *
 * Extracted from cli/pushd.ts (Pushd Decomposition Plan, Phase 2). This module
 * owns command validation, allowlist authorization, output bounds, transport-
 * scoped cancellation registration, execution audit emission, and the WS-only
 * daemon identity response.
 */
import path from 'node:path';
import process from 'node:process';

import { PROTOCOL_VERSION } from '../../lib/protocol-schema.js';
import type { ExecSandboxOptions } from '../exec-sandbox.js';
import { appendAuditEvent, shouldLogCommandText, truncateForAudit } from '../pushd-audit-log.js';
import { isPathAllowed, snapshotAllowlist } from '../pushd-allowlist.js';
import { RUNTIME_VERSION } from '../build-stamp.js';
import { auditProvenance } from './audit-provenance.js';
import { makeErrorResponse, makeResponse, type DaemonResponse } from './envelopes.js';
import type { DaemonEmitEvent, DaemonHandlerContext, DaemonRequest } from './handler-types.js';

const SANDBOX_EXEC_DEFAULT_TIMEOUT_MS = 60_000;
const SANDBOX_EXEC_MAX_TIMEOUT_MS = 300_000;
const SANDBOX_EXEC_MAX_OUTPUT = 256_000;

interface ExecFailure {
  name?: string;
  message?: string;
  code?: string | number;
  killed?: boolean;
  stdout?: unknown;
  stderr?: unknown;
}

function outputLength(value: unknown): number {
  if (typeof value === 'string' || Buffer.isBuffer(value)) return value.length;
  return 0;
}

export async function handleSandboxExec(
  req: DaemonRequest,
  _emitEvent: DaemonEmitEvent,
  context?: DaemonHandlerContext | null,
): Promise<DaemonResponse> {
  const payload = req.payload || {};
  const command = typeof payload.command === 'string' ? payload.command : '';
  // Pre-execution denial audits (#521 Codex P2). These early returns sit
  // outside the outcome finally block, so each denial emits explicitly.
  if (!command) {
    void appendAuditEvent({
      type: 'tool.sandbox_exec',
      ...auditProvenance(context),
      payload: { ok: false, errorCode: 'INVALID_REQUEST' },
    });
    return makeErrorResponse(
      req.requestId,
      'sandbox_exec',
      'INVALID_REQUEST',
      'sandbox_exec requires a non-empty `command` string in payload.',
    );
  }

  const rawTimeout =
    typeof payload.timeoutMs === 'number' && Number.isFinite(payload.timeoutMs)
      ? payload.timeoutMs
      : SANDBOX_EXEC_DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(Math.max(rawTimeout, 1_000), SANDBOX_EXEC_MAX_TIMEOUT_MS);
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();

  // The allowlist remains the authorization boundary. Native containment may
  // add a mount/network boundary after this check, but never replaces it.
  const cwdSnapshot = await snapshotAllowlist(process.cwd());
  if (!isPathAllowed(path.resolve(cwd), cwdSnapshot)) {
    void appendAuditEvent({
      type: 'tool.sandbox_exec',
      ...auditProvenance(context),
      payload: { ok: false, errorCode: 'PATH_NOT_ALLOWED', cwd },
    });
    return makeErrorResponse(
      req.requestId,
      'sandbox_exec',
      'PATH_NOT_ALLOWED',
      `sandbox_exec cwd is not in the daemon allowlist: ${cwd}`,
    );
  }

  // Register cancellation in the transport-owned active-runs map. Relay runs
  // carry the DO-stamped sender id so another paired phone cannot cancel them
  // by guessing a run id; loopback runs remain connection-scoped.
  const runId = typeof payload.runId === 'string' && payload.runId ? payload.runId : null;
  const runOwnerId =
    typeof context?.relaySenderId === 'string' && context.relaySenderId
      ? context.relaySenderId
      : null;
  const wsState = context?.wsState;
  let abortController: AbortController | null = null;
  if (runId && wsState && wsState.activeRuns instanceof Map) {
    abortController = new AbortController();
    wsState.activeRuns.set(runId, { controller: abortController, ownerId: runOwnerId });
  }

  const startedAt = Date.now();
  const { runCommandInExecSandbox } = await import('../exec-sandbox.js');
  const { scrubEnv } = await import('../env-scrub.js');

  let auditExitCode = 0;
  let auditCancelled = false;
  let auditTimedOut = false;
  let auditTruncated = false;
  try {
    const execOpts: ExecSandboxOptions = {
      cwd,
      timeout: timeoutMs,
      maxBuffer: SANDBOX_EXEC_MAX_OUTPUT,
      env: scrubEnv(),
    };
    if (abortController) execOpts.signal = abortController.signal;
    const { stdout, stderr } = await runCommandInExecSandbox(command, cwd, execOpts);
    // Reaching the success path means maxBuffer was not exceeded.
    return makeResponse(req.requestId, 'sandbox_exec', null, true, {
      stdout: truncateExecOutput(stdout),
      stderr: truncateExecOutput(stderr),
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      truncated: false,
    });
  } catch (err) {
    const failure = err as ExecFailure;
    // Abort path: distinguish a user-requested cancel from a timeout
    // so the model gets the right `cancelled` flag and won't retry
    // it as if it had timed out.
    const wasAborted = failure.name === 'AbortError' || Boolean(abortController?.signal.aborted);
    const killed = Boolean(failure.killed);
    // maxBuffer overflow surfaces as a string err.code AND
    // err.killed === true. Distinguish it from a timeout so the
    // model gets an accurate `truncated` and isn't misled into
    // "command timed out" when the real signal was "output too big."
    const isMaxBufferOverflow = failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    const isTimeout = killed && !isMaxBufferOverflow && !wasAborted;
    const exitCode =
      typeof failure.code === 'number' ? failure.code : killed || wasAborted ? 124 : 1;
    // Defensive: also flag truncation if the captured output actually
    // exceeds the cap, even if Node didn't tag the error code (some
    // runtimes / future Node versions may shift the contract).
    const capturedTooLarge =
      outputLength(failure.stdout) > SANDBOX_EXEC_MAX_OUTPUT ||
      outputLength(failure.stderr) > SANDBOX_EXEC_MAX_OUTPUT;
    auditExitCode = exitCode;
    auditCancelled = wasAborted;
    auditTimedOut = isTimeout;
    auditTruncated = isMaxBufferOverflow || capturedTooLarge;
    return makeResponse(req.requestId, 'sandbox_exec', null, true, {
      stdout: truncateExecOutput(failure.stdout ?? ''),
      stderr: truncateExecOutput(failure.stderr ?? failure.message ?? ''),
      exitCode,
      durationMs: Date.now() - startedAt,
      truncated: auditTruncated,
      timedOut: isTimeout,
      cancelled: wasAborted,
    });
  } finally {
    if (runId && wsState && wsState.activeRuns instanceof Map) {
      wsState.activeRuns.delete(runId);
    }
    void appendAuditEvent({
      type: 'tool.sandbox_exec',
      ...auditProvenance(context),
      runId: runId ?? undefined,
      payload: {
        cwd,
        exitCode: auditExitCode,
        durationMs: Date.now() - startedAt,
        cancelled: auditCancelled,
        timedOut: auditTimedOut,
        truncated: auditTruncated,
        command: shouldLogCommandText() ? truncateForAudit(command) : undefined,
      },
    });
  }
}

function truncateExecOutput(text: unknown): string {
  if (typeof text !== 'string') return '';
  if (text.length <= SANDBOX_EXEC_MAX_OUTPUT) return text;
  return `${text.slice(0, SANDBOX_EXEC_MAX_OUTPUT)}\n…[truncated]`;
}

export async function handleDaemonIdentify(
  req: DaemonRequest,
  _emitEvent: DaemonEmitEvent,
  context?: DaemonHandlerContext | null,
): Promise<DaemonResponse> {
  // Identify reports the durable parent device, not a rotating attach token.
  const auth = context?.auth;
  if (!auth) {
    return makeErrorResponse(
      req.requestId,
      'daemon_identify',
      'UNSUPPORTED_VIA_TRANSPORT',
      'daemon_identify is only available over the WebSocket transport.',
    );
  }
  return makeResponse(req.requestId, 'daemon_identify', null, true, {
    tokenId: auth.parentDeviceTokenId,
    boundOrigin: auth.boundOrigin,
    daemonVersion: RUNTIME_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    authKind: auth.kind,
  });
}
