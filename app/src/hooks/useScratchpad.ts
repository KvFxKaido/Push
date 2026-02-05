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
const MAX_STORAGE_SIZE = 500_000; // 500KB soft cap for localStorage

function getStorageKey(repoFullName: string | null): string {
  return repoFullName
    ? `push-scratchpad:${repoFullName}`
    : GLOBAL_STORAGE_KEY;
}

export interface ScratchpadState {
  isOpen: boolean;
  content: string;
}

export function useScratchpad(repoFullName: string | null = null) {
  const [isOpen, setIsOpen] = useState(false);
  const [content, setContent] = useState('');
  const hasMigratedRef = useRef(false);

  // Load content when repo changes, with migration support
  useEffect(() => {
    const storageKey = getStorageKey(repoFullName);

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

  const hasContent = content.trim().length > 0;

  return {
    isOpen,
    content,
    hasContent,
    toggle,
    open,
    close,
    clear,
    append,
    replace,
    setContent,
  };
}

export type UseScratchpadReturn = ReturnType<typeof useScratchpad>;
