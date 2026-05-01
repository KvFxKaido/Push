export interface MutationFailureEntry {
  tool: string;
  file: string;
  errorType: string;
  count: number;
}

export function makeMutationKey(tool: string, file: string): string {
  return `${tool}::${file}`;
}

export function extractMutatedPaths(
  tool: string,
  args: Record<string, unknown>,
  primaryPath: string,
): string[] {
  if (tool === 'sandbox_apply_patchset' && Array.isArray(args.edits)) {
    const paths: string[] = [];
    for (const edit of args.edits) {
      const rec = edit as Record<string, unknown> | null;
      if (rec && typeof rec.path === 'string') paths.push(rec.path);
    }
    return paths;
  }
  if (primaryPath) return [primaryPath];
  return [];
}

export function recordMutationFailure(
  failures: Map<string, MutationFailureEntry>,
  tool: string,
  file: string,
  errorType: string,
): MutationFailureEntry {
  const key = makeMutationKey(tool, file);
  const existing = failures.get(key);
  if (existing && existing.errorType === errorType) {
    existing.count++;
    return existing;
  }

  const entry: MutationFailureEntry = {
    tool,
    file,
    errorType,
    count: 1,
  };
  failures.set(key, entry);
  return entry;
}

export function clearMutationFailure(
  failures: Map<string, MutationFailureEntry>,
  tool: string,
  file: string,
): void {
  failures.delete(makeMutationKey(tool, file));
}

export function formatMutationHardFailure(entry: MutationFailureEntry): string {
  return `[SANDBOX_WRITE_HARD_FAILURE]\n${entry.tool} has failed ${entry.count} consecutive times on ${entry.file || 'the same target'} with error_type=${entry.errorType}.\nContainer may be unstable. Stop mutation attempts. Summarize what you accomplished and what remains.\n[/SANDBOX_WRITE_HARD_FAILURE]`;
}
