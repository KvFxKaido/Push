import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetBackHandlerForTests,
  dispatchBack,
  registerBackIntent,
  setRootBackBehavior,
} from './back-handler';

afterEach(() => __resetBackHandlerForTests());

describe('back-handler registry', () => {
  it('invokes the topmost (most-recently-registered) intent and consumes the press', () => {
    const a = vi.fn(() => true);
    const b = vi.fn(() => true);
    registerBackIntent(a);
    registerBackIntent(b);

    dispatchBack();

    expect(b).toHaveBeenCalledOnce();
    expect(a).not.toHaveBeenCalled();
  });

  it('falls through a non-consuming intent to the next one down', () => {
    const root = vi.fn();
    setRootBackBehavior(root);
    const under = vi.fn(() => true);
    const top = vi.fn(() => false); // does not consume
    registerBackIntent(under);
    registerBackIntent(top);

    dispatchBack();

    expect(top).toHaveBeenCalledOnce();
    expect(under).toHaveBeenCalledOnce();
    expect(root).not.toHaveBeenCalled();
  });

  it('runs the root behavior when nothing consumes the press', () => {
    const root = vi.fn();
    setRootBackBehavior(root);

    dispatchBack();
    expect(root).toHaveBeenCalledOnce();

    registerBackIntent(() => false);
    dispatchBack();
    expect(root).toHaveBeenCalledTimes(2);
  });

  it('unregister removes the intent (no longer in the stack)', () => {
    const root = vi.fn();
    setRootBackBehavior(root);
    const a = vi.fn(() => true);
    const off = registerBackIntent(a);

    off();
    dispatchBack();

    expect(a).not.toHaveBeenCalled();
    expect(root).toHaveBeenCalledOnce();
  });

  it('does nothing (no throw) when nothing is registered and no root is set', () => {
    expect(() => dispatchBack()).not.toThrow();
  });
});
