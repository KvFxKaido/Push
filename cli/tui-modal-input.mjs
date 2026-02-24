/**
 * tui-modal-input.mjs — Reusable input helpers for TUI modals.
 * Pure functions so modal handlers can stay small and easy to test.
 */

function isPrintableKey(key) {
  return Boolean(key?.ch) && !key.ctrl && !key.meta;
}

export function moveCursorCircular(cursor, length, delta) {
  if (!Number.isFinite(length) || length <= 0) return 0;
  const base = Number.isFinite(cursor) ? cursor : 0;
  const step = Number.isFinite(delta) ? delta : 0;
  return ((base + step) % length + length) % length;
}

/**
 * Parse common list-navigation keys for modal lists.
 * Returns one of:
 * - { type: 'cancel' }
 * - { type: 'move', delta: -1|1 }
 * - { type: 'confirm' }
 * - { type: 'select_index', index }
 * - null (not handled)
 */
export function getListNavigationAction(key, {
  allowEscape = true,
  allowNumbers = true,
  allowVim = false,
} = {}) {
  if (!key) return null;

  if (allowEscape && key.name === 'escape') {
    return { type: 'cancel' };
  }
  if (key.name === 'up' || (allowVim && !key.ctrl && !key.meta && key.name === 'k')) {
    return { type: 'move', delta: -1 };
  }
  if (key.name === 'down' || (allowVim && !key.ctrl && !key.meta && key.name === 'j')) {
    return { type: 'move', delta: 1 };
  }
  if (key.name === 'return' || key.name === 'enter') {
    return { type: 'confirm' };
  }

  if (allowNumbers && typeof key.ch === 'string' && /^[1-9]$/.test(key.ch)) {
    return { type: 'select_index', index: parseInt(key.ch, 10) - 1 };
  }

  return null;
}

/**
 * Apply a keypress to a single-line text buffer.
 * Returns the updated state plus flags describing what happened.
 */
export function applySingleLineEditKey(text, cursor, key, {
  submitOnReturn = false,
  cancelOnEscape = false,
  clearOnCtrlU = true,
} = {}) {
  const currentText = String(text ?? '');
  let nextText = currentText;
  let nextCursor = Math.max(0, Math.min(Number(cursor) || 0, currentText.length));

  let handled = false;
  let changed = false;
  let submitted = false;
  let canceled = false;

  if (!key) {
    return { handled, changed, submitted, canceled, text: nextText, cursor: nextCursor };
  }

  if ((key.name === 'return' || key.name === 'enter') && submitOnReturn) {
    handled = true;
    submitted = true;
    return { handled, changed, submitted, canceled, text: nextText, cursor: nextCursor };
  }

  if (key.name === 'escape' && cancelOnEscape) {
    handled = true;
    canceled = true;
    return { handled, changed, submitted, canceled, text: nextText, cursor: nextCursor };
  }

  if (key.name === 'backspace') {
    handled = true;
    if (nextCursor > 0) {
      nextText = nextText.slice(0, nextCursor - 1) + nextText.slice(nextCursor);
      nextCursor -= 1;
      changed = true;
    }
    return { handled, changed, submitted, canceled, text: nextText, cursor: nextCursor };
  }

  if (key.name === 'delete') {
    handled = true;
    if (nextCursor < nextText.length) {
      nextText = nextText.slice(0, nextCursor) + nextText.slice(nextCursor + 1);
      changed = true;
    }
    return { handled, changed, submitted, canceled, text: nextText, cursor: nextCursor };
  }

  if (key.name === 'left') {
    handled = true;
    if (nextCursor > 0) nextCursor -= 1;
    return { handled, changed, submitted, canceled, text: nextText, cursor: nextCursor };
  }

  if (key.name === 'right') {
    handled = true;
    if (nextCursor < nextText.length) nextCursor += 1;
    return { handled, changed, submitted, canceled, text: nextText, cursor: nextCursor };
  }

  if (key.name === 'home') {
    handled = true;
    nextCursor = 0;
    return { handled, changed, submitted, canceled, text: nextText, cursor: nextCursor };
  }

  if (key.name === 'end') {
    handled = true;
    nextCursor = nextText.length;
    return { handled, changed, submitted, canceled, text: nextText, cursor: nextCursor };
  }

  if (clearOnCtrlU && key.ctrl && key.name === 'u') {
    handled = true;
    if (nextText.length > 0 || nextCursor !== 0) {
      nextText = '';
      nextCursor = 0;
      changed = true;
    }
    return { handled, changed, submitted, canceled, text: nextText, cursor: nextCursor };
  }

  if (isPrintableKey(key)) {
    handled = true;
    nextText = nextText.slice(0, nextCursor) + key.ch + nextText.slice(nextCursor);
    nextCursor += key.ch.length;
    changed = true;
    return { handled, changed, submitted, canceled, text: nextText, cursor: nextCursor };
  }

  return { handled, changed, submitted, canceled, text: nextText, cursor: nextCursor };
}

