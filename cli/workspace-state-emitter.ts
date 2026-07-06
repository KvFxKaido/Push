/**
 * CLI daemon emitter for the live workspace-state timeline
 * (`workspace.state_snapshot` / `workspace.state_delta`).
 *
 * The web adapter (`useWorkspaceSandboxController`) is the other producer; this
 * is the CLI/daemon side. Both reuse the shared, framework-agnostic core in
 * `lib/workspace-state.ts` verbatim — `gitStatusInfoToWorkspaceState` to map a
 * git read into a `WorkspaceState`, and `createWorkspaceStateProducer` to turn
 * successive states into snapshot/delta events. Nothing React-shaped crosses
 * over because none of it lives in `lib/`.
 *
 * This module is deliberately I/O-injectable: `readWorkspaceStateFromGit` takes
 * a `GitExec` so it unit-tests without a real repo, and `nextWorkspaceStateEvent`
 * is pure. The daemon (`cli/pushd.ts`) owns the side effects — holding the
 * per-session producer on the session entry and broadcasting the returned event
 * live-only (workspace events are non-persistent per `shouldPersistRunEvent`).
 */

import { parseGitStatusInfo } from '../lib/git/status.js';
import type { WorkspaceState } from '../lib/runtime-contract.js';
import {
  createWorkspaceStateProducer,
  gitStatusInfoToWorkspaceState,
  type WorkspaceStateEvent,
  type WorkspaceStateProducer,
} from '../lib/workspace-state.js';

/** Minimal git runner. Resolves with stdout, or null when the command fails
 *  (not a git repo, git missing, etc.) — callers treat null as "no state". */
export type GitExec = (args: string[], cwd: string) => Promise<{ stdout: string } | null>;

export interface ReadWorkspaceStateOpts {
  /** `Protect Main` setting. The daemon defaults this off today (parity with
   *  the web adapter's optional arg); thread the real gate config when it
   *  becomes ambient session state. */
  protectMain: boolean;
}

/**
 * Read the working tree into a `WorkspaceState`, or null when `cwd` isn't a git
 * repo / git can't run. HEAD sha (absent from status) is a second read that
 * falls back to a stable non-empty placeholder on an unborn branch. On the CLI
 * the workspace is the local filesystem, so `sandboxReady` is always true.
 */
export async function readWorkspaceStateFromGit(
  cwd: string,
  opts: ReadWorkspaceStateOpts,
  exec: GitExec,
): Promise<WorkspaceState | null> {
  const statusRes = await exec(['status', '--porcelain', '-b'], cwd);
  if (!statusRes) return null;
  const info = parseGitStatusInfo(statusRes.stdout);
  const headRes = await exec(['rev-parse', '--short', 'HEAD'], cwd);
  const headSha = headRes ? headRes.stdout.trim() : '';
  return gitStatusInfoToWorkspaceState(info, {
    headSha: headSha || '(unborn)',
    protectMain: opts.protectMain,
    sandboxReady: true,
  });
}

export interface NextWorkspaceStateEventResult {
  /** The producer to store back on the session (created fresh on snapshot). */
  producer: WorkspaceStateProducer;
  /** The event to broadcast, or null when a delta found nothing changed. */
  event: WorkspaceStateEvent | null;
}

/**
 * Advance the per-session producer. `snapshot` creates a fresh producer and
 * emits its opening snapshot (session start, or a resync anchor); `delta` emits
 * the minimal delta from the last state — but if there is no producer yet it
 * degrades to a snapshot, because a delta with no base is unanchorable.
 */
export function nextWorkspaceStateEvent(
  producer: WorkspaceStateProducer | null,
  workspaceId: string,
  nextState: WorkspaceState,
  mode: 'snapshot' | 'delta',
): NextWorkspaceStateEventResult {
  if (mode === 'snapshot' || !producer) {
    const fresh = createWorkspaceStateProducer(workspaceId, nextState);
    return { producer: fresh, event: fresh.snapshot() };
  }
  return { producer, event: producer.update(nextState) };
}
