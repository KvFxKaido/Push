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
 */

import { SpanKind, getPushTracer, recordSpanError } from './tracing';

export type ErrorSource = 'window-error' | 'unhandled-rejection' | 'react-render' | 'card-render';

export interface CapturedError {
  source: ErrorSource;
  error: unknown;
  attributes?: Record<string, string | number | boolean>;
}

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

  // Cross-origin scripts surface as a generic "Script error." with no stack —
  // there's nothing actionable to capture, and it's a well-known noise source.
  if (source === 'window-error' && error instanceof Error && error.message === 'Script error.') {
    return true;
  }

  // AbortError represents intentional cancellation, not a crash.
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
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
 * Record an error as a one-shot OTel span. The span starts and ends in the same
 * tick, just long enough for `recordException` and `setStatus(ERROR)` to fire
 * so the OTLP exporter ships an exception event downstream.
 */
export function reportError(captured: CapturedError): void {
  if (shouldSkipReport(captured)) return;

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
