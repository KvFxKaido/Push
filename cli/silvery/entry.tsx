// cli/silvery/entry.tsx — silvery TUI renderer entry point.
//
// Selected by launchTui() (cli/cli.ts) as the sole full-screen renderer.
//
// The launcher's Node>=24 guard runs before this module loads, because importing
// silvery 0.21 itself is a parse-time error on older Node releases.

import React from 'react';
import { parseKey, render, type Instance } from 'silvery';

import { createSilveryController, type SilveryController } from './controller.js';
import { installProcessWatchdog, PushShell } from './push-shell.js';
import { PushSurface, type PushSurfaceHook } from './surface.js';

export interface RunTuiOptions {
  sessionId?: string | null;
  provider?: string;
  model?: string;
  cwd?: string;
  maxRounds?: number;
  explicitMaxRounds?: boolean;
}

function logRenderFault(layer: 'recoverable' | 'root', error: Error) {
  console.error(
    JSON.stringify({
      level: 'error',
      event: `tui_silvery_${layer}_fault`,
      message: error.message,
    }),
  );
}

export interface RunTuiSilveryDeps {
  createController?: typeof createSilveryController;
  hook?: PushSurfaceHook;
}

/**
 * Silvery currently consumes Tab for focus traversal before `useInput` runs.
 * Push has one composer focus target, so bridge only Tab/Shift+Tab back into
 * the surface's completion callback at the raw TTY boundary.
 */
export function bridgeSilveryCompletionKey(chunk: string | Buffer, hook: PushSurfaceHook): boolean {
  const [, key] = parseKey(chunk);
  if (!key.tab) return false;
  hook.complete?.(key.shift);
  return true;
}

export async function runTuiSilvery(
  options: RunTuiOptions,
  deps: RunTuiSilveryDeps = {},
): Promise<number> {
  let instance: Instance | undefined;
  let controller: SilveryController | undefined;
  const surfaceHook = deps.hook ?? {};
  let tabInputListener: ((chunk: string | Buffer) => void) | undefined;
  const watchdog = installProcessWatchdog({
    getInstance: () => instance,
    abortActive: () => controller?.cancel(),
  });

  try {
    controller = await (deps.createController ?? createSilveryController)(options);
    const handle = render(
      <PushShell
        onRecoverableError={(error) => logRenderFault('recoverable', error)}
        onRootError={(error) => logRenderFault('root', error)}
      >
        <PushSurface controller={controller} hook={surfaceHook} />
      </PushShell>,
      undefined,
      {
        // PushSurface owns Ctrl+C so running cancels while idle exits.
        exitOnCtrlC: false,
        alternateScreen: true,
        mode: 'fullscreen',
        mouse: true,
      },
    );
    instance = await handle;
    tabInputListener = (chunk) => {
      bridgeSilveryCompletionKey(chunk, surfaceHook);
    };
    process.stdin.prependListener('data', tabInputListener);
    // Terminal handoff for /editor (and future pagers): pause Silvery paint while
    // the child owns the real TTY, then resume for a full redraw.
    controller.setHandoffHooks({
      onSuspend: () => instance?.pause(),
      onResume: () => instance?.resume(),
    });
    await instance.waitUntilExit();
    return 0;
  } catch (error) {
    // Synchronous failure path: clean up + surface the error but RETURN (don't
    // process.exit) so main()'s finally — worktree teardown for `push --worktree`
    // — still runs. The process-level watchdog keeps exit(1) for async faults.
    watchdog.recover('renderer', error);
    return 1;
  } finally {
    if (tabInputListener) process.stdin.removeListener('data', tabInputListener);
    await controller?.dispose();
    watchdog.dispose();
  }
}
