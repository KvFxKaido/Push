import { afterEach, describe, expect, it } from 'vitest';
import {
  CLIENT_INITIATED_CLOSE_CODE,
  shouldNudgeReconnect,
  subscribeReconnectNudges,
} from '@/lib/reconnect-nudge';

describe('shouldNudgeReconnect', () => {
  it('is a no-op for healthy or in-flight links', () => {
    expect(shouldNudgeReconnect({ state: 'open' })).toBe(false);
    expect(shouldNudgeReconnect({ state: 'connecting' })).toBe(false);
  });

  it('nudges a pre-open unreachable link', () => {
    expect(shouldNudgeReconnect({ state: 'unreachable', code: 0, reason: 'refused' })).toBe(true);
  });

  it('nudges an abnormally-closed link', () => {
    expect(shouldNudgeReconnect({ state: 'closed', code: 1006, reason: 'dropped' })).toBe(true);
  });

  it('does NOT nudge an intentional client close (code 1000)', () => {
    expect(
      shouldNudgeReconnect({ state: 'closed', code: CLIENT_INITIATED_CLOSE_CODE, reason: 'bye' }),
    ).toBe(false);
  });
});

// --- subscribeReconnectNudges: fake the DOM targets (vitest runs in the
// `node` env, so window/document are absent by default). ---

interface FakeTarget {
  addEventListener: (type: string, fn: () => void) => void;
  removeEventListener: (type: string, fn: () => void) => void;
  dispatch: (type: string) => void;
  count: (type: string) => number;
}

function makeFakeTarget(): FakeTarget {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type, fn) => {
      listeners.get(type)?.delete(fn);
    },
    dispatch: (type) => {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
    count: (type) => listeners.get(type)?.size ?? 0,
  };
}

const g = globalThis as unknown as {
  window?: unknown;
  document?: unknown;
};
const savedWindow = g.window;
const savedDocument = g.document;

afterEach(() => {
  g.window = savedWindow;
  g.document = savedDocument;
});

describe('subscribeReconnectNudges', () => {
  it('fires the handler on `online` and on foreground `visibilitychange`', () => {
    const win = makeFakeTarget();
    const doc = makeFakeTarget();
    g.window = win;
    g.document = { ...doc, visibilityState: 'visible' };

    let calls = 0;
    const unsubscribe = subscribeReconnectNudges(() => {
      calls += 1;
    });

    win.dispatch('online');
    expect(calls).toBe(1);

    // visibilitychange handler is registered on document; dispatch via
    // the same recorded listener set.
    (g.document as unknown as FakeTarget).dispatch('visibilitychange');
    expect(calls).toBe(2);

    unsubscribe();
    win.dispatch('online');
    (g.document as unknown as FakeTarget).dispatch('visibilitychange');
    expect(calls).toBe(2);
    expect(win.count('online')).toBe(0);
  });

  it('does not fire on visibilitychange when the document is hidden', () => {
    const win = makeFakeTarget();
    const doc = makeFakeTarget();
    g.window = win;
    g.document = { ...doc, visibilityState: 'hidden' };

    let calls = 0;
    subscribeReconnectNudges(() => {
      calls += 1;
    });

    (g.document as unknown as FakeTarget).dispatch('visibilitychange');
    expect(calls).toBe(0);
  });

  it('is safe with no DOM (returns a callable cleanup, never fires)', () => {
    g.window = undefined;
    g.document = undefined;

    let calls = 0;
    const unsubscribe = subscribeReconnectNudges(() => {
      calls += 1;
    });
    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
    expect(calls).toBe(0);
  });
});
