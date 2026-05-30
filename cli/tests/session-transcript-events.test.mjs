import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TRANSCRIPT_MUTATION_EVENT_TYPES,
  isTranscriptMutationEvent,
} from '../../lib/session-transcript-events.ts';
import { TUI_KNOWN_NOOP_EVENT_TYPES } from '../tui-daemon-handshake.ts';

// The transcript-mutation set is the single source of truth shared by the TUI
// (cli/tui.ts → resyncDaemonTranscript) and the web relay hook
// (app/src/hooks/useRelayDaemon.ts → hydrateTranscript). These tests pin the
// vocabulary so a new daemon-side transcript verb can't land without both
// surfaces resyncing by construction.
describe('session-transcript-events vocabulary', () => {
  it('covers exactly the three Addressable Session Verb lifecycle events', () => {
    assert.deepEqual([...TRANSCRIPT_MUTATION_EVENT_TYPES].sort(), [
      'context_compacted',
      'session_reverted',
      'session_unreverted',
    ]);
  });

  it('isTranscriptMutationEvent matches the set', () => {
    assert.equal(isTranscriptMutationEvent('session_reverted'), true);
    assert.equal(isTranscriptMutationEvent('session_unreverted'), true);
    assert.equal(isTranscriptMutationEvent('context_compacted'), true);
    assert.equal(isTranscriptMutationEvent('assistant_token'), false);
    assert.equal(isTranscriptMutationEvent('approval_required'), false);
    assert.equal(isTranscriptMutationEvent(''), false);
  });

  // Drift guard: a transcript-mutating event MUST NOT also sit on the TUI's
  // known-noop allowlist — that would mean the TUI silently drops it instead
  // of resyncing. This is exactly the regression the resync work closed: the
  // three used to be no-ops carrying a "re-sync is future work" note.
  it('no transcript-mutation event is on the TUI known-noop allowlist', () => {
    for (const type of TRANSCRIPT_MUTATION_EVENT_TYPES) {
      assert.equal(
        TUI_KNOWN_NOOP_EVENT_TYPES.has(type),
        false,
        `${type} resyncs the transcript; it must not be a silent no-op`,
      );
    }
  });
});
