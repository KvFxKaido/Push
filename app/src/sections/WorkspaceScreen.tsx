import { lazy, Suspense } from 'react';
import type { WorkspaceScreenProps } from '@/types';

const WorkspaceSessionScreen = lazy(() =>
  import('./WorkspaceSessionScreen').then((module) => ({ default: module.WorkspaceSessionScreen })),
);
const workspaceFallback = <div className="h-dvh bg-[#000]" />;

export function WorkspaceScreen(props: WorkspaceScreenProps) {
  return (
    <Suspense fallback={workspaceFallback}>
      <WorkspaceSessionScreen {...props} />
    </Suspense>
  );
}

export default WorkspaceScreen;
