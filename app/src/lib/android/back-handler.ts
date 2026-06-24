/**
 * Android hardware/gesture back coordination.
 *
 * A Capacitor WebView gets one `backButton` event for the system Back gesture.
 * Push has many independently-stateful overlays (the workspace hub, branch
 * sheets, drawers, the launcher) plus top-level screens, so a single handler
 * can't know what to close. Instead, every dismissable surface registers a
 * back-intent here while it's open; the system Back invokes the TOPMOST
 * (most-recently-registered) one — close the sheet, not the app. When nothing is
 * registered we're at a leaf with no overlay, so Back falls through to the root
 * behavior (background the app, like any Android app at its home screen).
 *
 * Pure registry + a thin `@capacitor/app` binding. Web is untouched: the binding
 * only attaches on the native shell, and the registry is a harmless no-op map
 * everywhere else.
 */

import { isNativePlatform } from '../platform';

/** A back-intent: return true once it has handled (consumed) the Back press. */
export type BackIntent = () => boolean;

interface Registration {
  readonly id: number;
  readonly intent: BackIntent;
}

const stack: Registration[] = [];
let nextId = 1;
let rootBehavior: (() => void) | null = null;
let bound = false;

/**
 * Register a back-intent. Returns an unregister fn (call on unmount / when the
 * surface closes). The most-recently-registered active intent wins — so a sheet
 * opened on top of another closes first.
 */
export function registerBackIntent(intent: BackIntent): () => void {
  const id = nextId++;
  stack.push({ id, intent });
  return () => {
    const i = stack.findIndex((r) => r.id === id);
    if (i !== -1) stack.splice(i, 1);
  };
}

/**
 * What Back does when no overlay/screen has registered an intent — i.e. we're at
 * the true root. Defaults to backgrounding the app on native. Set once by the app
 * shell; overridable for screen-level "go back a level then exit" wiring.
 */
export function setRootBackBehavior(fn: () => void): void {
  rootBehavior = fn;
}

/**
 * Dispatch a Back press through the registry. Invokes the topmost intent that
 * consumes it (returns true); if none do (or the stack is empty), runs the root
 * behavior. Exported for tests and for the native binding.
 */
export function dispatchBack(): void {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].intent()) return;
  }
  rootBehavior?.();
}

/**
 * Bind the system Back gesture to the registry (native shell only; idempotent).
 * Lazy-imports `@capacitor/app` so the web bundle never pulls it in. The default
 * root behavior backgrounds the app.
 */
export async function bindAndroidBackHandler(): Promise<void> {
  if (bound || !isNativePlatform()) return;
  bound = true;
  const { App } = await import('@capacitor/app');
  if (!rootBehavior) {
    rootBehavior = () => {
      void App.minimizeApp();
    };
  }
  await App.addListener('backButton', () => dispatchBack());
}

/** Test-only: reset the module's mutable state between cases. */
export function __resetBackHandlerForTests(): void {
  stack.length = 0;
  nextId = 1;
  rootBehavior = null;
  bound = false;
}
