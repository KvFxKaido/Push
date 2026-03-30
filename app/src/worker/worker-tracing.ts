/**
 * worker-tracing.ts
 *
 * Lightweight tracing for Cloudflare Workers runtime.
 * Workers don't support the full OTel Node SDK, so this module provides
 * a minimal span API that:
 *   - Extracts W3C traceparent from incoming requests
 *   - Creates spans with proper parent context
 *   - Exports via structured logging (wlog) for correlation
 *   - Propagates trace context to upstream requests
 *
 * Track D, Harness Runtime Evolution Plan.
 */

export interface WorkerSpanContext {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  requestId: string;
}

export interface WorkerSpan {
  context: WorkerSpanContext;
  name: string;
  startTime: number;
  attributes: Record<string, string | number | boolean>;
  status: 'ok' | 'error';
  errorMessage?: string;
}

/**
 * Parse W3C traceparent header.
 * Format: version-traceId-parentId-flags
 * Example: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
 */
export function parseTraceparent(header: string | null): { traceId: string; parentSpanId: string } | null {
  if (!header) return null;
  const parts = header.split('-');
  if (parts.length < 4) return null;
  const [, traceId, parentSpanId] = parts;
  if (!traceId || traceId.length !== 32 || !parentSpanId || parentSpanId.length !== 16) return null;
  return { traceId, parentSpanId };
}

/** Generate a random 16-character hex span ID. */
export function generateSpanId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** Generate a random 32-character hex trace ID. */
export function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Create a span context from an incoming request.
 * Extracts traceparent if present, otherwise generates new IDs.
 */
export function createSpanContext(request: Request, requestId: string): WorkerSpanContext {
  const traceparent = parseTraceparent(request.headers.get('traceparent'));
  const traceId = traceparent?.traceId ?? generateTraceId();
  const parentSpanId = traceparent?.parentSpanId ?? null;
  const spanId = generateSpanId();

  return {
    traceId,
    spanId,
    parentSpanId,
    requestId,
  };
}

/**
 * Build a traceparent header for propagation to upstream services.
 */
export function buildTraceparent(ctx: WorkerSpanContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-01`;
}

/**
 * Create a child span context from a parent.
 */
export function createChildContext(parent: WorkerSpanContext, requestId?: string): WorkerSpanContext {
  return {
    traceId: parent.traceId,
    spanId: generateSpanId(),
    parentSpanId: parent.spanId,
    requestId: requestId ?? parent.requestId,
  };
}

/**
 * Run an async function within a span, automatically recording duration and errors.
 * Returns the span alongside the function result for logging.
 */
export async function withWorkerSpan<T>(
  name: string,
  parentCtx: WorkerSpanContext,
  attributes: Record<string, string | number | boolean>,
  fn: (ctx: WorkerSpanContext) => Promise<T>,
): Promise<{ result: T; span: WorkerSpan }> {
  const ctx = createChildContext(parentCtx);
  const startTime = Date.now();
  let status: 'ok' | 'error' = 'ok';
  let errorMessage: string | undefined;

  try {
    const result = await fn(ctx);
    return {
      result,
      span: { context: ctx, name, startTime, attributes, status },
    };
  } catch (err) {
    status = 'error';
    errorMessage = err instanceof Error ? err.message : String(err);
    // Re-throw after recording, but construct the span for the finally-style log
    const span: WorkerSpan = { context: ctx, name, startTime, attributes, status, errorMessage };
    // Attach span to the error for callers that want to log it
    (err as Record<string, unknown>).__workerSpan = span;
    throw err;
  }
}

/**
 * Format a completed span for structured logging.
 */
export function formatSpanForLog(span: WorkerSpan): Record<string, unknown> {
  return {
    trace_id: span.context.traceId,
    span_id: span.context.spanId,
    parent_span_id: span.context.parentSpanId,
    request_id: span.context.requestId,
    span_name: span.name,
    duration_ms: Date.now() - span.startTime,
    status: span.status,
    ...(span.errorMessage ? { error: span.errorMessage } : {}),
    ...span.attributes,
  };
}
