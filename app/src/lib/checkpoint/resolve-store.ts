/**
 * resolveCheckpointStore — the live checkpoint-store selector.
 *
 * Thin wrapper over `selectCheckpointStore` that injects the two concrete stores
 * (kept here, not in `checkpoint-store.ts`, to avoid an interface↔implementation
 * import cycle). Returns the native on-device store on the APK shell when the
 * `VITE_NATIVE_CHECKPOINTS` flag is set; the remote draft-ref store otherwise.
 */

import { selectCheckpointStore, type CheckpointStore } from './checkpoint-store';
import { remoteDraftRefCheckpointStore } from './remote-draft-ref-store';
import { nativeJgitCheckpointStore } from './native-jgit-store';

export function resolveCheckpointStore(): CheckpointStore {
  return selectCheckpointStore({
    nativeStore: nativeJgitCheckpointStore,
    remoteStore: remoteDraftRefCheckpointStore,
  });
}
