import { promises as fs } from 'node:fs';

// Transient errors Windows raises on rename-over-an-open-target that POSIX does
// not. POSIX `rename` atomically replaces the destination even while another
// process holds it open; Windows `MoveFileEx` fails with these codes until the
// competing handle closes.
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY']);

/**
 * Rename `from` over `to`, retrying on the transient Windows errors above so the
 * atomic write-then-rename pattern (`writeFile(tmp)` → `rename(tmp, dest)`)
 * doesn't surface a spurious EPERM when a concurrent reader or writer momentarily
 * holds the destination open. On POSIX the first attempt always wins, so this is
 * a no-op there. Total backoff is capped under ~0.5s; if the target stays locked
 * past that (or the error isn't a transient rename code), the real error
 * propagates so a genuine failure isn't swallowed.
 */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  const maxAttempts = 10;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= maxAttempts || !code || !TRANSIENT_RENAME_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(attempt * 10, 100)));
    }
  }
}
