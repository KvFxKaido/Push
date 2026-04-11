/**
 * tui-modal-input.ts — Reusable input helpers for TUI modals.
 * Pure functions so modal handlers can stay small and easy to test.
 */

interface KeyEvent {
  ch?: string;
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
}

interface ListNavigationOptions {
  allowEscape?: boolean;
  allowNumbers?: boolean;
  allowVim?: boolean;
}

interface CancelAction {
  type: 'cancel';
}

interface MoveAction {
  type: 'move';
  delta: -1 | 1;
}

interface ConfirmAction {
  type: 'confirm';
}

interface SelectIndexAction {
  type: 'select_index';
  index: number;
}

type ListNavigationAction = CancelAction | MoveAction | ConfirmAction | SelectIndexAction;

interface SingleLineEditOptions {
  submitOnReturn?: boolean;
  cancelOnEscape?: boolean;
  clearOnCtrlU?: boolean;
}

interface SingleLineEditResult {
  handled: boolean;
  changed: boolean;
  submitted: boolean;
  canceled: boolean;
  text: string;
  cursor: number;
}

function isPrintableKey(key: KeyEvent | null | undefined): boolean {
  return Boolean(key?.ch) && !key!.ctrl && !key!.meta;
}

export function moveCursorCircular(cursor: number, length: number, delta: number): number {
  if (!Number.isFinite(length) || length <= 0) return 0;
  const base = Number.isFinite(cursor) ? cursor : 0;
  const step = Number.isFinite(delta) ? delta : 0;
  return (((base + step) % length) + length) % length;
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
export function getListNavigationAction(
  key: KeyEvent | null | undefined,
  { allowEscape = true, allowNumbers = true, allowVim = false }: ListNavigationOptions = {},
): ListNavigationAction | null {
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
export function applySingleLineEditKey(
  text: unknown,
  cursor: unknown,
  key: KeyEvent | null | undefined,
  {
    submitOnReturn = false,
    cancelOnEscape = false,
    clearOnCtrlU = true,
  }: SingleLineEditOptions = {},
): SingleLineEditResult {
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
    nextText = nextText.slice(0, nextCursor) + key.ch! + nextText.slice(nextCursor);
    nextCursor += key.ch!.length;
    changed = true;
    return { handled, changed, submitted, canceled, text: nextText, cursor: nextCursor };
  }

  return { handled, changed, submitted, canceled, text: nextText, cursor: nextCursor };
}
