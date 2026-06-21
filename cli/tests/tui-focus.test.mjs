import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FocusStack } from '../tui-focus.ts';

// A minimal ParsedKey-shaped object is enough; scopes treat it opaquely here.
function key(name) {
  return { name, ctrl: false, shift: false, meta: false, sequence: name, ch: '' };
}

describe('FocusStack', () => {
  it('walks active scopes highest-priority-first; first to consume wins', () => {
    const calls = [];
    const stack = new FocusStack()
      .register({
        id: 'top',
        isActive: () => true,
        handleKey: () => {
          calls.push('top');
          return true; // consume
        },
      })
      .register({
        id: 'bottom',
        isActive: () => true,
        handleKey: () => {
          calls.push('bottom');
          return true;
        },
      });

    assert.deepEqual(stack.dispatch(key('a')), { handledBy: 'top' });
    assert.deepEqual(calls, ['top']); // bottom never consulted
  });

  it('falls through scopes that return false, then to global (null)', () => {
    const seen = [];
    const stack = new FocusStack()
      .register({
        id: 'soft',
        isActive: () => true,
        handleKey: () => {
          seen.push('soft');
          return false; // not consumed
        },
      })
      .register({
        id: 'also-soft',
        isActive: () => true,
        handleKey: () => {
          seen.push('also-soft');
          return false;
        },
      });

    assert.deepEqual(stack.dispatch(key('x')), { handledBy: null });
    assert.deepEqual(seen, ['soft', 'also-soft']);
  });

  it('skips inactive scopes entirely', () => {
    const seen = [];
    const stack = new FocusStack()
      .register({
        id: 'inactive',
        isActive: () => false,
        handleKey: () => {
          seen.push('inactive');
          return true;
        },
      })
      .register({
        id: 'active',
        isActive: () => true,
        handleKey: () => {
          seen.push('active');
          return true;
        },
      });

    assert.deepEqual(stack.dispatch(key('y')), { handledBy: 'active' });
    assert.deepEqual(seen, ['active']);
  });

  it('returns handledBy null when no scope is active', () => {
    const stack = new FocusStack().register({
      id: 'off',
      isActive: () => false,
      handleKey: () => true,
    });
    assert.deepEqual(stack.dispatch(key('z')), { handledBy: null });
  });

  it('activeScope reports the topmost active scope id', () => {
    let topOn = false;
    const stack = new FocusStack()
      .register({ id: 'top', isActive: () => topOn, handleKey: () => true })
      .register({ id: 'bottom', isActive: () => true, handleKey: () => true });

    assert.equal(stack.activeScope(), 'bottom');
    topOn = true;
    assert.equal(stack.activeScope(), 'top');
  });

  it('rejects duplicate scope ids', () => {
    const stack = new FocusStack().register({
      id: 'dup',
      isActive: () => true,
      handleKey: () => true,
    });
    assert.throws(
      () => stack.register({ id: 'dup', isActive: () => true, handleKey: () => true }),
      /duplicate scope id "dup"/,
    );
  });

  it('preserves registration order in scopeIds', () => {
    const stack = new FocusStack()
      .register({ id: 'a', isActive: () => true, handleKey: () => false })
      .register({ id: 'b', isActive: () => true, handleKey: () => false })
      .register({ id: 'c', isActive: () => true, handleKey: () => false });
    assert.deepEqual(stack.scopeIds(), ['a', 'b', 'c']);
  });
});
