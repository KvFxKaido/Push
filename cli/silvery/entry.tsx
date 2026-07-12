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

import { HelloPush } from './hello.js';
import { installProcessWatchdog, PushShell } from './push-shell.js';

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

export async function runTuiSilvery(_options: RunTuiOptions): Promise<number> {
  let instance: Instance | undefined;
  const watchdog = installProcessWatchdog({ getInstance: () => instance });

  try {
    const handle = render(
      <PushShell
        onRecoverableError={(error) => logRenderFault('recoverable', error)}
        onRootError={(error) => logRenderFault('root', error)}
      >
        <HelloPush />
      </PushShell>,
      undefined,
      {
        exitOnCtrlC: true,
        alternateScreen: true,
        mode: 'fullscreen',
        mouse: false,
      },
    );
    instance = await handle;
    await instance.waitUntilExit();
    return 0;
  } catch (error) {
    watchdog.handleFatal('renderer', error);
    return 1;
  } finally {
    watchdog.dispose();
  }
}
