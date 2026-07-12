// cli/silvery/entry.tsx — silvery TUI renderer entry point.
//
// Selected by launchTui() (cli/cli.ts) when PUSH_TUI_SILVERY is set on Node >=24.
// It accepts the SAME options contract as runTUI() (cli/tui.ts) so it is a true
// drop-in alternate renderer.
//
// The launcher's Node>=24 guard runs before this module loads, because importing
// silvery 0.21 itself is a parse-time error on older Node releases.

import React from 'react';
import { render, type Instance } from 'silvery';

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

export async function runTuiSilvery(
  options: RunTuiOptions,
  deps: RunTuiSilveryDeps = {},
): Promise<number> {
  let instance: Instance | undefined;
  let controller: SilveryController | undefined;
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
        <PushSurface controller={controller} hook={deps.hook} />
      </PushShell>,
      undefined,
      {
        exitOnCtrlC: true,
        alternateScreen: true,
        mode: 'fullscreen',
        mouse: true,
      },
    );
    instance = await handle;
    await instance.waitUntilExit();
    return 0;
  } catch (error) {
    // Synchronous failure path: clean up + surface the error but RETURN (don't
    // process.exit) so main()'s finally — worktree teardown for `push --worktree`
    // — still runs. The process-level watchdog keeps exit(1) for async faults.
    watchdog.recover('renderer', error);
    return 1;
  } finally {
    await controller?.dispose();
    watchdog.dispose();
  }
}
