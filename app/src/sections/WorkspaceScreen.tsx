import { lazy, Suspense } from 'react';
import type { WorkspaceScreenProps } from '@/types';

const WorkspaceSessionScreen = lazy(() =>
  import('./WorkspaceSessionScreen').then((module) => ({ default: module.WorkspaceSessionScreen })),
);
const LocalPcChatScreen = lazy(() =>
  import('./LocalPcChatScreen').then((module) => ({ default: module.LocalPcChatScreen })),
);
const workspaceFallback = <div className="h-dvh bg-[#000]" />;

export function WorkspaceScreen(props: WorkspaceScreenProps) {
  const { workspaceSession } = props.workspace;

  // Local-pc sessions take an entirely different transport (loopback
  // WebSocket to pushd). PR 3c.2b lands a real chat surface on top of
  // the runtime dispatch seam shipped in PR #514: useChat mounts here
  // with the daemon binding threaded in, sandbox tool calls route to
  // pushd, and the chat round loop sees the daemon return shapes.
  // The previous probe-only `LocalPcWorkspace` is removed.
  if (workspaceSession.kind === 'local-pc') {
    return (
      <Suspense fallback={workspaceFallback}>
        <LocalPcChatScreen
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
