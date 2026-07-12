/**
 * tui-session-snapshot-source.test.mjs — source guards for the Silvery TUI
 * side of Remote Session Status Packet consumption.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const readSilveryController = () =>
  fs.readFile(path.join(import.meta.dirname, '..', 'silvery', 'controller.ts'), 'utf8');
const readDaemonSession = () =>
  fs.readFile(path.join(import.meta.dirname, '..', 'tui-daemon-session.ts'), 'utf8');

describe('Silvery session snapshot source guards', () => {
  it('advertises and requests session_snapshot_v1 after daemon attach', async () => {
    const src = await readSilveryController();
    assert.match(
      src,
      /import \{ TUI_DAEMON_CAPABILITIES \} from ['"]\.\.\/\.\.\/lib\/daemon-capabilities\.js['"]/,
      'Silvery should advertise the canonical snapshot capability profile',
    );
    assert.match(
      src,
      /capabilities: \[\.\.\.SILVERY_DAEMON_CAPABILITIES\]|SILVERY_DAEMON_CAPABILITIES = TUI_DAEMON_CAPABILITIES/,
      'Silvery should use the shared TUI capability profile',
    );
    assert.match(
      src,
      /['"]get_session_snapshot['"]/,
      'Silvery should request a daemon session snapshot',
    );
    assert.match(
      src,
      /transcript\?\.mirror|createDaemonTranscriptMirror\(snapshot\)/,
      'Silvery should adopt the daemon transcript mirror from the snapshot',
    );
  });

  it('resyncs the mirror on attach, before send, run complete, and transcript mutations', async () => {
    const src = await readSilveryController();
    assert.match(src, /resyncDaemonTranscript\('attach'\)/);
    assert.match(src, /resyncDaemonTranscript\('before_send'\)/);
    assert.match(src, /resyncDaemonTranscript\('run_complete'\)/);
    assert.match(src, /isTranscriptMutationEvent\(event\.type\)/);
  });

  it('wires durable attach token + socket-close settlement on the daemon controller', async () => {
    const src = await readSilveryController();
    assert.match(
      src,
      /setDurableAttachToken: \(token\) => \{\s*state\.attachToken = token;/,
      'durable attach tokens must land on session state',
    );
    assert.match(
      src,
      /onSocketClose: \(\) => \{[\s\S]*resolveDaemonTurn/,
      'socket close must settle an in-flight daemon turn',
    );
    const controllerSrc = await readDaemonSession();
    assert.match(
      controllerSrc,
      /noteSeenSeq\(seq: number\): void \{\s*if \(seq > this\.#lastSeenSeq\) this\.#lastSeenSeq = seq;/,
      'the replay cursor must only advance monotonically',
    );
  });

  it('recovers pending approval state from the session snapshot', async () => {
    const src = await readSilveryController();
    assert.match(src, /pendingApproval/, 'snapshot path should read pendingApproval');
    assert.match(src, /kind: 'approval'/, 'snapshot path should open an approval interaction');
    assert.match(
      src,
      /['"]submit_approval['"]/,
      'approval decisions must submit back to the daemon',
    );
  });

  it('can cancel a daemon-backed run', async () => {
    const src = await readSilveryController();
    assert.match(src, /daemonRunId/, 'Silvery should track the daemon-owned run id');
    assert.match(src, /['"]cancel_run['"]/, 'cancel should send cancel_run to the daemon');
  });
});
