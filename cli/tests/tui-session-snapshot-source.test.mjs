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
});
