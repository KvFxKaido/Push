/**
 * Re-export from shared lib — canonical init-deep logic lives in
 * lib/init-deep.ts.
 */
export {
  INIT_DEEP_IGNORED_DIRS,
  isSignificantDir,
  renderAgentsMd,
  planInitDeep,
} from '@push/lib/init-deep';

export type {
  InitDeepDirHints,
  InitDeepDirSnapshot,
  InitDeepFileEntry,
  InitDeepProposal,
  InitDeepSignificance,
  PlanInitDeepOptions,
  PlanInitDeepResult,
} from '@push/lib/init-deep';
