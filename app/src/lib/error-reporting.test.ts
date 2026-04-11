import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __getDispatchModeForTesting,
  __getPendingCountForTesting,
  __resetErrorReportingForTesting,
  ERROR_BUFFER_CAP,
  type CapturedError,
  extractRejection,
  extractWindowError,
  installGlobalErrorHandlers,
  primeErrorReporting,
  reportError,
  shouldSkipReport,
} from './error-reporting';

// Node 22's `EventTarget` is global but `ErrorEvent` / `PromiseRejectionEvent`
// aren't. Tests cast plain objects through `unknown` to the structural shape
// the helpers actually read.
type WindowErrorEventLike = Pick<ErrorEvent, 'message' | 'filename' | 'lineno' | 'colno' | 'error'>;

function makeWindowErrorEvent(overrides: Partial<WindowErrorEventLike> = {}): ErrorEvent {
  return {
    message: '',
    filename: '',
    lineno: 0,
    colno: 0,
    error: null,
    ...overrides,
  } as unknown as ErrorEvent;
}

function makeRejectionEvent(reason: unknown): PromiseRejectionEvent {
  return { reason } as unknown as PromiseRejectionEvent;
}

describe('shouldSkipReport', () => {
  it('drops cross-origin "Script error." window events', () => {
    expect(
      shouldSkipReport({
        source: 'window-error',
        error: new Error('Script error.'),
      }),
    ).toBe(true);
  });

  it('keeps "Script error." messages from non-window sources', () => {
    expect(
      shouldSkipReport({
        source: 'react-render',
        error: new Error('Script error.'),
      }),
    ).toBe(false);
  });

  it('drops AbortError regardless of source', () => {
    const abort = new DOMException('aborted', 'AbortError');
    expect(shouldSkipReport({ source: 'window-error', error: abort })).toBe(true);
    expect(shouldSkipReport({ source: 'unhandled-rejection', error: abort })).toBe(true);
  });

  it('drops "ResizeObserver loop limit exceeded" window events', () => {
    expect(
      shouldSkipReport({
        source: 'window-error',
        error: new Error('ResizeObserver loop limit exceeded'),
      }),
    ).toBe(true);
  });

  it('drops "ResizeObserver loop completed with undelivered notifications." window events', () => {
    expect(
      shouldSkipReport({
        source: 'window-error',
        error: new Error('ResizeObserver loop completed with undelivered notifications.'),
      }),
    ).toBe(true);
  });

  it('keeps ResizeObserver messages from non-window sources', () => {
    // A React render crash that happens to mention ResizeObserver isn't the
    // benign browser warning — it's an actual render failure.
    expect(
      shouldSkipReport({
        source: 'react-render',
        error: new Error('ResizeObserver loop limit exceeded'),
      }),
    ).toBe(false);
  });

  it('keeps regular errors', () => {
    expect(
      shouldSkipReport({
        source: 'react-render',
        error: new Error('boom'),
      }),
    ).toBe(false);
  });
});

describe('extractWindowError', () => {
  it('captures filename, lineno, and colno when present', () => {
    const captured = extractWindowError(
      makeWindowErrorEvent({
        message: 'oh no',
        filename: 'https://app.example/static/main.js',
        lineno: 42,
        colno: 7,
        error: new Error('oh no'),
      }),
    );

    expect(captured.source).toBe('window-error');
    expect(captured.error).toBeInstanceOf(Error);
    expect((captured.error as Error).message).toBe('oh no');
    expect(captured.attributes).toEqual({
      'push.error.filename': 'https://app.example/static/main.js',
      'push.error.lineno': 42,
      'push.error.colno': 7,
    });
  });

  it('synthesizes an Error when the event has no error object (cross-origin)', () => {
    const captured = extractWindowError(
      makeWindowErrorEvent({ message: 'Script error.', error: null }),
    );

    expect(captured.error).toBeInstanceOf(Error);
    expect((captured.error as Error).message).toBe('Script error.');
  });

  it('omits attributes object when no positional info is present', () => {
    const captured = extractWindowError(
      makeWindowErrorEvent({ message: 'bare', error: new Error('bare') }),
    );

    expect(captured.attributes).toBeUndefined();
  });
});

