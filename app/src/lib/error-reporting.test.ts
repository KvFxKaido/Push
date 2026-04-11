import { describe, expect, it, vi } from 'vitest';
import {
  type CapturedError,
  extractRejection,
  extractWindowError,
  installGlobalErrorHandlers,
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
