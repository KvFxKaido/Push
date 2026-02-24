import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applySingleLineEditKey,
  getListNavigationAction,
  moveCursorCircular,
} from '../tui-modal-input.mjs';

describe('moveCursorCircular', () => {
  it('wraps forward and backward', () => {
    assert.equal(moveCursorCircular(0, 3, -1), 2);
    assert.equal(moveCursorCircular(2, 3, 1), 0);
  });

  it('returns 0 for empty lists', () => {
    assert.equal(moveCursorCircular(5, 0, 1), 0);
  });
});

describe('getListNavigationAction', () => {
  it('parses arrows, escape, return, and number keys', () => {
    assert.deepEqual(getListNavigationAction({ name: 'up' }), { type: 'move', delta: -1 });
    assert.deepEqual(getListNavigationAction({ name: 'down' }), { type: 'move', delta: 1 });
    assert.deepEqual(getListNavigationAction({ name: 'escape' }), { type: 'cancel' });
    assert.deepEqual(getListNavigationAction({ name: 'return' }), { type: 'confirm' });
    assert.deepEqual(getListNavigationAction({ name: '', ch: '4' }), { type: 'select_index', index: 3 });
  });

  it('supports optional vim navigation', () => {
    assert.equal(getListNavigationAction({ name: 'j', ctrl: false, meta: false }), null);
    assert.deepEqual(
      getListNavigationAction({ name: 'j', ctrl: false, meta: false }, { allowVim: true }),
      { type: 'move', delta: 1 },
    );
  });
});

describe('applySingleLineEditKey', () => {
  it('inserts printable characters at cursor', () => {
    const res = applySingleLineEditKey('ab', 1, { ch: 'Z', name: 'z', ctrl: false, meta: false });
    assert.equal(res.handled, true);
    assert.equal(res.changed, true);
    assert.equal(res.text, 'aZb');
    assert.equal(res.cursor, 2);
  });

  it('handles movement and deletion keys', () => {
    let state = applySingleLineEditKey('abcd', 2, { name: 'left' });
    assert.equal(state.cursor, 1);
    state = applySingleLineEditKey('abcd', 2, { name: 'backspace' });
    assert.equal(state.text, 'acd');
    assert.equal(state.cursor, 1);
    state = applySingleLineEditKey('abcd', 2, { name: 'delete' });
    assert.equal(state.text, 'abd');
    assert.equal(state.cursor, 2);
  });

  it('handles ctrl+u clear', () => {
    const res = applySingleLineEditKey('abcd', 4, { name: 'u', ctrl: true });
    assert.equal(res.text, '');
    assert.equal(res.cursor, 0);
    assert.equal(res.changed, true);
  });

  it('supports submit and cancel flags without mutating text', () => {
    const submit = applySingleLineEditKey('abc', 3, { name: 'return' }, { submitOnReturn: true });
    assert.equal(submit.submitted, true);
    assert.equal(submit.text, 'abc');

    const cancel = applySingleLineEditKey('abc', 1, { name: 'escape' }, { cancelOnEscape: true });
    assert.equal(cancel.canceled, true);
    assert.equal(cancel.text, 'abc');
  });
});

