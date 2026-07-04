import { lazy, Suspense } from 'react';
import type { WorkspaceScreenProps } from '@/types';

const WorkspaceSessionScreen = lazy(() =>
  import('./WorkspaceSessionScreen').then((module) => ({ default: module.WorkspaceSessionScreen })),
);
const RelayChatScreen = lazy(() =>
  import('./RelayChatScreen').then((module) => ({ default: module.RelayChatScreen })),
);
const workspaceFallback = <div className="h-dvh bg-push-surface-inset" />;

export function WorkspaceScreen(props: WorkspaceScreenProps) {
  const { workspaceSession } = props.workspace;

  // Relay sessions route through the Worker-mediated daemon path.
  if (workspaceSession.kind === 'relay') {
    return (
      <Suspense fallback={workspaceFallback}>
        <RelayChatScreen
          // Keyed by target so switching the attached session
          // (tap-to-resume) remounts the chat shell: useChat state,
          // hydrated history, and run/approval projections all start
          // clean for the new session instead of the old chat sitting
          // under the new session's prepended transcript.
          key={workspaceSession.binding.targetSessionId ?? 'untargeted'}
          binding={workspaceSession.binding}
          onLeave={props.navigation.onEndWorkspace}
          onUnpair={props.navigation.onEndWorkspace}
          auth={props.auth}
          onDisconnect={props.navigation.onDisconnect}
          onResumeSession={props.navigation.onResumeRelaySession}
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