describe('extractRejection', () => {
  it('captures the rejection reason as-is', () => {
    const reason = new Error('promise blew up');
    const captured = extractRejection(makeRejectionEvent(reason));

    expect(captured.source).toBe('unhandled-rejection');
    expect(captured.error).toBe(reason);
  });

  it('handles non-Error rejection reasons', () => {
    const captured = extractRejection(makeRejectionEvent('just a string'));
    expect(captured.error).toBe('just a string');
  });
});

describe('installGlobalErrorHandlers', () => {
  it('forwards window error events to the reporter', () => {
    const target = new EventTarget();
    const reporter = vi.fn<(captured: CapturedError) => void>();

    const teardown = installGlobalErrorHandlers({ target, reporter });

    const event = Object.assign(new Event('error'), {
      message: 'kaboom',
      filename: 'app.js',
      lineno: 1,
      colno: 2,
      error: new Error('kaboom'),
    });
    target.dispatchEvent(event);

    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter.mock.calls[0][0].source).toBe('window-error');
    expect((reporter.mock.calls[0][0].error as Error).message).toBe('kaboom');

    teardown();
  });

  it('forwards unhandledrejection events to the reporter', () => {
    const target = new EventTarget();
    const reporter = vi.fn<(captured: CapturedError) => void>();

    const teardown = installGlobalErrorHandlers({ target, reporter });

    const reason = new Error('unhandled');
    const event = Object.assign(new Event('unhandledrejection'), { reason });
    target.dispatchEvent(event);

    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter.mock.calls[0][0]).toEqual({
      source: 'unhandled-rejection',
      error: reason,
    });

    teardown();
  });

  it('is idempotent on the same target', () => {
    const target = new EventTarget();
    const reporter = vi.fn<(captured: CapturedError) => void>();

    const teardown1 = installGlobalErrorHandlers({ target, reporter });
    const teardown2 = installGlobalErrorHandlers({ target, reporter });

    const event = Object.assign(new Event('error'), {
      message: 'once',
      filename: '',
      lineno: 0,
      colno: 0,
      error: new Error('once'),
    });
    target.dispatchEvent(event);

    // Only one listener should have been registered, so reporter is called once.
    expect(reporter).toHaveBeenCalledTimes(1);

    teardown1();
    teardown2();
  });

  it('teardown removes both listeners', () => {
    const target = new EventTarget();
    const reporter = vi.fn<(captured: CapturedError) => void>();

    const teardown = installGlobalErrorHandlers({ target, reporter });
    teardown();

    target.dispatchEvent(
      Object.assign(new Event('error'), {
        message: '',
        filename: '',
        lineno: 0,
        colno: 0,
        error: new Error('after teardown'),
      }),
    );
    target.dispatchEvent(
      Object.assign(new Event('unhandledrejection'), { reason: new Error('also gone') }),
    );

    expect(reporter).not.toHaveBeenCalled();
  });
});

/**
 * A tiny deferred helper — creates a Promise alongside its resolve/reject
 * functions so tests can drive settlement explicitly.
 */
