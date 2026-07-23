/**
 * useTodo — manages the model's structured task ledger for the current branch.
 *
 * Sibling to useScratchpad, but scoped differently: the scratchpad is user-
 * facing narrative memory (notes, decisions, context); the todo list is
 * model-facing step tracking for the current effort. The ledger persists by
 * repo + branch so it survives app reloads, new chats, and branch-local run
 * resumption without leaking position into another branch.
 *
 * Storage:
 *   - List: localStorage key `push-task-ledger:v1:<repo>:<branch>` (JSON array).
 *   - No memories/snapshots (YAGNI — different use case than scratchpad).
 *
 * Security notes:
 *   - localStorage is unencrypted; don't paste secrets into todos.
 *   - List size is capped in the tool executor (MAX_TODO_ITEMS).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import type { TodoItem } from '@/lib/todo-tools';
import {
  normalizeTaskLedgerScope,
  normalizeTaskLedgerSteps,
  type TaskLedgerScope,
} from '@push/lib/task-ledger';

const GLOBAL_STORAGE_KEY = 'push-task-ledger:v1:global';
const LEGACY_GLOBAL_STORAGE_KEY = 'push-todo';
const MAX_STORAGE_SIZE = 200_000; // 200KB soft cap

function getStorageKey(repoFullName: string | null, branch: string | null): string {
  if (!repoFullName) return GLOBAL_STORAGE_KEY;
  const scope = normalizeTaskLedgerScope({ repoFullName, branch });
  return `push-task-ledger:v1:${encodeURIComponent(scope.repoFullName)}:${encodeURIComponent(scope.branch)}`;
}

function getLegacyStorageKey(repoFullName: string | null): string {
  return repoFullName ? `push-todo:${repoFullName}` : LEGACY_GLOBAL_STORAGE_KEY;
}

function persistTodos(storageKey: string, todos: readonly TodoItem[]): void {
  try {
    const serialized = JSON.stringify(todos);
    if (serialized.length > MAX_STORAGE_SIZE) {
      toast.warning('Todo list is very large — consider clearing completed items');
    }
    localStorage.setItem(storageKey, serialized);
  } catch (e) {
    if (e instanceof Error) {
      if (e.name === 'QuotaExceededError') {
        toast.error('Todo list too large to save — clear some items');
      } else {
        console.error('[useTodo] localStorage error:', e.message);
      }
    }
  }
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
  return normalizeTaskLedgerSteps(data);
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

function readStoredTodos(repoFullName: string | null, branch: string | null): TodoItem[] {
  try {
    const key = getStorageKey(repoFullName, branch);
    let raw = localStorage.getItem(key);
    // One-time migration from the pre-#1547 repo-only todo list. Move it onto
    // the branch that is active during the first post-upgrade load so it cannot
    // subsequently bleed into every branch.
    if (!raw) {
      const legacyKey = getLegacyStorageKey(repoFullName);
      raw = localStorage.getItem(legacyKey);
      if (raw) {
        localStorage.setItem(key, raw);
        localStorage.removeItem(legacyKey);
      }
    }
    if (!raw) return [];
    return validateTodos(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function useTodo(repoFullName: string | null = null, branch: string | null = null) {
  const storageKey = getStorageKey(repoFullName, branch);
  const loadedStorageKeyRef = useRef(storageKey);
  const [todos, setTodosState] = useState<TodoItem[]>(() => readStoredTodos(repoFullName, branch));

  // Load on durable scope change.
  useEffect(() => {
    const id = setTimeout(() => {
      const stored = readStoredTodos(repoFullName, branch);
      loadedStorageKeyRef.current = storageKey;
      setTodosState(stored);
    }, 0);
    return () => clearTimeout(id);
  }, [repoFullName, branch, storageKey]);

  // Persist on change
  useEffect(() => {
    // A branch switch renders once with the prior branch's state. Wait for the
    // scoped load effect instead of copying that state into the new branch.
    if (loadedStorageKeyRef.current !== storageKey) return;
    persistTodos(storageKey, todos);
  }, [todos, storageKey]);

  const replace = useCallback((next: TodoItem[]) => {
    setTodosState(next);
  }, []);

  const replaceScoped = useCallback(
    (scope: TaskLedgerScope, next: TodoItem[]) => {
      const targetKey = getStorageKey(scope.repoFullName, scope.branch);
      const normalized = validateTodos(next);
      persistTodos(targetKey, normalized);
      // When the hosting surface has already adopted the switched branch,
      // reflect the scoped write immediately. Otherwise its scope-load effect
      // will adopt this snapshot when the branch state catches up.
      if (targetKey === storageKey) {
        loadedStorageKeyRef.current = storageKey;
        setTodosState(normalized);
      }
    },
    [storageKey],
  );

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
    replaceScoped,
    clear,
    toggleStatus,
    removeItem,
  };
}

export type UseTodoReturn = ReturnType<typeof useTodo>;
