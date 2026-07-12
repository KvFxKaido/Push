/**
 * tui-handoff.ts — terminal handoff/reclaim for the TUI (issue #1423).
 *
 * Suspends the full-screen TUI, hands the real terminal to an external
 * interactive child (`$EDITOR`, a pager, interactive git), and reclaims it
 * when the child exits. Design reference: giggles' (`zion-off/giggles`)
 * suspend-for-external-program flow, recorded in the 2026-07-12 TUI field
 * survey (`docs/decisions/Retained-Mode TUI — MVU + Pure-TS Compositor.md`).
 *
 * Sequencing contract (the order is load-bearing):
 *   suspend:  onSuspend (gate rendering) → raw mode off → stdin pause →
 *             suspend ANSI (leave alt screen, mouse off, cursor show) →
 *             ignore SIGINT (cooked-mode Ctrl+C must kill the child only)
 *   resume:   restore SIGINT → resume ANSI (re-enter alt screen) →
 *             raw mode on → stdin resume → onResume (invalidate + repaint)
 *
 * Everything goes through the `TuiIo` seam so the headless harness can drive
 * suspend/resume with a fake child and no real TTY. Structured logs go to
 * stderr (CLI stdout is reserved for user output — see CLAUDE.md's
 * symmetric-structured-logs convention).
 */
import type { TuiIo } from './tui-io.js';

export interface HandoffChildSpec {
  command: string;
  args: string[];
  /** Extra env merged over process.env for the child. */
  env?: Record<string, string | undefined>;
}

export interface HandoffChildExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export type HandoffRunChild = (spec: HandoffChildSpec) => Promise<HandoffChildExit>;

export interface HandoffResult extends HandoffChildExit {
  ok: boolean;
  /** Present when the child could not be spawned (or the runner threw). */
  error?: string;
}

export interface TerminalHandoffDeps {
  io: TuiIo;
  /** ANSI emitted when leaving the TUI (mouse off, alt screen off, cursor show, …). */
  suspendSequence: () => string;
  /** ANSI emitted when reclaiming (alt screen on, clear, cursor hide, mouse per mode, …). */
  resumeSequence: () => string;
  /** Gate rendering before the terminal leaves our control. */
  onSuspend: () => void;
  /** Ungate + invalidate + full repaint after the terminal is ours again. */
  onResume: () => void;
  /** Child runner seam; production defaults to spawn with inherited stdio. */
  runChild?: HandoffRunChild;
}

export interface TerminalHandoff {
  run: (spec: HandoffChildSpec) => Promise<HandoffResult>;
  isActive: () => boolean;
}

/** Production child runner: inherit the real terminal fds and wait for exit. */
export async function spawnInheritedChild(spec: HandoffChildSpec): Promise<HandoffChildExit> {
  const { spawn } = await import('node:child_process');
  return new Promise<HandoffChildExit>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      stdio: 'inherit',
      env: spec.env ? { ...process.env, ...spec.env } : process.env,
      // Windows: $EDITOR values like "code -w" resolve through the shell's
      // PATHEXT (.cmd/.bat shims); POSIX spawns the binary directly.
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('exit', (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

const sigintIgnore = () => {
  /* the child owns Ctrl+C while the terminal is handed off */
};

export function createTerminalHandoff(deps: TerminalHandoffDeps): TerminalHandoff {
  const { io, suspendSequence, resumeSequence, onSuspend, onResume } = deps;
  const runChild = deps.runChild ?? spawnInheritedChild;
  let active = false;

  const log = (event: string, ctx: Record<string, unknown>) => {
    io.stderr.write(`${JSON.stringify({ level: 'info', event, ...ctx })}\n`);
  };

  async function run(spec: HandoffChildSpec): Promise<HandoffResult> {
    if (active) {
      // A second handoff while the terminal is already handed off would fight
      // the child for stdin and double-restore the screen. Reject, visibly.
      log('tui_handoff_rejected_reentrant', { command: spec.command });
      return { ok: false, exitCode: null, signal: null, error: 'terminal handoff already active' };
    }
    active = true;
    onSuspend();
    if (io.stdin.isTTY) io.stdin.setRawMode?.(false);
    io.stdin.pause();
    io.stdout.write(suspendSequence());
    // In cooked mode Ctrl+C raises SIGINT on the whole foreground process
    // group. The child should die from it; the TUI must not. Registering any
    // listener replaces the default terminate action; removed on resume.
    io.addSignalHandler('SIGINT', sigintIgnore);
    log('tui_handoff_started', { command: spec.command, args: spec.args });

    let exit: HandoffChildExit = { exitCode: null, signal: null };
    let error: string | undefined;
    try {
      exit = await runChild(spec);
      log('tui_handoff_child_exited', {
        command: spec.command,
        exitCode: exit.exitCode,
        signal: exit.signal,
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      log('tui_handoff_spawn_failed', { command: spec.command, error });
    } finally {
      io.removeSignalHandler('SIGINT', sigintIgnore);
      io.stdout.write(resumeSequence());
      if (io.stdin.isTTY) io.stdin.setRawMode?.(true);
      io.stdin.resume();
      active = false;
      onResume();
      log('tui_handoff_resumed', { command: spec.command });
    }

    return error === undefined ? { ok: true, ...exit } : { ok: false, ...exit, error };
  }

  return { run, isActive: () => active };
}

/**
 * Resolve the user's editor command. `PUSH_EDITOR` wins (Push-specific
 * override), then the POSIX-conventional `VISUAL` → `EDITOR`, then a platform
 * fallback. The value may carry arguments ("code -w"); split on whitespace —
 * the same convention git and crontab apply to $EDITOR.
 */
export function resolveEditorCommand(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  const raw = env.PUSH_EDITOR || env.VISUAL || env.EDITOR;
  const fallback = platform === 'win32' ? 'notepad' : 'vi';
  const parts = (raw ?? fallback).trim().split(/\s+/).filter(Boolean);
  const [command = fallback, ...args] = parts;
  return { command, args };
}
