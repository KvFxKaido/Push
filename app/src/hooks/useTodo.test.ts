import { describe, expect, it } from 'vitest';
import type { TodoItem } from '@/lib/todo-tools';
import { MAX_TODO_CONTENT_LENGTH, MAX_TODO_ITEMS } from '@/lib/todo-tools';
import { toggleTodoStatus, validateTodos } from './useTodo';

function makeTodo(overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: 't',
    content: 'Do the thing',
    activeForm: 'Doing the thing',
    status: 'pending',
    ...overrides,
  };
}

describe('validateTodos', () => {
  it('returns an empty list for non-array input', () => {
    expect(validateTodos(null)).toEqual([]);
    expect(validateTodos('garbage')).toEqual([]);
    expect(validateTodos({})).toEqual([]);
  });

  it('filters out structurally invalid items', () => {
    const result = validateTodos([
      { id: 'ok', content: 'c', activeForm: 'a', status: 'pending' },
      null,
      { id: 'missing-content', activeForm: 'a', status: 'pending' },
      { content: 'no-id', activeForm: 'a', status: 'pending' },
      42,
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('ok');
  });

  it('coerces unknown status values to pending', () => {
    const result = validateTodos([
      { id: 'a', content: 'c', activeForm: 'a', status: 'whatever' },
      { id: 'b', content: 'c', activeForm: 'a', status: 42 },
    ]);
    expect(result.map((todo) => todo.status)).toEqual(['pending', 'pending']);
  });

  it('keeps the first in_progress and demotes the rest to pending', () => {
    const result = validateTodos([
      { id: 'a', content: 'c', activeForm: 'a', status: 'in_progress' },
      { id: 'b', content: 'c', activeForm: 'a', status: 'in_progress' },
      { id: 'c', content: 'c', activeForm: 'a', status: 'in_progress' },
    ]);
    expect(result.map((todo) => todo.status)).toEqual(['in_progress', 'pending', 'pending']);
  });

  it('truncates content and activeForm to MAX_TODO_CONTENT_LENGTH', () => {
    const long = 'x'.repeat(MAX_TODO_CONTENT_LENGTH + 50);
    const result = validateTodos([{ id: 'a', content: long, activeForm: long, status: 'pending' }]);
    expect(result[0].content).toHaveLength(MAX_TODO_CONTENT_LENGTH);
    expect(result[0].activeForm).toHaveLength(MAX_TODO_CONTENT_LENGTH);
  });

  it('caps the list at MAX_TODO_ITEMS', () => {
    const payload = Array.from({ length: MAX_TODO_ITEMS + 10 }, (_, i) => ({
      id: `t${i}`,
      content: 'c',
      activeForm: 'a',
      status: 'pending',
    }));
    const result = validateTodos(payload);
    expect(result).toHaveLength(MAX_TODO_ITEMS);
  });
});

describe('toggleTodoStatus', () => {
  it('cycles pending → in_progress', () => {
    const result = toggleTodoStatus([makeTodo({ id: 'a', status: 'pending' })], 'a');
    expect(result[0].status).toBe('in_progress');
  });

  it('cycles in_progress → completed', () => {
    const result = toggleTodoStatus([makeTodo({ id: 'a', status: 'in_progress' })], 'a');
    expect(result[0].status).toBe('completed');
  });

  it('cycles completed → pending', () => {
    const result = toggleTodoStatus([makeTodo({ id: 'a', status: 'completed' })], 'a');
    expect(result[0].status).toBe('pending');
  });

  it('demotes any other in_progress item when promoting one', () => {
    const result = toggleTodoStatus(
      [
        makeTodo({ id: 'a', status: 'pending' }),
        makeTodo({ id: 'b', status: 'in_progress' }),
        makeTodo({ id: 'c', status: 'in_progress' }),
      ],
      'a',
    );
    expect(result[0].status).toBe('in_progress');
    expect(result[1].status).toBe('pending');
    expect(result[2].status).toBe('pending');
  });

  it('does not touch other in_progress items when cycling away from in_progress', () => {
    const result = toggleTodoStatus(
      [makeTodo({ id: 'a', status: 'in_progress' }), makeTodo({ id: 'b', status: 'pending' })],
      'a',
    );
    // "a" goes in_progress → completed; "b" stays pending.
    expect(result[0].status).toBe('completed');
    expect(result[1].status).toBe('pending');
  });

  it('returns a copy unchanged when the id does not exist', () => {
    const original = [makeTodo({ id: 'a' })];
    const result = toggleTodoStatus(original, 'missing');
    expect(result).toEqual(original);
    expect(result).not.toBe(original);
  });
});
