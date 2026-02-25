import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applySingleLineEditKey,
  getListNavigationAction,
} from '../tui-modal-input.mjs';

/**
 * Simulate the config modal state machine to verify edit mode works correctly.
 */
function createMockConfigModalState() {
  return {
    mode: 'list',
    cursor: 0,
    editTarget: '',
    editBuf: '',
    editCursor: 0,
    pickCursor: 0,
  };
}

function mockActivateConfigItem(ms, providers, index) {
  if (index < providers.length) {
    ms.mode = 'edit';
    ms.editTarget = providers[index].id;
    ms.editBuf = '';
    ms.editCursor = 0;
  }
}

function mockHandleConfigModalInput(ms, key, providers) {
  if (ms.mode === 'list') {
    const action = getListNavigationAction(key);
    if (!action) return { handled: false };
    if (action.type === 'confirm') {
      mockActivateConfigItem(ms, providers, ms.cursor);
      return { handled: true, activated: true };
    }
    if (action.type === 'move') {
      ms.cursor = (ms.cursor + action.delta + providers.length) % providers.length;
      return { handled: true };
    }
    return { handled: true };
  }

  if (ms.mode === 'edit') {
    const edit = applySingleLineEditKey(ms.editBuf, ms.editCursor, key, {
      submitOnReturn: true,
      cancelOnEscape: true,
    });
    if (!edit.handled) return { handled: false };

    if (edit.canceled) {
      ms.mode = 'list';
      ms.editBuf = '';
      ms.editCursor = 0;
      return { handled: true, canceled: true };
    }

    if (edit.submitted) {
      const savedKey = ms.editBuf;
      ms.mode = 'list';
      ms.editBuf = '';
      ms.editCursor = 0;
      return { handled: true, submitted: true, savedKey };
    }

    ms.editBuf = edit.text;
    ms.editCursor = edit.cursor;
    return { handled: true, changed: true };
  }

  return { handled: false };
}

describe('config modal state machine', () => {
  const providers = [
    { id: 'ollama' },
    { id: 'mistral' },
    { id: 'openrouter' },
    { id: 'zai' },
    { id: 'google' },
    { id: 'minimax' },
    { id: 'zen' },
  ];

  it('navigates to minimax and enters edit mode', () => {
    const ms = createMockConfigModalState();

    // Navigate to minimax (index 5)
    ms.cursor = 5;
    assert.equal(ms.cursor, 5);

    // Press Enter to activate
    const result = mockHandleConfigModalInput(ms, { name: 'return' }, providers);
    assert.equal(result.handled, true);
    assert.equal(result.activated, true);
    assert.equal(ms.mode, 'edit');
    assert.equal(ms.editTarget, 'minimax');
    assert.equal(ms.editBuf, '');
    assert.equal(ms.editCursor, 0);
  });

  it('types API key characters in edit mode', () => {
    const ms = createMockConfigModalState();

    // Enter edit mode for minimax
    ms.cursor = 5;
    mockHandleConfigModalInput(ms, { name: 'return' }, providers);
    assert.equal(ms.mode, 'edit');

    // Type 'abc123'
    for (const ch of 'abc123') {
      const result = mockHandleConfigModalInput(ms, { ch, name: ch, ctrl: false, meta: false }, providers);
      assert.equal(result.handled, true, `Should handle '${ch}'`);
      assert.equal(result.changed, true, `Should change on '${ch}'`);
    }

    assert.equal(ms.editBuf, 'abc123');
    assert.equal(ms.editCursor, 6);
  });

  it('handles backspace in edit mode', () => {
    const ms = createMockConfigModalState();
    ms.cursor = 5;
    mockHandleConfigModalInput(ms, { name: 'return' }, providers);

    // Type 'abc', then backspace
    mockHandleConfigModalInput(ms, { ch: 'a', name: 'a', ctrl: false, meta: false }, providers);
    mockHandleConfigModalInput(ms, { ch: 'b', name: 'b', ctrl: false, meta: false }, providers);
    mockHandleConfigModalInput(ms, { ch: 'c', name: 'c', ctrl: false, meta: false }, providers);
    assert.equal(ms.editBuf, 'abc');

    const result = mockHandleConfigModalInput(ms, { name: 'backspace' }, providers);
    assert.equal(result.handled, true);
    assert.equal(ms.editBuf, 'ab');
    assert.equal(ms.editCursor, 2);
  });

  it('submits API key on Enter', () => {
    const ms = createMockConfigModalState();
    ms.cursor = 5;
    mockHandleConfigModalInput(ms, { name: 'return' }, providers);

    // Type key
    for (const ch of 'secret-key-123') {
      mockHandleConfigModalInput(ms, { ch, name: ch, ctrl: false, meta: false }, providers);
    }

    // Submit
    const result = mockHandleConfigModalInput(ms, { name: 'return' }, providers);
    assert.equal(result.handled, true);
    assert.equal(result.submitted, true);
    assert.equal(result.savedKey, 'secret-key-123');
    assert.equal(ms.mode, 'list');
  });

  it('cancels edit on Escape', () => {
    const ms = createMockConfigModalState();
    ms.cursor = 5;
    mockHandleConfigModalInput(ms, { name: 'return' }, providers);

    // Type some characters
    mockHandleConfigModalInput(ms, { ch: 'x', name: 'x', ctrl: false, meta: false }, providers);
    assert.equal(ms.editBuf, 'x');

    // Cancel
    const result = mockHandleConfigModalInput(ms, { name: 'escape' }, providers);
    assert.equal(result.handled, true);
    assert.equal(result.canceled, true);
    assert.equal(ms.mode, 'list');
    assert.equal(ms.editBuf, '');
  });
});
