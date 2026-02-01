/**
 * Thin HTTP client for the sandbox proxy at /api/sandbox/*.
 *
 * All calls go through the Cloudflare Worker which proxies to Modal.
 * No Modal SDK or gRPC — just plain fetch().
 */

// --- Types ---

export interface SandboxSession {
  sandboxId: string;
  status: 'ready' | 'error';
  error?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

export interface FileReadResult {
  content: string;
  truncated: boolean;
}

export interface DiffResult {
  diff: string;
  truncated: boolean;
}

// --- Helpers ---

const SANDBOX_BASE = '/api/sandbox';

async function sandboxFetch<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${SANDBOX_BASE}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Sandbox ${endpoint} failed (${res.status}): ${text.slice(0, 200)}`);
  }

  return res.json();
}

// --- Public API ---

export async function createSandbox(
  repo: string,
  branch?: string,
  githubToken?: string,
): Promise<SandboxSession> {
  const data = await sandboxFetch<{ sandbox_id: string | null; status?: string; error?: string }>(
    'create',
    { repo, branch: branch || 'main', github_token: githubToken || '' },
  );

  if (!data.sandbox_id) {
    return { sandboxId: '', status: 'error', error: data.error || 'Unknown error' };
  }

  return { sandboxId: data.sandbox_id, status: 'ready' };
}

export async function execInSandbox(
  sandboxId: string,
  command: string,
  workdir?: string,
): Promise<ExecResult> {
  return sandboxFetch<ExecResult>('exec', {
    sandbox_id: sandboxId,
    command,
    workdir: workdir || '/workspace',
  });
}

export async function readFromSandbox(
  sandboxId: string,
  path: string,
): Promise<FileReadResult> {
  return sandboxFetch<FileReadResult>('read', {
    sandbox_id: sandboxId,
    path,
  });
}

export async function writeToSandbox(
  sandboxId: string,
  path: string,
  content: string,
): Promise<{ ok: boolean }> {
  return sandboxFetch<{ ok: boolean }>('write', {
    sandbox_id: sandboxId,
    path,
    content,
  });
}

export async function getSandboxDiff(
  sandboxId: string,
): Promise<DiffResult> {
  return sandboxFetch<DiffResult>('diff', {
    sandbox_id: sandboxId,
  });
}

export async function cleanupSandbox(
  sandboxId: string,
): Promise<{ ok: boolean }> {
  return sandboxFetch<{ ok: boolean }>('cleanup', {
    sandbox_id: sandboxId,
  });
}

// --- File browser operations ---

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
}

export async function listDirectory(
  sandboxId: string,
  path: string = '/workspace',
): Promise<FileEntry[]> {
  const data = await sandboxFetch<{ entries: FileEntry[]; error?: string }>('list', {
    sandbox_id: sandboxId,
    path,
  });
  if (data.error) throw new Error(data.error);
  return data.entries;
}

export async function deleteFromSandbox(
  sandboxId: string,
  path: string,
): Promise<void> {
  const data = await sandboxFetch<{ ok: boolean; error?: string }>('delete', {
    sandbox_id: sandboxId,
    path,
  });
  if (!data.ok) throw new Error(data.error || 'Delete failed');
}

export async function renameInSandbox(
  sandboxId: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  const data = await sandboxFetch<{ ok: boolean; error?: string }>('rename', {
    sandbox_id: sandboxId,
    old_path: oldPath,
    new_path: newPath,
  });
  if (!data.ok) throw new Error(data.error || 'Rename failed');
}
