import { lazy, Suspense } from 'react';
import type { WorkspaceScreenProps } from '@/types';

const WorkspaceSessionScreen = lazy(() =>
  import('./WorkspaceSessionScreen').then((module) => ({ default: module.WorkspaceSessionScreen })),
);
const LocalPcWorkspace = lazy(() =>
  import('./LocalPcWorkspace').then((module) => ({ default: module.LocalPcWorkspace })),
);
const workspaceFallback = <div className="h-dvh bg-[#000]" />;

export function WorkspaceScreen(props: WorkspaceScreenProps) {
  const { workspaceSession } = props.workspace;

  // Local-pc sessions take an entirely different transport (loopback
  // WebSocket to pushd) and don't share the cloud workspace's chat
  // round loop in PR 3b. Branch at the top of the workspace shell so
  // there's no risk of the cloud session controller running over a
  // local-pc binding. PR 3c rejoins these paths through a shared
  // dispatch seam in `useChat`.
  if (workspaceSession.kind === 'local-pc') {
    return (
      <Suspense fallback={workspaceFallback}>
        <LocalPcWorkspace
          binding={workspaceSession.binding}
          onUnpair={props.navigation.onEndWorkspace}
        />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={workspaceFallback}>
      <WorkspaceSessionScreen {...props} />
    </Suspense>
  );
}

export default WorkspaceScreen;
