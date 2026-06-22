/**
 * NativeJGitCheckpointStore — the APK/native CheckpointStore backend (skeleton).
 *
 * Target: an app-private on-device `git init` repo (a SEPARATE backup dir, never
 * the session's active working copy), capturing the sandbox tree as local
 * full-tree commits. Local, durable, offline, no remote exposure.
 *
 * This increment ships only the skeleton: every method degrades cleanly to an
 * `unsupported` / `unavailable` result and emits a structured log, so if the
 * native flag is ever on before capture/restore land (PR2/PR3), the no-op is
 * visible to ops rather than a silent dead-end. Capture transport (sandbox tree
 * download with exclusions + size cap → JGit commit + retention) and restore
 * (delete-aware sync into a sandbox) land in the following increments — see
 * `docs/decisions/Native Checkpoint Store.md`.
 */

import type {
  CheckpointCaptureInput,
  CheckpointCaptureResult,
  CheckpointRestoreAvailability,
  CheckpointRestoreResult,
  CheckpointStore,
} from './checkpoint-store';

type LogFn = (level: 'info' | 'warn', event: string, ctx: Record<string, unknown>) => void;
const defaultLog: LogFn = (level, event, ctx) =>
  console.log(JSON.stringify({ level, event, ...ctx }));

const NOT_IMPLEMENTED = 'native checkpoint store not yet implemented';

/**
 * Build the native store. `log` is injectable for tests; the live export uses
 * the default structured logger.
 */
export function createNativeJgitCheckpointStore(log: LogFn = defaultLog): CheckpointStore {
  return {
    kind: 'native-jgit',

    async capture(input: CheckpointCaptureInput): Promise<CheckpointCaptureResult> {
      log('info', 'native_checkpoint_capture_unsupported', {
        sandboxId: input.sandboxId,
        branch: input.branch,
      });
      return { status: 'unsupported' };
    },

    async detectRestore(
      sandboxId: string,
      branch: string | null | undefined,
    ): Promise<CheckpointRestoreAvailability> {
      log('info', 'native_checkpoint_detect_unsupported', { sandboxId, branch: branch ?? null });
      return { available: false, reason: NOT_IMPLEMENTED };
    },

    async restore(
      sandboxId: string,
      branch: string | null | undefined,
      checkpointId: string,
    ): Promise<CheckpointRestoreResult> {
      log('warn', 'native_checkpoint_restore_unsupported', {
        sandboxId,
        branch: branch ?? null,
        checkpointId,
      });
      return { status: 'unsupported' };
    },
  };
}

export const nativeJgitCheckpointStore: CheckpointStore = createNativeJgitCheckpointStore();
