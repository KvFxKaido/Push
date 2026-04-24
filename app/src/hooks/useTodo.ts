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
import type { TodoItem } from '@/lib/todo-tools';

const GLOBAL_STORAGE_KEY = 'push-todo';
const MAX_STORAGE_SIZE = 200_000; // 200KB soft cap

function getStorageKey(repoFullName: string | null): string {
  return repoFullName ? `push-todo:${repoFullName}` : GLOBAL_STORAGE_KEY;
}

function validateTodos(data: unknown): TodoItem[] {
  if (!Array.isArray(data)) return [];
  return data.filter(
    (item): item is TodoItem =>
      typeof item === 'object' &&
      item !== null &&
      typeof item.id === 'string' &&
      typeof item.content === 'string' &&
      typeof item.activeForm === 'string' &&
      (item.status === 'pending' || item.status === 'in_progress' || item.status === 'completed'),
  );
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
    setTodosState((prev) =>
      prev.map((todo) => {
        if (todo.id !== id) return todo;
        const nextStatus: TodoItem['status'] =
          todo.status === 'pending'
            ? 'in_progress'
            : todo.status === 'in_progress'
              ? 'completed'
              : 'pending';
        return { ...todo, status: nextStatus };
      }),
    );
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
