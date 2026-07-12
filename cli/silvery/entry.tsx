// cli/silvery/entry.tsx — silvery TUI renderer entry point.
//
// Selected by launchTui() (cli/cli.ts) when PUSH_TUI_SILVERY is set on Node >=24.
// It accepts the SAME options contract as runTUI() (cli/tui.ts) so it is a true
// drop-in alternate renderer.
//
// Phase 0 stub: the renderer is not yet wired. This file exists so the launcher's
// dispatch + lazy import are complete and reviewable on their own; the real
// PushShell + render land in the next commit. Deliberately imports no silvery
// here — the launcher's Node>=24 guard runs before this module loads, and a stub
// with no `silvery` import can't SyntaxError on older Node.

export interface RunTuiOptions {
  sessionId?: string | null;
  provider?: string;
  model?: string;
  cwd?: string;
  maxRounds?: number;
  explicitMaxRounds?: boolean;
}

export async function runTuiSilvery(_options: RunTuiOptions): Promise<number> {
  throw new Error(
    'silvery TUI renderer is not yet implemented (Phase 0 in progress). ' +
      'Unset PUSH_TUI_SILVERY to use the default TUI.',
  );
}
