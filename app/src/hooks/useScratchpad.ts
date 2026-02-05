/**
 * useScratchpad — manages a shared notepad for the session.
 *
 * Both the user and Kimi can read/write. Content persists in localStorage.
 * The scratchpad is always visible to Kimi in the system prompt.
 *
 * Security notes:
 * - localStorage is unencrypted; users should avoid pasting sensitive data
 * - Content size is soft-capped at 500KB to prevent quota issues
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';

const GLOBAL_STORAGE_KEY = 'push-scratchpad';
const MEMORY_STORAGE_KEY = 'push-scratchpad-memories';
const ACTIVE_MEMORY_KEY = 'push-scratchpad-memory-active';
const MAX_STORAGE_SIZE = 500_000; // 500KB soft cap for localStorage

export interface ScratchpadMemory {
  id: string;
  name: string;
  content: string;
  updatedAt: number;
}

function getStorageKey(repoFullName: string | null): string {
  return repoFullName
    ? `push-scratchpad:${repoFullName}`
    : GLOBAL_STORAGE_KEY;
}

export interface ScratchpadState {
  isOpen: boolean;
  content: string;
}

function getMemoryStorageKey(repoFullName: string | null): string {
  return repoFullName
    ? `${MEMORY_STORAGE_KEY}:${repoFullName}`
    : `${MEMORY_STORAGE_KEY}:global`;
}

function getActiveMemoryKey(repoFullName: string | null): string {
  return repoFullName
    ? `${ACTIVE_MEMORY_KEY}:${repoFullName}`
    : `${ACTIVE_MEMORY_KEY}:global`;
}

function createMemoryId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useScratchpad(repoFullName: string | null = null) {
  const [isOpen, setIsOpen] = useState(false);
  const [content, setContent] = useState('');
  const [memories, setMemories] = useState<ScratchpadMemory[]>([]);
  const [activeMemoryId, setActiveMemoryId] = useState<string | null>(null);
  const hasMigratedRef = useRef(false);
  // Cache for unsaved draft when viewing memories
  const unsavedDraftRef = useRef<string | null>(null);

  // Load content when repo changes, with migration support
  useEffect(() => {
    const storageKey = getStorageKey(repoFullName);
    // Clear unsaved draft when repo changes
    unsavedDraftRef.current = null;

    try {
      // Try to load repo-scoped content first
      const stored = localStorage.getItem(storageKey);

      if (stored !== null) {
        // Repo-specific scratchpad exists
        setContent(stored);
      } else if (!hasMigratedRef.current) {
        // No repo-specific content - try to migrate from global
        const globalContent = localStorage.getItem(GLOBAL_STORAGE_KEY);
        if (globalContent) {
          // Migrate global content to this repo
          setContent(globalContent);
          localStorage.setItem(storageKey, globalContent);
        } else {
          setContent('');
        }
        hasMigratedRef.current = true;
      } else {
        setContent('');
      }
    } catch {
      setContent('');
    }
  }, [repoFullName]);

  // Load memories for repo
  useEffect(() => {
    const memoryKey = getMemoryStorageKey(repoFullName);
    const activeKey = getActiveMemoryKey(repoFullName);

    try {
      const stored = localStorage.getItem(memoryKey);
      setMemories(stored ? (JSON.parse(stored) as ScratchpadMemory[]) : []);
    } catch {
      setMemories([]);
    }

    try {
      const storedActive = localStorage.getItem(activeKey);
      setActiveMemoryId(storedActive ?? null);
    } catch {
      setActiveMemoryId(null);
    }
  }, [repoFullName]);

  // Auto-save on change with error feedback
  useEffect(() => {
    const storageKey = getStorageKey(repoFullName);

    // Warn if content is getting large (but still try to save)
    if (content.length > MAX_STORAGE_SIZE) {
      toast.warning('Scratchpad is very large — consider clearing old notes');
    }

    try {
      localStorage.setItem(storageKey, content);
    } catch (e) {
      // Handle quota exceeded or disabled localStorage
      if (e instanceof Error) {
        if (e.name === 'QuotaExceededError') {
          toast.error('Scratchpad too large to save — clear some content');
        } else {
          console.error('[useScratchpad] localStorage error:', e.message);
        }
      }
    }
  }, [content, repoFullName]);

  useEffect(() => {
    const memoryKey = getMemoryStorageKey(repoFullName);
    try {
      localStorage.setItem(memoryKey, JSON.stringify(memories));
    } catch (e) {
      if (e instanceof Error) {
        if (e.name === 'QuotaExceededError') {
          toast.error('Scratchpad memories too large to save — remove some memories');
        } else {
          console.error('[useScratchpad] localStorage error:', e.message);
        }
      }
    }
  }, [memories, repoFullName]);

  useEffect(() => {
    const activeKey = getActiveMemoryKey(repoFullName);
    try {
      if (activeMemoryId) {
        localStorage.setItem(activeKey, activeMemoryId);
      } else {
        localStorage.removeItem(activeKey);
      }
    } catch (e) {
      if (e instanceof Error) {
        console.error('[useScratchpad] localStorage error:', e.message);
      }
    }
  }, [activeMemoryId, repoFullName]);

  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const clear = useCallback(() => setContent(''), []);

  const append = useCallback((text: string) => {
    setContent((prev) => {
      const trimmed = prev.trim();
      return trimmed ? `${trimmed}\n\n${text}` : text;
    });
  }, []);

  const replace = useCallback((text: string) => {
    setContent(text);
  }, []);

  const saveMemory = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;

      setMemories((prev) => {
        const now = Date.now();
        const existing = prev.find((memory) => memory.name === trimmed);
        if (existing) {
          const updated = prev.map((memory) =>
            memory.id === existing.id
              ? { ...memory, content, updatedAt: now }
              : memory
          );
          setActiveMemoryId(existing.id);
          return updated;
        }
        const nextMemory: ScratchpadMemory = {
          id: createMemoryId(),
          name: trimmed,
          content,
          updatedAt: now,
        };
        setActiveMemoryId(nextMemory.id);
        return [nextMemory, ...prev];
      });
    },
    [content],
  );

  const loadMemory = useCallback(
    (id: string | null) => {
      if (!id) {
        // Restore unsaved draft when switching back to "Scratchpad (unsaved)"
        if (unsavedDraftRef.current !== null) {
          setContent(unsavedDraftRef.current);
          unsavedDraftRef.current = null;
        }
        setActiveMemoryId(null);
        return;
      }
      const memory = memories.find((entry) => entry.id === id);
      if (memory) {
        // Cache current content as unsaved draft before loading memory
        // Only cache if we're not already viewing a memory
        if (activeMemoryId === null) {
          unsavedDraftRef.current = content;
        }
        setContent(memory.content);
        setActiveMemoryId(id);
      }
    },
    [memories, activeMemoryId, content],
  );

  const deleteMemory = useCallback((id: string) => {
    setMemories((prev) => prev.filter((memory) => memory.id !== id));
    setActiveMemoryId((prev) => (prev === id ? null : prev));
  }, []);

  const hasContent = content.trim().length > 0;

  return {
    isOpen,
    content,
    hasContent,
    memories,
    activeMemoryId,
    toggle,
    open,
    close,
    clear,
    append,
    replace,
    setContent,
    saveMemory,
    loadMemory,
    deleteMemory,
  };
}

export type UseScratchpadReturn = ReturnType<typeof useScratchpad>;
