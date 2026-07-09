/**
 * tui-session-snapshot-source.test.mjs — source guards for the TUI side of
 * Remote Session Status Packet consumption.
 *
 * The TUI run loop is still mostly closure-local, so these pin the reconnect
 * wiring until the daemon client path has a smaller harness.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const readTuiSource = () => fs.readFile(path.join(import.meta.dirname, '..', 'tui.ts'), 'utf8');
const readControllerSource = () =>
  fs.readFile(path.join(import.meta.dirname, '..', 'tui-daemon-session.ts'), 'utf8');

describe('TUI session snapshot source guards', () => {
  it('advertises and requests session_snapshot_v1 after daemon attach', async () => {
    const src = await readTuiSource();
    // The capability profile is the canonical, drift-tested definition in
    // lib/daemon-capabilities.ts (#745); the TUI imports it rather than
    // redefining the literal. Its contents (incl. session_snapshot_v1) are
    // pinned by the daemon-capabilities drift test in daemon-integration.
    assert.match(
      src,
      /import \{ TUI_DAEMON_CAPABILITIES \} from '\.\.\/lib\/daemon-capabilities\.js'/,
      'the TUI should advertise the canonical snapshot capability profile',
    );
    assert.match(
      src,
      /capabilities: \[\.\.\.TUI_DAEMON_CAPABILITIES\]/,
      'the TUI should send its capability profile in the daemon handshake/attach',
    );
    assert.match(
      src,
      /daemon\.client\.request\(\s*'get_session_snapshot'/,
      'the TUI should request a daemon session snapshot',
    );
    assert.match(
      src,
      /hydrateDaemonSnapshot\(res\.payload\)/,
      'the TUI should hydrate local UI state from the snapshot response',
    );
  });

  it('consumes workspace-state events ambiently instead of as transcript entries', async () => {
    const src = await readTuiSource();
    assert.match(
      src,
      /import \{ reduceWorkspaceStateEvent \} from '\.\.\/lib\/workspace-state\.js'/,
      'the TUI should reuse the shared workspace-state reducer',
    );
    assert.match(
      src,
      /case 'workspace\.state_snapshot':\s*case 'workspace\.state_delta':/,
      'the TUI should handle both workspace-state event types',
    );
    assert.match(
      src,
      /workspaceStateView: tuiState\.workspaceStateView/,
      'the reduced workspace view should render through the status bar',
    );
    assert.doesNotMatch(
      src,
      /addTranscriptEntry\(tuiState,\s*['"](?:status|warning|assistant)['"],\s*[^)]*workspace\.state_/,
      'workspace-state updates should not be appended to the transcript',
    );
  });

  it('clears daemon workspace state on disconnect and leaves header branch to the git poll', async () => {
    const src = await readTuiSource();
    // The socket-close wiring split with the DaemonSessionController
    // extraction (Phase 1): the controller clears its client/session state
    // and calls the TUI's `onSocketClose` hook, which owns the disconnect UI
    // — pin both halves so neither can silently drop its side.
    const controllerSrc = await readControllerSource();
    assert.match(
      controllerSrc,
      /client\._socket\.on\('close', \(\) => \{[\s\S]*this\.#hooks\.onSocketClose\(\);/,
      'the controller close path must hand off to the TUI socket-close hook',
    );
    assert.match(
      src,
      /onSocketClose: \(\) => \{[\s\S]*tuiState\.workspaceStateView = null;[\s\S]*tuiState\.dirty\.add\('footer'\);/,
      'the daemon close path should clear stale workspace-state guards from the footer',
    );
    assert.match(
      src,
      /const nextBranch = status\.branch \|\| '';[\s\S]*if \(nextBranch !== branch\) \{[\s\S]*branch = nextBranch;[\s\S]*tuiState\.dirty\.add\('header'\);/,
      'the local git poll should be the source of truth for the header branch',
    );
    assert.match(
      src,
      /const status = await getCompactGitStatus\(state\.cwd\);[\s\S]*if \(!status\) return;/,
      'a transient null git poll must not blank the header branch (keep last-known)',
    );
    assert.doesNotMatch(
      src,
      /branch = result\.view\.state\.activeBranch/,
      'workspace-state adoption must not overwrite the header branch',
    );
  });

  it('does not let live-only workspace-state events advance the replay cursor', async () => {
    const src = await readTuiSource();
    assert.match(
      src,
      /const isWorkspaceStateEvent =\s*event\.type === 'workspace\.state_snapshot' \|\| event\.type === 'workspace\.state_delta'/,
      'workspace-state event detection should be explicit at the replay cursor boundary',
    );
    // The cursor itself lives on the DaemonSessionController; the TUI gates
    // which events reach it, the controller enforces monotonicity.
    assert.match(
      src,
      /if \(!isWorkspaceStateEvent && typeof event\.seq === 'number'\) \{\s*daemon\.noteSeenSeq\(event\.seq\);/,
      'live-only workspace-state seqs must not become durable replay checkpoints',
    );
    const controllerSrc = await readControllerSource();
    assert.match(
      controllerSrc,
      /noteSeenSeq\(seq: number\): void \{\s*if \(seq > this\.#lastSeenSeq\) this\.#lastSeenSeq = seq;/,
      'the replay cursor must only advance monotonically',
    );
  });

  it('reattaches from persisted session identity after socket reconnect', async () => {
    const src = await readTuiSource();
    assert.match(
      src,
      /if \(sessionPersisted && state\?\.sessionId\)/,
      'reconnect must use persisted session identity because the close handler clears daemonSessionId',
    );
    assert.match(
      src,
      /const previousSessionId = state\.sessionId;/,
      'reconnect warnings should name the durable session id that failed to reattach',
    );
  });

  it('recovers pending approval state when replay did not already open the pane', async () => {
    const src = await readTuiSource();
    assert.match(
      src,
      /installDaemonApprovalFromSnapshot\(payload\.pendingApproval, snapshotSessionId\)/,
      'snapshot hydration should apply daemon pending-approval state',
    );
    assert.match(
      src,
      /daemonApprovalId: approvalId/,
      'snapshot-created approval panes must stay identifiable as daemon approvals',
    );
    // #746: the snapshot pane consumes the approval display context (kind /
    // summary / title) the daemon now sends, instead of a hardcoded generic.
    assert.match(
      src,
      /pendingApproval\.summary/,
      'snapshot approval pane should use the daemon-provided summary (#746)',
    );
    assert.match(
      src,
      /pendingApproval\.kind/,
      'snapshot approval pane should use the daemon-provided kind (#746)',
    );
    assert.match(
      src,
      /'submit_approval'/,
      'snapshot-created approval panes must submit decisions back to the daemon',
    );
  });

  it('can cancel a snapshot-hydrated daemon run via Ctrl+C (Codex #744)', async () => {
    const src = await readTuiSource();
    // The snapshot path tracks the daemon-owned run id...
    assert.match(
      src,
      /daemonActiveRunId/,
      'the TUI should track the daemon-owned run id learned from the snapshot',
    );
    // ...and Ctrl+C cancels it over the socket when there is no local runAbort,
    // instead of no-opping (cancelRun) or being a dead key.
    assert.match(
      src,
      /function cancelDaemonRun\(\)/,
      'the TUI should have a daemon-run cancel path for reattached runs',
    );
    assert.match(
      src,
      /if \(runAbort\) \{\s*cancelRun\(\);\s*\} else if \(!cancelDaemonRun\(\)\) \{\s*exitResolve\(\);/,
      'cancel_or_exit must fall back to daemon cancel, then exit, so Ctrl+C is never dead',
    );
  });

  it('surfaces snapshot refresh failures to the user on attach/reconnect (Kilo #744)', async () => {
    const src = await readTuiSource();
    assert.match(
      src,
      /reason === 'attach' \|\| reason === 'reconnect'/,
      'snapshot failures on user-visible moments should be surfaced, not only logged to stderr',
    );
    assert.match(
      src,
      /Could not refresh session status from the daemon/,
      'a failed snapshot refresh should add a user-visible warning entry',
    );
  });

  it('does not block the attach path on the snapshot RPC (Kilo #744)', async () => {
    const src = await readTuiSource();
    assert.match(
      src,
      /void refreshDaemonSessionSnapshot\('attach'\)/,
      'the attach path should fire the snapshot refresh without awaiting its 1500ms window',
    );
  });
});
