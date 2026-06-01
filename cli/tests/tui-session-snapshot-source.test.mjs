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

describe('TUI session snapshot source guards', () => {
  it('advertises and requests session_snapshot_v1 after daemon attach', async () => {
    const src = await readTuiSource();
    assert.match(
      src,
      /TUI_DAEMON_CAPABILITIES = Object\.freeze\(\['event_v2', 'session_snapshot_v1'\]\)/,
      'the TUI should advertise snapshot support in daemon hello/session verbs',
    );
    assert.match(
      src,
      /daemonClient\.request\(\s*'get_session_snapshot'/,
      'the TUI should request a daemon session snapshot',
    );
    assert.match(
      src,
      /hydrateDaemonSnapshot\(res\.payload\)/,
      'the TUI should hydrate local UI state from the snapshot response',
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
