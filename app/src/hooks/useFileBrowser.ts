/**
 * useFileBrowser — state management for the file browser screen.
 *
 * Tracks current directory, fetches contents, handles CRUD operations.
 * All operations go through the sandbox client (no LLM involvement).
 */

import { useState, useCallback, useRef } from 'react';
import {
  listDirectory,
  writeToSandbox,
  deleteFromSandbox,
  renameInSandbox,
} from '@/lib/sandbox-client';
import type { FileEntry } from '@/lib/sandbox-client';

export type FileBrowserStatus = 'idle' | 'loading' | 'error';

export interface FileOperation {
  type: 'upload' | 'delete' | 'rename';
  path: string;
  status: 'success' | 'error';
  message: string;
  timestamp: number;
}

export function useFileBrowser(sandboxId: string | null) {
  const [currentPath, setCurrentPath] = useState('/workspace');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [status, setStatus] = useState<FileBrowserStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [operations, setOperations] = useState<FileOperation[]>([]);
  const loadingRef = useRef(false);

  const addOperation = useCallback((op: Omit<FileOperation, 'timestamp'>) => {
    setOperations((prev) => [{ ...op, timestamp: Date.now() }, ...prev].slice(0, 20));
  }, []);

  // Fetch directory contents
  const loadDirectory = useCallback(async (path: string) => {
    if (!sandboxId || loadingRef.current) return;
    loadingRef.current = true;
    setStatus('loading');
    setError(null);

    try {
      const entries = await listDirectory(sandboxId, path);
      setFiles(entries);
      setCurrentPath(path);
      setStatus('idle');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStatus('error');
    } finally {
      loadingRef.current = false;
    }
  }, [sandboxId]);

  // Navigate into a directory
  const navigateTo = useCallback((path: string) => {
    loadDirectory(path);
  }, [loadDirectory]);

  // Navigate to parent
  const navigateUp = useCallback(() => {
    if (currentPath === '/workspace' || currentPath === '/') return;
    const parent = currentPath.split('/').slice(0, -1).join('/') || '/';
    loadDirectory(parent);
  }, [currentPath, loadDirectory]);

  // Upload files to current directory
  const uploadFiles = useCallback(async (fileList: FileList) => {
    if (!sandboxId) return;

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const targetPath = `${currentPath.replace(/\/$/, '')}/${file.name}`;

      try {
        const content = await file.text();
        await writeToSandbox(sandboxId, targetPath, content);
        addOperation({ type: 'upload', path: targetPath, status: 'success', message: `Uploaded ${file.name}` });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        addOperation({ type: 'upload', path: targetPath, status: 'error', message: `Failed to upload ${file.name}: ${msg}` });
      }
    }

    // Refresh
    loadDirectory(currentPath);
  }, [sandboxId, currentPath, loadDirectory, addOperation]);

  // Delete file or folder
  const deleteItem = useCallback(async (path: string) => {
    if (!sandboxId) return;
    const name = path.split('/').pop() || path;

    try {
      await deleteFromSandbox(sandboxId, path);
      addOperation({ type: 'delete', path, status: 'success', message: `Deleted ${name}` });
      loadDirectory(currentPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addOperation({ type: 'delete', path, status: 'error', message: `Failed to delete ${name}: ${msg}` });
    }
  }, [sandboxId, currentPath, loadDirectory, addOperation]);

  // Rename file or folder
  const renameItem = useCallback(async (oldPath: string, newName: string) => {
    if (!sandboxId) return;
    const oldName = oldPath.split('/').pop() || oldPath;
    const parentDir = oldPath.split('/').slice(0, -1).join('/');
    const newPath = `${parentDir}/${newName}`;

    try {
      await renameInSandbox(sandboxId, oldPath, newPath);
      addOperation({ type: 'rename', path: newPath, status: 'success', message: `Renamed ${oldName} → ${newName}` });
      loadDirectory(currentPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addOperation({ type: 'rename', path: oldPath, status: 'error', message: `Failed to rename ${oldName}: ${msg}` });
    }
  }, [sandboxId, currentPath, loadDirectory, addOperation]);

  // Breadcrumb segments
  const breadcrumbs = currentPath.split('/').filter(Boolean).map((segment, i, arr) => ({
    label: segment,
    path: '/' + arr.slice(0, i + 1).join('/'),
  }));

  return {
    currentPath,
    files,
    status,
    error,
    operations,
    breadcrumbs,
    loadDirectory,
    navigateTo,
    navigateUp,
    uploadFiles,
    deleteItem,
    renameItem,
  };
}