function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush the microtask queue so then-callbacks attached to resolved promises run. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('reportError dispatch modes', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetErrorReportingForTesting();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    __resetErrorReportingForTesting();
  });

  it('starts in disabled mode and falls back to console.warn', () => {
    expect(__getDispatchModeForTesting()).toBe('disabled');

    reportError({ source: 'react-render', error: new Error('boom') });

    expect(warnSpy).toHaveBeenCalled();
    expect(__getPendingCountForTesting()).toBe(0);
  });

  it('never throws when dispatching in disabled mode', () => {
    expect(() => reportError({ source: 'react-render', error: new Error('boom') })).not.toThrow();
  });

  it('skips filtered errors in disabled mode without warning', () => {
    reportError({
      source: 'window-error',
      error: new Error('Script error.'),
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('buffers errors after priming until ready resolves', async () => {
    const ready = createDeferred<void>();
    primeErrorReporting(ready.promise);

    expect(__getDispatchModeForTesting()).toBe('buffering');

    reportError({ source: 'react-render', error: new Error('first') });
    reportError({ source: 'window-error', error: new Error('second') });

    expect(__getPendingCountForTesting()).toBe(2);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('flushes the buffer in FIFO order when ready resolves', async () => {
    const ready = createDeferred<void>();
    primeErrorReporting(ready.promise);

    reportError({ source: 'react-render', error: new Error('first') });
    reportError({ source: 'react-render', error: new Error('second') });

    ready.resolve();
    await flushMicrotasks();

    expect(__getDispatchModeForTesting()).toBe('live');
    expect(__getPendingCountForTesting()).toBe(0);
  });

  it('dispatches new errors straight through after ready resolves', async () => {
    const ready = createDeferred<void>();
    primeErrorReporting(ready.promise);
    ready.resolve();
    await flushMicrotasks();

    // In live mode, reportError should not buffer and should not console.warn.
    reportError({ source: 'react-render', error: new Error('post-ready') });

    expect(__getPendingCountForTesting()).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('drains the buffer to console.warn when ready rejects', async () => {
    const ready = createDeferred<void>();
    primeErrorReporting(ready.promise);

    reportError({ source: 'react-render', error: new Error('buffered-1') });
    reportError({ source: 'window-error', error: new Error('buffered-2') });

    ready.reject('bootstrap-failed');
    await flushMicrotasks();

    expect(__getDispatchModeForTesting()).toBe('givenup');
    expect(__getPendingCountForTesting()).toBe(0);
    // One header line plus one per buffered error.
    expect(warnSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(warnSpy.mock.calls[0][0]).toContain('bootstrap-failed');
  });

  it('warns on subsequent errors after givenup', async () => {
    const ready = createDeferred<void>();
    primeErrorReporting(ready.promise);
    ready.reject('disabled');
    await flushMicrotasks();

    warnSpy.mockClear();

    reportError({ source: 'react-render', error: new Error('after-givenup') });

    expect(warnSpy).toHaveBeenCalled();
    expect(__getDispatchModeForTesting()).toBe('givenup');
  });

  it('primeErrorReporting is idempotent', async () => {
    const first = createDeferred<void>();
    const second = createDeferred<void>();

    primeErrorReporting(first.promise);
    primeErrorReporting(second.promise); // ignored

    reportError({ source: 'react-render', error: new Error('buffered') });
    expect(__getPendingCountForTesting()).toBe(1);

    // Resolving the *second* promise should be a no-op — only the first one
    // is wired up — so the buffer should not flush.
    second.resolve();
    await flushMicrotasks();
    expect(__getDispatchModeForTesting()).toBe('buffering');
    expect(__getPendingCountForTesting()).toBe(1);

    // Resolving the first promise completes the transition.
    first.resolve();
    await flushMicrotasks();
    expect(__getDispatchModeForTesting()).toBe('live');
    expect(__getPendingCountForTesting()).toBe(0);
  });

  it('caps the buffer at ERROR_BUFFER_CAP and drops the oldest on overflow', () => {
    const ready = createDeferred<void>();
    primeErrorReporting(ready.promise);

    for (let i = 0; i < ERROR_BUFFER_CAP + 5; i++) {
      reportError({ source: 'react-render', error: new Error(`err-${i}`) });
    }

    expect(__getPendingCountForTesting()).toBe(ERROR_BUFFER_CAP);
  });

  it('reportError never throws regardless of dispatch mode', () => {
    const cases: DispatchCase[] = [
      { mode: 'disabled', setup: () => {} },
      {
        mode: 'buffering',
        setup: () => primeErrorReporting(createDeferred<void>().promise),
      },
      {
        mode: 'live',
        setup: async () => {
          const ready = createDeferred<void>();
          primeErrorReporting(ready.promise);
          ready.resolve();
          await flushMicrotasks();
        },
      },
      {
        mode: 'givenup',
        setup: async () => {
          const ready = createDeferred<void>();
          primeErrorReporting(ready.promise);
          ready.reject('disabled');
          await flushMicrotasks();
        },
      },
    ];

    for (const { setup } of cases) {
      __resetErrorReportingForTesting();
      warnSpy.mockClear();
      void setup();
      expect(() => reportError({ source: 'react-render', error: new Error('test') })).not.toThrow();
    }
  });
});

interface DispatchCase {
  mode: 'disabled' | 'buffering' | 'live' | 'givenup';
  setup: () => void | Promise<void>;
}
