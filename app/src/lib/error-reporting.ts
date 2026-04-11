/**
 * error-reporting.ts
 *
 * Captures uncaught errors (window.onerror, unhandledrejection, React render
 * crashes) and surfaces them through the existing OTel tracer as one-shot spans
 * with `recordException` + status=ERROR. No second SDK is involved — anything
 * the OTLP exporter is already pointed at will receive these events.
 *
 * Notes on filtering:
 *   - AbortError is filtered upstream by `recordSpanError` in tracing.ts.
 *   - Cross-origin "Script error." events from foreign scripts are dropped
 *     because they carry no actionable stack information.
 *   - "ResizeObserver loop limit exceeded" / "ResizeObserver loop completed
 *     with undelivered notifications." are benign browser noise from nested
 *     resize notifications; not real crashes.
 */

import { SpanKind, getPushTracer, recordSpanError, whenTracingReady } from './tracing';

export type ErrorSource = 'window-error' | 'unhandled-rejection' | 'react-render' | 'card-render';

export interface CapturedError {
  source: ErrorSource;
  error: unknown;
  attributes?: Record<string, string | number | boolean>;
}

/**
 * Maximum number of characters of a React component stack to attach as a span
 * attribute. Component stacks can be very large on deep trees, and most OTLP
 * backends apply their own size limits. Shared between RootErrorBoundary and
 * CardErrorBoundary so both sites record stacks consistently.
 */
export const MAX_COMPONENT_STACK_CHARS = 4000;

const INSTALLED_FLAG = Symbol.for('push.errorHandlersInstalled');

interface InstallableTarget extends EventTarget {
  [INSTALLED_FLAG]?: boolean;
}

/**
 * Decide whether a captured error should be silently dropped. Pure function so
 * tests can call it directly without spinning up a tracer.
 */
