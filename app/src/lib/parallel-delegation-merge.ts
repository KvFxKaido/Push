export type ParallelDelegationChangeKind = 'write' | 'delete';

export interface ParallelDelegationChange {
  path: string;
  kind: ParallelDelegationChangeKind;
  status: string;
  raw: string;
}

export interface ParallelDelegationUnsupportedChange {
  path: string;
  status: string;
  raw: string;
  reason: string;
}

export interface ParsedParallelDelegationChanges {
  changes: ParallelDelegationChange[];
  unsupported: ParallelDelegationUnsupportedChange[];
}

export interface ParallelDelegationWorkerChanges {
  workerIndex: number;
  changes: ParallelDelegationChange[];
  unsupported: ParallelDelegationUnsupportedChange[];
}

export interface ParallelDelegationMergeAssignment {
  workerIndex: number;
  path: string;
}

export interface ParallelDelegationMergePlan {
  mergeable: boolean;
  writes: ParallelDelegationMergeAssignment[];
  deletes: ParallelDelegationMergeAssignment[];
  conflicts: string[];
  unsupported: string[];
}

function toWorkspacePath(path: string): string {
  if (!path) return '/workspace';
  if (path.startsWith('/workspace/')) return path;
  if (path === '/workspace') return path;
  const normalized = path.replace(/^\.?\//, '');
  return `/workspace/${normalized}`;
}

function decodeGitPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function isUnsupportedStatus(status: string): string | null {
  if (status === '!!') return 'ignored';
  if (/[RC]/.test(status)) return 'rename_or_copy';
  if (/[U]/.test(status) || status === 'AA' || status === 'DD') return 'merge_conflict';
  if (status === '??') return null;
  if (/[MAD]/.test(status)) return null;
  return 'unsupported_status';
}

export function parseParallelDelegationStatus(output: string): ParsedParallelDelegationChanges {
  const changes: ParallelDelegationChange[] = [];
  const unsupported: ParallelDelegationUnsupportedChange[] = [];

  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    if (line.length < 3) {
      unsupported.push({
        path: '/workspace',
        status: line,
        raw: line,
        reason: 'malformed_status_line',
      });
      continue;
    }

    const status = line.slice(0, 2);
    const rest = line.slice(3);
    const normalizedPath = decodeGitPath(
      rest.includes(' -> ') ? rest.split(' -> ').pop() || rest : rest,
    );
    const path = toWorkspacePath(normalizedPath);
    const unsupportedReason = isUnsupportedStatus(status);

    if (unsupportedReason === 'ignored') continue;
    if (unsupportedReason) {
      unsupported.push({ path, status, raw: line, reason: unsupportedReason });
      continue;
    }

    const kind: ParallelDelegationChangeKind =
      status === '??' || !status.includes('D') ? 'write' : 'delete';
    changes.push({ path, kind, status, raw: line });
  }

  return { changes, unsupported };
}

export function buildParallelDelegationMergePlan(
  workerChanges: ParallelDelegationWorkerChanges[],
): ParallelDelegationMergePlan {
  const writes: ParallelDelegationMergeAssignment[] = [];
  const deletes: ParallelDelegationMergeAssignment[] = [];
  const conflicts: string[] = [];
  const unsupported: string[] = [];
  const seenByPath = new Map<string, number>();

  for (const worker of workerChanges) {
    for (const issue of worker.unsupported) {
      unsupported.push(`Task ${worker.workerIndex + 1}: ${issue.path} (${issue.reason})`);
    }

    for (const change of worker.changes) {
      const seen = seenByPath.get(change.path);
      if (seen !== undefined && seen !== worker.workerIndex) {
        conflicts.push(change.path);
        continue;
      }
      seenByPath.set(change.path, worker.workerIndex);

      const assignment = { workerIndex: worker.workerIndex, path: change.path };
      if (change.kind === 'delete') deletes.push(assignment);
      else writes.push(assignment);
    }
  }

  return {
    mergeable: conflicts.length === 0 && unsupported.length === 0,
    writes,
    deletes,
    conflicts: [...new Set(conflicts)].sort(),
    unsupported,
  };
}
