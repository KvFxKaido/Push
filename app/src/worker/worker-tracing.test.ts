import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTraceparent,
  createChildContext,
  createSpanContext,
  formatSpanForLog,
  generateSpanId,
  generateTraceId,
  parseTraceparent,
  withWorkerSpan,
  type WorkerSpan,
  type WorkerSpanContext,
} from './worker-tracing';

// ---------------------------------------------------------------------------
// parseTraceparent
// ---------------------------------------------------------------------------

describe('parseTraceparent', () => {
  const validTraceId = 'a'.repeat(32);
  const validSpanId = 'b'.repeat(16);

  it('parses a well-formed W3C traceparent', () => {
    const header = `00-${validTraceId}-${validSpanId}-01`;
    expect(parseTraceparent(header)).toEqual({
      traceId: validTraceId,
      parentSpanId: validSpanId,
    });
  });

  it('ignores the sampled-flag field', () => {
    const header = `00-${validTraceId}-${validSpanId}-00`;
    expect(parseTraceparent(header)?.traceId).toBe(validTraceId);
  });

  it('tolerates an unknown version byte', () => {
    // The implementation does not pin the version; it just requires 4 parts
    // with correct lengths on traceId and parentSpanId.
    const header = `ff-${validTraceId}-${validSpanId}-01`;
    expect(parseTraceparent(header)).not.toBeNull();
  });

  it('returns null for a null or empty header', () => {
    expect(parseTraceparent(null)).toBeNull();
    expect(parseTraceparent('')).toBeNull();
  });

  it.each([
    ['too few parts', `00-${validTraceId}-${validSpanId}`],
    ['trace id wrong length', `00-${'a'.repeat(31)}-${validSpanId}-01`],
    ['span id wrong length', `00-${validTraceId}-${'b'.repeat(15)}-01`],
    ['empty trace id', `00--${validSpanId}-01`],
    ['empty span id', `00-${validTraceId}--01`],
  ])('returns null for malformed input: %s', (_label, header) => {
    expect(parseTraceparent(header)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// generateSpanId / generateTraceId
// ---------------------------------------------------------------------------

describe('generateSpanId', () => {
  it('returns a 16-character lowercase hex string', () => {
    const id = generateSpanId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns a different value each call (probabilistic)', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateSpanId()));
    expect(ids.size).toBe(20);
  });
});

describe('generateTraceId', () => {
  it('returns a 32-character lowercase hex string', () => {
    const id = generateTraceId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('returns a different value each call (probabilistic)', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateTraceId()));
    expect(ids.size).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// createSpanContext
// ---------------------------------------------------------------------------

describe('createSpanContext', () => {
  const traceId = 'c'.repeat(32);
  const parentSpanId = 'd'.repeat(16);

  it('adopts the trace and parent-span IDs from an incoming traceparent', () => {
    const request = new Request('https://x.test/', {
      headers: { traceparent: `00-${traceId}-${parentSpanId}-01` },
    });
    const ctx = createSpanContext(request, 'req_xyz');
    expect(ctx.traceId).toBe(traceId);
    expect(ctx.parentSpanId).toBe(parentSpanId);
    expect(ctx.requestId).toBe('req_xyz');
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
    // The new span must not collide with the parent span (it is a child span).
    expect(ctx.spanId).not.toBe(parentSpanId);
  });

  it('generates fresh IDs with no parent when no traceparent is present', () => {
    const ctx = createSpanContext(new Request('https://x.test/'), 'req_xyz');
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(ctx.parentSpanId).toBeNull();
    expect(ctx.requestId).toBe('req_xyz');
  });

  it('generates fresh IDs when the traceparent is malformed', () => {
    const request = new Request('https://x.test/', {
      headers: { traceparent: 'garbage' },
    });
    const ctx = createSpanContext(request, 'req_xyz');
    expect(ctx.parentSpanId).toBeNull();
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
  });
});

// ---------------------------------------------------------------------------
// buildTraceparent
// ---------------------------------------------------------------------------

describe('buildTraceparent', () => {
  it('serialises a span context into the W3C format with the sampled flag set', () => {
    const ctx: WorkerSpanContext = {
      traceId: 'e'.repeat(32),
      spanId: 'f'.repeat(16),
      parentSpanId: null,
      requestId: 'req_1',
    };
    expect(buildTraceparent(ctx)).toBe(`00-${'e'.repeat(32)}-${'f'.repeat(16)}-01`);
  });

  it('produces output that round-trips through parseTraceparent', () => {
    const ctx: WorkerSpanContext = {
      traceId: generateTraceId(),
      spanId: generateSpanId(),
      parentSpanId: null,
      requestId: 'req_1',
    };
    const parsed = parseTraceparent(buildTraceparent(ctx));
    expect(parsed).toEqual({ traceId: ctx.traceId, parentSpanId: ctx.spanId });
  });
});

// ---------------------------------------------------------------------------
// createChildContext
// ---------------------------------------------------------------------------

describe('createChildContext', () => {
  const parent: WorkerSpanContext = {
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    parentSpanId: null,
    requestId: 'req_parent',
  };

  it('inherits the parent trace ID and chains the span ID', () => {
    const child = createChildContext(parent);
    expect(child.traceId).toBe(parent.traceId);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(child.spanId).not.toBe(parent.spanId);
    expect(child.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('inherits the parent request ID when none is supplied', () => {
    const child = createChildContext(parent);
    expect(child.requestId).toBe('req_parent');
  });

  it('overrides the request ID when one is supplied', () => {
    const child = createChildContext(parent, 'req_child');
    expect(child.requestId).toBe('req_child');
  });
});

// ---------------------------------------------------------------------------
// withWorkerSpan
// ---------------------------------------------------------------------------

describe('withWorkerSpan', () => {
  const parent: WorkerSpanContext = {
    traceId: '1'.repeat(32),
    spanId: '2'.repeat(16),
    parentSpanId: null,
    requestId: 'req_parent',
  };

  it('returns the function result with an ok span for a successful execution', async () => {
    const { result, span } = await withWorkerSpan(
      'upstream',
      parent,
      { route: '/chat' },
      async (ctx) => {
        expect(ctx.traceId).toBe(parent.traceId);
        expect(ctx.parentSpanId).toBe(parent.spanId);
        return 42;
      },
    );
    expect(result).toBe(42);
    expect(span.status).toBe('ok');
    expect(span.name).toBe('upstream');
    expect(span.attributes).toEqual({ route: '/chat' });
    expect(span.errorMessage).toBeUndefined();
    expect(span.context.traceId).toBe(parent.traceId);
    expect(span.context.parentSpanId).toBe(parent.spanId);
  });

  it('re-throws with an error span attached for debugging', async () => {
    const boom = new Error('kaboom');
    let caught: unknown;
    try {
      await withWorkerSpan('upstream', parent, {}, async () => {
        throw boom;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(boom);
    const span = (boom as unknown as Record<string, unknown>).__workerSpan as WorkerSpan;
    expect(span).toBeDefined();
    expect(span.status).toBe('error');
    expect(span.errorMessage).toBe('kaboom');
    expect(span.context.parentSpanId).toBe(parent.spanId);
  });

  it('records the error message on non-Error thrown objects too', async () => {
    const thrown: { why: string } & Record<string, unknown> = { why: 'oops' };
    let caught: unknown;
    try {
      await withWorkerSpan('upstream', parent, {}, async () => {
        throw thrown;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(thrown);
    // The wrapper stringifies non-Error throws for errorMessage, and attaches
    // the span back onto the thrown object for inspection.
    const span = thrown.__workerSpan as WorkerSpan;
    expect(span?.status).toBe('error');
    expect(typeof span?.errorMessage).toBe('string');
  });

  it.each([
    ['string', 'a plain string'],
    ['number', 42],
    ['boolean', false],
    ['null', null],
    ['undefined', undefined],
  ])('re-throws %s primitives cleanly without crashing', async (_label, thrown) => {
    // Primitives can't carry the __workerSpan attachment (assigning a property
    // on a primitive throws TypeError in strict mode), so the wrapper must
    // skip the attachment and re-throw the value unchanged.
    let caught: unknown;
    let threwInternally = false;
    try {
      await withWorkerSpan('upstream', parent, {}, async () => {
        throw thrown;
      });
    } catch (err) {
      caught = err;
      // If the wrapper itself crashed trying to attach __workerSpan, the
      // caught value would be a TypeError, not the original thrown primitive.
      if (err instanceof TypeError && /Cannot create property/.test(err.message)) {
        threwInternally = true;
      }
    }
    expect(threwInternally).toBe(false);
    expect(caught).toBe(thrown);
  });
});

// ---------------------------------------------------------------------------
// formatSpanForLog
// ---------------------------------------------------------------------------

describe('formatSpanForLog', () => {
  const ctx: WorkerSpanContext = {
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    parentSpanId: 'c'.repeat(16),
    requestId: 'req_1',
  };

  // Always restore real timers, even if the assertion under test throws,
  // so the fake clock cannot leak into the next test in the file.
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flattens a span into a structured log record', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T00:00:00Z'));
    const startTime = Date.now() - 125;
    const span: WorkerSpan = {
      context: ctx,
      name: 'upstream',
      startTime,
      attributes: { route: '/chat', bytes: 512 },
      status: 'ok',
    };
    const log = formatSpanForLog(span);
    expect(log).toMatchObject({
      trace_id: ctx.traceId,
      span_id: ctx.spanId,
      parent_span_id: ctx.parentSpanId,
      request_id: ctx.requestId,
      span_name: 'upstream',
      duration_ms: 125,
      status: 'ok',
      route: '/chat',
      bytes: 512,
    });
    expect(log.error).toBeUndefined();
  });

  it('includes the error message when the span is in an error state', () => {
    const span: WorkerSpan = {
      context: ctx,
      name: 'upstream',
      startTime: Date.now(),
      attributes: {},
      status: 'error',
      errorMessage: 'boom',
    };
    const log = formatSpanForLog(span);
    expect(log.status).toBe('error');
    expect(log.error).toBe('boom');
  });

  it('lets attributes override fixed fields if they happen to collide', () => {
    // Documents current behaviour: attributes are spread last in formatSpanForLog.
    const span: WorkerSpan = {
      context: ctx,
      name: 'upstream',
      startTime: Date.now(),
      attributes: { status: 'custom' },
      status: 'ok',
    };
    const log = formatSpanForLog(span);
    expect(log.status).toBe('custom');
  });
});
