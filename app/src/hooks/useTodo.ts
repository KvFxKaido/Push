/**
 * useTodo — manages the model's structured todo list for the current repo.
 *
 * Sibling to useScratchpad, but scoped differently: the scratchpad is user-
 * facing narrative memory (notes, decisions, context); the todo list is
 * model-facing step tracking for the current effort. Both persist per-repo
 * so the model has continuity across chat restarts, but the todo list is
 * designed to be cleared when an effort ships.
 *
 * Storage:
 *   - List: localStorage key `push-todo:<repoFullName>` (JSON array).
 *   - No memories/snapshots (YAGNI — different use case than scratchpad).
 *
 * Security notes:
 *   - localStorage is unencrypted; don't paste secrets into todos.
 *   - List size is capped in the tool executor (MAX_TODO_ITEMS).
 */

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { MAX_TODO_CONTENT_LENGTH, MAX_TODO_ITEMS, type TodoItem } from '@/lib/todo-tools';

const GLOBAL_STORAGE_KEY = 'push-todo';
const MAX_STORAGE_SIZE = 200_000; // 200KB soft cap

function getStorageKey(repoFullName: string | null): string {
  return repoFullName ? `push-todo:${repoFullName}` : GLOBAL_STORAGE_KEY;
}

/**
 * Validate + clamp todos loaded from localStorage.
 *
 * Structural validation keeps us safe from prior schema versions and
 * hand-tampering. Clamping enforces the same invariants the tool executor
 * upholds (max item count, max content/activeForm length, at most one
 * in_progress) so a stale or corrupted store can't blow up the [TODO]
 * prompt block or trap the model in a state it can't write back to.
 *
 * Exported so the sanitization can be unit-tested without having to
 * render the hook.
 */
export function validateTodos(data: unknown): TodoItem[] {
  if (!Array.isArray(data)) return [];
  const cleaned: TodoItem[] = [];
  const seenIds = new Set<string>();
  let inProgressKept = false;
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    if (
      typeof record.id !== 'string' ||
      typeof record.content !== 'string' ||
      typeof record.activeForm !== 'string'
    ) {
      continue;
    }
    let status: TodoItem['status'];
    if (record.status === 'in_progress' || record.status === 'completed') {
      status = record.status;
    } else {
      status = 'pending';
    }
    // Demote subsequent in_progress items — the invariant is one active step
    // at a time, so first wins and the rest fall back to pending.
    if (status === 'in_progress') {
      if (inProgressKept) status = 'pending';
      else inProgressKept = true;
    }
    // Rename duplicate ids so the list keeps unique keys even if localStorage
    // was hand-tampered or carries legacy entries. `id` + `id-1` + `id-2`…
    // matches executeTodoToolCall's on-write dedupe so callers can safely use
    // the id as a React key.
    let uniqueId = record.id;
    let suffix = 1;
    while (seenIds.has(uniqueId)) {
      uniqueId = `${record.id}-${suffix++}`;
    }
    seenIds.add(uniqueId);
    cleaned.push({
      id: uniqueId,
      content: record.content.slice(0, MAX_TODO_CONTENT_LENGTH),
      activeForm: record.activeForm.slice(0, MAX_TODO_CONTENT_LENGTH),
      status,
    });
    if (cleaned.length >= MAX_TODO_ITEMS) break;
  }
  return cleaned;
}

/**
 * Compute the next todo list when `toggleStatus` is invoked for `id`.
 *
 * Cycles pending → in_progress → completed → pending on the target. When
 * promoting to in_progress, any other item that was in_progress is
 * demoted to pending so the "one active step" invariant holds. Exported
 * as a pure function so the state-transition logic can be unit-tested.
 */
export function toggleTodoStatus(prev: readonly TodoItem[], id: string): TodoItem[] {
  const target = prev.find((todo) => todo.id === id);
  if (!target) return [...prev];
  const nextStatus: TodoItem['status'] =
    target.status === 'pending'
      ? 'in_progress'
      : target.status === 'in_progress'
        ? 'completed'
        : 'pending';
  return prev.map((todo) => {
    if (todo.id === id) return { ...todo, status: nextStatus };
    if (nextStatus === 'in_progress' && todo.status === 'in_progress') {
      return { ...todo, status: 'pending' };
    }
    return todo;
  });
}

function readStoredTodos(repoFullName: string | null): TodoItem[] {
  try {
    const raw = localStorage.getItem(getStorageKey(repoFullName));
    if (!raw) return [];
    return validateTodos(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function useTodo(repoFullName: string | null = null) {
  const [todos, setTodosState] = useState<TodoItem[]>([]);

  // Load on repo change
  useEffect(() => {
    setTodosState(readStoredTodos(repoFullName));
  }, [repoFullName]);

  // Persist on change
  useEffect(() => {
    const key = getStorageKey(repoFullName);
    try {
      const serialized = JSON.stringify(todos);
      if (serialized.length > MAX_STORAGE_SIZE) {
        toast.warning('Todo list is very large — consider clearing completed items');
      }
      localStorage.setItem(key, serialized);
    } catch (e) {
      if (e instanceof Error) {
        if (e.name === 'QuotaExceededError') {
          toast.error('Todo list too large to save — clear some items');
        } else {
          console.error('[useTodo] localStorage error:', e.message);
        }
      }
    }
  }, [todos, repoFullName]);

  const replace = useCallback((next: TodoItem[]) => {
    setTodosState(next);
  }, []);

  const clear = useCallback(() => {
    setTodosState([]);
  }, []);

  const toggleStatus = useCallback((id: string) => {
    setTodosState((prev) => toggleTodoStatus(prev, id));
  }, []);

  const removeItem = useCallback((id: string) => {
    setTodosState((prev) => prev.filter((todo) => todo.id !== id));
  }, []);

  const hasItems = todos.length > 0;

  return {
    todos,
    hasItems,
    replace,
    clear,
    toggleStatus,
    removeItem,
  };
}

export type UseTodoReturn = ReturnType<typeof useTodo>;
