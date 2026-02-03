/**
 * useSandbox — manages sandbox session lifecycle.
 *
 * Status: idle → creating → ready → error
 *
 * The sandbox persists across messages in a single chat session.
 * Container auto-terminates on Modal's side after 30 min.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { createSandbox, cleanupSandbox } from '@/lib/sandbox-client';

export type SandboxStatus = 'idle' | 'creating' | 'ready' | 'error';

const OAUTH_STORAGE_KEY = 'github_access_token';
const GITHUB_TOKEN = import.meta.env.VITE_GITHUB_TOKEN || '';

function getGitHubToken(): string {
  return localStorage.getItem(OAUTH_STORAGE_KEY) || GITHUB_TOKEN;
}

export function useSandbox() {
  const [sandboxId, setSandboxId] = useState<string | null>(null);
  const [status, setStatus] = useState<SandboxStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const sandboxIdRef = useRef<string | null>(null);

  // Keep ref in sync for cleanup
  useEffect(() => {
    sandboxIdRef.current = sandboxId;
  }, [sandboxId]);

  const start = useCallback(async (repo: string, branch?: string): Promise<string | null> => {
    if (status === 'creating') return null;

    setStatus('creating');
    setError(null);

    try {
      const token = getGitHubToken();
      const session = await createSandbox(repo, branch, token);

      if (session.status === 'error') {
        setStatus('error');
        setError(session.error || 'Sandbox creation failed');
        return null;
      }

      setSandboxId(session.sandboxId);
      setStatus('ready');
      return session.sandboxId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus('error');
      setError(msg);
      return null;
    }
  }, [status]);

  const stop = useCallback(async () => {
    const id = sandboxIdRef.current;
    if (!id) return;

    try {
      await cleanupSandbox(id);
    } catch {
      // Best effort — container will auto-terminate anyway
    }

    setSandboxId(null);
    setStatus('idle');
    setError(null);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const id = sandboxIdRef.current;
      if (id) {
        cleanupSandbox(id).catch(() => {});
      }
    };
  }, []);

  return {
    sandboxId,
    status,
    error,
    start,
    stop,
  };
}