export function shouldSkipReport(captured: CapturedError): boolean {
  const { source, error } = captured;

  // AbortError represents intentional cancellation, not a crash.
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }

  if (source === 'window-error' && error instanceof Error) {
    // Cross-origin scripts surface as a generic "Script error." with no stack —
    // there's nothing actionable to capture.
    if (error.message === 'Script error.') return true;

    // ResizeObserver notifications that trigger another resize in the same
    // frame produce a benign browser warning. It's a well-known noise source
    // in React apps and not an actual crash.
    if (
      error.message.includes('ResizeObserver loop limit exceeded') ||
      error.message.includes('ResizeObserver loop completed with undelivered notifications')
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Extract the structured error payload from a window `error` event.
 */
export function extractWindowError(event: ErrorEvent): CapturedError {
  // ErrorEvent.error is null when the error originates from a cross-origin
  // script; fall back to a synthetic Error so the rest of the pipeline still
  // has something to record.
  const error = event.error ?? new Error(event.message || 'Unknown window error');
  const attributes: Record<string, string | number | boolean> = {};
  if (event.filename) attributes['push.error.filename'] = event.filename;
  if (typeof event.lineno === 'number' && event.lineno > 0) {
    attributes['push.error.lineno'] = event.lineno;
  }
  if (typeof event.colno === 'number' && event.colno > 0) {
    attributes['push.error.colno'] = event.colno;
  }
  return {
    source: 'window-error',
    error,
    attributes: Object.keys(attributes).length ? attributes : undefined,
  };
}

/**
 * Extract the structured error payload from an `unhandledrejection` event.
 */
export function extractRejection(event: PromiseRejectionEvent): CapturedError {
  return {
    source: 'unhandled-rejection',
    error: event.reason,
  };
}

/**
 * Maximum number of pre-bootstrap errors buffered before the oldest entries
 * are evicted. Keeps a crash loop from OOM'ing the tab while preserving the
 * most recent (and therefore most diagnostically useful) errors.
 */
export const ERROR_BUFFER_CAP = 50;

/**
 * Dispatch mode state machine:
 *   disabled  → `primeErrorReporting` was never called. Errors go to
 *               `console.warn` as a last-resort sink.
 *   buffering → primed, but the tracing SDK hasn't settled. Errors are
 *               enqueued in a bounded FIFO buffer.
 *   live      → SDK bootstrap succeeded. Errors dispatch straight to the
 *               tracer.
 *   givenup   → SDK bootstrap will never succeed (disabled, no exporters,
 *               or bootstrap threw). Errors fall back to `console.warn`.
 */
type DispatchMode = 'disabled' | 'buffering' | 'live' | 'givenup';

let dispatchMode: DispatchMode = 'disabled';
let pendingErrors: CapturedError[] = [];
let primed = false;

function dispatchToTracer(captured: CapturedError): void {
  const tracer = getPushTracer('push.errors');
  const span = tracer.startSpan(`error.${captured.source}`, {
    kind: SpanKind.INTERNAL,
    attributes: {
      'push.error.source': captured.source,
      ...(captured.attributes ?? {}),
    },
  });
  try {
    recordSpanError(span, captured.error);
  } finally {
    span.end();
  }
}

function enqueuePending(captured: CapturedError): void {
  pendingErrors.push(captured);
  // Drop the oldest so the buffer never grows unbounded. We keep the newest
  // because recent crashes are more useful for diagnosing what just broke.
  if (pendingErrors.length > ERROR_BUFFER_CAP) {
    pendingErrors.shift();
  }
}

function flushPendingToTracer(): void {
  // Snapshot and clear before iterating so a re-entrant reportError (e.g. a
  // span-export error) appends to a fresh buffer rather than mutating the
  // slice we're iterating.
  const buffered = pendingErrors;
  pendingErrors = [];
  for (const captured of buffered) {
    try {
      dispatchToTracer(captured);
    } catch (err) {
      // The tracer itself should never throw, but if it does we don't want
      // one bad span to block the rest of the flush.
      console.warn('[error-reporting] Failed to dispatch buffered error', err);
    }
  }
}

function drainPendingToConsole(reason: string): void {
  if (pendingErrors.length === 0) return;
  const count = pendingErrors.length;
  const buffered = pendingErrors;
  pendingErrors = [];
  console.warn(
    `[error-reporting] Tracing ${reason}; emitting ${count} buffered error(s) to console`,
  );
  for (const captured of buffered) {
    console.warn(`[error-reporting] ${captured.source}:`, captured.error);
  }
}

/**
 * Record an error. Behavior depends on the current dispatch mode:
 *
 *   - `live`:      dispatched immediately as a one-shot OTel span with
 *                  `recordException` + `setStatus(ERROR)`.
 *   - `buffering`: enqueued in a bounded FIFO buffer (evicts oldest on
 *                  overflow) until `primeErrorReporting`'s ready promise
 *                  settles.
 *   - `disabled` / `givenup`:
 *                  falls back to `console.warn` so errors never vanish
 *                  silently.
 *
 * This function must never throw — it's called from error boundaries and
 * global error handlers where a secondary crash would be fatal.
 */
export function reportError(captured: CapturedError): void {
  if (shouldSkipReport(captured)) return;

  try {
    switch (dispatchMode) {
      case 'live':
        dispatchToTracer(captured);
        return;
      case 'buffering':
        enqueuePending(captured);
        return;
      case 'disabled':
      case 'givenup':
        console.warn('[error-reporting]', captured.source, captured.error);
        return;
    }
  } catch (err) {
    // Swallow anything that escapes so we never crash the error pipeline.
    console.warn('[error-reporting] reportError itself threw', err);
  }
}

/**
 * Prime the reporter for the pre-bootstrap buffering window. Call this once
 * after `initPushTracing()` when tracing is enabled and has exporters. The
 * reporter will buffer new errors until `ready` settles, then flush them
 * through the tracer (on resolve) or dump them to console (on reject).
 *
 * Idempotent — a second call is a no-op even if a different `ready` promise
 * is passed.
 *
 * `ready` is injectable for tests so they can drive the state transitions
 * without going through the real tracing bootstrap.
 */
export function primeErrorReporting(ready: Promise<void> = whenTracingReady()): void {
  if (primed) return;
  primed = true;
  dispatchMode = 'buffering';

  ready.then(
    () => {
      dispatchMode = 'live';
      flushPendingToTracer();
    },
    (reason: unknown) => {
      dispatchMode = 'givenup';
      const label =
        typeof reason === 'string' && reason ? `settled as "${reason}"` : 'failed to initialize';
      drainPendingToConsole(label);
    },
  );
}

// ---------------------------------------------------------------------------
// Test-only surface
// ---------------------------------------------------------------------------

/** @internal Reset module state. Test-only. */
export function __resetErrorReportingForTesting(): void {
  dispatchMode = 'disabled';
  pendingErrors = [];
  primed = false;
}

/** @internal Inspect the current dispatch mode. Test-only. */
export function __getDispatchModeForTesting(): DispatchMode {
  return dispatchMode;
}

/** @internal Inspect the buffered error count. Test-only. */
export function __getPendingCountForTesting(): number {
  return pendingErrors.length;
}

export interface InstallOptions {
  /** Override the global target — used by tests. Defaults to `globalThis`. */
  target?: EventTarget;
  /** Override the reporter — used by tests. Defaults to `reportError`. */
  reporter?: (captured: CapturedError) => void;
}

/**
 * Wire the global `error` and `unhandledrejection` listeners into the OTel
 * pipeline. Idempotent per target — calling twice is a no-op.
 *
 * Returns a teardown function that removes both listeners (primarily for
 * tests).
 */
export function installGlobalErrorHandlers(options: InstallOptions = {}): () => void {
  const target = (options.target ?? globalThis) as InstallableTarget;
  const reporter = options.reporter ?? reportError;

  if (target[INSTALLED_FLAG]) return () => {};
  target[INSTALLED_FLAG] = true;

  const onError = (event: Event) => {
    reporter(extractWindowError(event as ErrorEvent));
  };

  const onRejection = (event: Event) => {
    reporter(extractRejection(event as PromiseRejectionEvent));
  };

  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);

  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
    target[INSTALLED_FLAG] = false;
  };
}
