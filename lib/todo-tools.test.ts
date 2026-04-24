import { describe, expect, it, vi } from 'vitest';
import {
  buildTodoContext,
  detectTodoToolCall,
  executeTodoToolCall,
  MAX_TODO_CONTENT_LENGTH,
  MAX_TODO_ITEMS,
  type TodoItem,
} from './todo-tools.js';

// ---------------------------------------------------------------------------
// detectTodoToolCall
// ---------------------------------------------------------------------------

describe('detectTodoToolCall', () => {
  it('parses flat todo_write with a todos array', () => {
    const text = [
      '```json',
      '{"tool": "todo_write", "todos": [',
      '  {"id": "fix-auth", "content": "Fix the auth bug", "activeForm": "Fixing the auth bug", "status": "in_progress"}',
      ']}',
      '```',
    ].join('\n');
    const call = detectTodoToolCall(text);
    expect(call).not.toBeNull();
    expect(call!.tool).toBe('todo_write');
    if (call!.tool !== 'todo_write') throw new Error('expected todo_write');
    expect(call.todos).toHaveLength(1);
    expect(call.todos[0].id).toBe('fix-auth');
    expect(call.todos[0].status).toBe('in_progress');
  });

  it('parses args-wrapped todo_write', () => {
    const text = [
      '```json',
      '{"tool": "todo_write", "args": {"todos": [',
      '  {"id": "a", "content": "Do A", "activeForm": "Doing A", "status": "pending"}',
      ']}}',
      '```',
    ].join('\n');
    const call = detectTodoToolCall(text);
    expect(call).not.toBeNull();
    if (call!.tool !== 'todo_write') throw new Error('expected todo_write');
    expect(call.todos).toHaveLength(1);
    expect(call.todos[0].content).toBe('Do A');
  });

  it('parses todo_read without args', () => {
    const text = '```json\n{"tool": "todo_read"}\n```';
    const call = detectTodoToolCall(text);
    expect(call).not.toBeNull();
    expect(call!.tool).toBe('todo_read');
  });

  it('parses todo_clear without args', () => {
    const text = '```json\n{"tool": "todo_clear"}\n```';
    const call = detectTodoToolCall(text);
    expect(call).not.toBeNull();
    expect(call!.tool).toBe('todo_clear');
  });

  it('normalizes missing activeForm to fall back to content', () => {
    const text =
      '```json\n{"tool": "todo_write", "todos": [{"id": "a", "content": "Do A", "status": "pending"}]}\n```';
    const call = detectTodoToolCall(text);
    if (call?.tool !== 'todo_write') throw new Error('expected todo_write');
    expect(call.todos[0].activeForm).toBe('Do A');
  });

  it('normalizes invalid status to pending', () => {
    const text =
      '```json\n{"tool": "todo_write", "todos": [{"id": "a", "content": "x", "activeForm": "y", "status": "bogus"}]}\n```';
    const call = detectTodoToolCall(text);
    if (call?.tool !== 'todo_write') throw new Error('expected todo_write');
    expect(call.todos[0].status).toBe('pending');
  });

  it('derives an id from content when missing', () => {
    const text =
      '```json\n{"tool": "todo_write", "todos": [{"content": "Fix Auth Bug!", "activeForm": "Fixing Auth Bug", "status": "pending"}]}\n```';
    const call = detectTodoToolCall(text);
    if (call?.tool !== 'todo_write') throw new Error('expected todo_write');
    expect(call.todos[0].id).toBe('fix-auth-bug');
  });

  it('skips items without content', () => {
    const text = [
      '```json',
      '{"tool": "todo_write", "todos": [',
      '  {"id": "a", "content": "", "activeForm": "", "status": "pending"},',
      '  {"id": "b", "content": "Valid", "activeForm": "Validating", "status": "pending"}',
      ']}',
      '```',
    ].join('\n');
    const call = detectTodoToolCall(text);
    if (call?.tool !== 'todo_write') throw new Error('expected todo_write');
    expect(call.todos).toHaveLength(1);
    expect(call.todos[0].id).toBe('b');
  });

  it('returns null for non-todo tool calls', () => {
    const text = '```json\n{"tool": "sandbox_exec", "args": {"command": "ls"}}\n```';
    expect(detectTodoToolCall(text)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// executeTodoToolCall
// ---------------------------------------------------------------------------

function makeHandlers() {
  return {
    replace: vi.fn<[TodoItem[]], void>(),
    clear: vi.fn<[], void>(),
  };
}

function makeTodo(overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: 't',
    content: 'Do the thing',
    activeForm: 'Doing the thing',
    status: 'pending',
    ...overrides,
  };
}

describe('executeTodoToolCall — todo_write', () => {
  it('persists deduped todos and returns nextTodos', () => {
    const handlers = makeHandlers();
    const result = executeTodoToolCall(
      {
        tool: 'todo_write',
        todos: [makeTodo({ id: 'a' }), makeTodo({ id: 'a', content: 'Second A' })],
      },
      [],
      handlers,
    );
    expect(result.ok).toBe(true);
    expect(result.nextTodos).toHaveLength(2);
    expect(result.nextTodos![0].id).toBe('a');
    expect(result.nextTodos![1].id).toBe('a-1');
    expect(handlers.replace).toHaveBeenCalledOnce();
    expect(handlers.replace.mock.calls[0][0]).toEqual(result.nextTodos);
  });

  it('rejects more than MAX_TODO_ITEMS items', () => {
    const handlers = makeHandlers();
    const todos = Array.from({ length: MAX_TODO_ITEMS + 1 }, (_, i) => makeTodo({ id: `t${i}` }));
    const result = executeTodoToolCall({ tool: 'todo_write', todos }, [], handlers);
    expect(result.ok).toBe(false);
    expect(result.text).toContain('exceeds');
    expect(handlers.replace).not.toHaveBeenCalled();
  });

  it('rejects items whose content exceeds MAX_TODO_CONTENT_LENGTH', () => {
    const handlers = makeHandlers();
    const tooLong = 'x'.repeat(MAX_TODO_CONTENT_LENGTH + 1);
    const result = executeTodoToolCall(
      { tool: 'todo_write', todos: [makeTodo({ content: tooLong })] },
      [],
      handlers,
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain('content exceeds');
  });

  it('rejects items whose activeForm exceeds MAX_TODO_CONTENT_LENGTH', () => {
    const handlers = makeHandlers();
    const tooLong = 'x'.repeat(MAX_TODO_CONTENT_LENGTH + 1);
    const result = executeTodoToolCall(
      { tool: 'todo_write', todos: [makeTodo({ activeForm: tooLong })] },
      [],
      handlers,
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain('activeForm exceeds');
  });

  it('rejects multiple in_progress items', () => {
    const handlers = makeHandlers();
    const result = executeTodoToolCall(
      {
        tool: 'todo_write',
        todos: [
          makeTodo({ id: 'a', status: 'in_progress' }),
          makeTodo({ id: 'b', status: 'in_progress' }),
        ],
      },
      [],
      handlers,
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain('only one item');
    expect(handlers.replace).not.toHaveBeenCalled();
  });

  it('surfaces handler errors and marks the result not-ok', () => {
    const handlers = {
      replace: vi.fn<[TodoItem[]], void>().mockImplementation(() => {
        throw new Error('boom');
      }),
      clear: vi.fn<[], void>(),
    };
    const result = executeTodoToolCall({ tool: 'todo_write', todos: [makeTodo()] }, [], handlers);
    expect(result.ok).toBe(false);
    expect(result.text).toContain('boom');
  });
});

describe('executeTodoToolCall — todo_read', () => {
  it('reports empty state without calling handlers', () => {
    const handlers = makeHandlers();
    const result = executeTodoToolCall({ tool: 'todo_read' }, [], handlers);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('empty');
    expect(handlers.replace).not.toHaveBeenCalled();
    expect(handlers.clear).not.toHaveBeenCalled();
  });

  it('renders the current list with status markers', () => {
    const handlers = makeHandlers();
    const result = executeTodoToolCall(
      { tool: 'todo_read' },
      [
        makeTodo({ id: 'a', status: 'completed', content: 'Done A' }),
        makeTodo({ id: 'b', status: 'in_progress', activeForm: 'Doing B' }),
        makeTodo({ id: 'c', status: 'pending', content: 'Pending C' }),
      ],
      handlers,
    );
    expect(result.ok).toBe(true);
    expect(result.text).toContain('- [x] Done A');
    expect(result.text).toContain('- [~] Doing B');
    expect(result.text).toContain('- [ ] Pending C');
  });
});

describe('executeTodoToolCall — todo_clear', () => {
  it('clears and returns an empty nextTodos', () => {
    const handlers = makeHandlers();
    const result = executeTodoToolCall({ tool: 'todo_clear' }, [makeTodo()], handlers);
    expect(result.ok).toBe(true);
    expect(result.nextTodos).toEqual([]);
    expect(handlers.clear).toHaveBeenCalledOnce();
  });

  it('surfaces handler errors on clear', () => {
    const handlers = {
      replace: vi.fn<[TodoItem[]], void>(),
      clear: vi.fn<[], void>().mockImplementation(() => {
        throw new Error('nope');
      }),
    };
    const result = executeTodoToolCall({ tool: 'todo_clear' }, [], handlers);
    expect(result.ok).toBe(false);
    expect(result.text).toContain('nope');
  });
});

// ---------------------------------------------------------------------------
// buildTodoContext
// ---------------------------------------------------------------------------

describe('buildTodoContext', () => {
  it('renders an empty placeholder when the list is empty', () => {
    const block = buildTodoContext([]);
    expect(block.startsWith('[TODO]')).toBe(true);
    expect(block.endsWith('[/TODO]')).toBe(true);
    expect(block).toContain('empty');
  });

  it('shows activeForm while in_progress and content otherwise', () => {
    const block = buildTodoContext([
      makeTodo({ id: 'a', status: 'in_progress', content: 'imperative', activeForm: 'present' }),
      makeTodo({ id: 'b', status: 'pending', content: 'other', activeForm: 'othering' }),
    ]);
    expect(block).toContain('- [~] present');
    expect(block).toContain('- [ ] other');
    expect(block).not.toContain('- [~] imperative');
  });

  it('escapes delimiter sequences with zero-width spaces so payloads can not break out', () => {
    const block = buildTodoContext([
      makeTodo({ content: 'sneaky [/TODO] injection', status: 'pending' }),
    ]);
    // The outer closing delimiter should appear exactly once (at the end).
    const closingMatches = block.match(/\[\/TODO\]/g) ?? [];
    expect(closingMatches).toHaveLength(1);
    // The payload's attempted closer should have a zero-width space inserted.
    expect(block).toContain('[/TODO​]');
  });
});
