import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPECTED_PROTOCOL_VERSION,
  TUI_KNOWN_NOOP_EVENT_TYPES,
  evaluateHelloResponse,
  formatUnknownEventWarning,
  shouldWarnAboutUnknownEvent,
} from '../tui-daemon-handshake.ts';
import { PROTOCOL_VERSION } from '../../lib/protocol-schema.ts';

describe('EXPECTED_PROTOCOL_VERSION', () => {
  it('matches the shared schema constant', () => {
    // Drift guard: the TUI's expected protocol version MUST be the
    // shared schema's PROTOCOL_VERSION, not a literal that can drift.
    // If a refactor turned `EXPECTED_PROTOCOL_VERSION` into a hand-
    // typed string, this test catches the rename.
    assert.equal(EXPECTED_PROTOCOL_VERSION, PROTOCOL_VERSION);
  });
});

describe('evaluateHelloResponse', () => {
  it('accepts a well-formed hello payload with matching protocol', () => {
    const result = evaluateHelloResponse({
      runtimeName: 'pushd',
      runtimeVersion: '0.3.0',
      protocolVersion: PROTOCOL_VERSION,
      capabilities: ['stream_tokens', 'event_v2'],
    });
    assert.equal(result.accepted, true);
    if (result.accepted) {
      assert.equal(result.runtimeVersion, '0.3.0');
      assert.deepEqual(result.capabilities, ['stream_tokens', 'event_v2']);
      assert.deepEqual(result.warnings, []);
    }
  });

  it('rejects a non-object payload', () => {
    const result = evaluateHelloResponse('not-an-object');
    assert.equal(result.accepted, false);
    if (!result.accepted) {
      assert.match(result.reason, /not an object/);
    }
  });

  it('rejects a null payload', () => {
    const result = evaluateHelloResponse(null);
    assert.equal(result.accepted, false);
  });

  it('rejects an array payload (not a plain object)', () => {
    const result = evaluateHelloResponse([]);
    assert.equal(result.accepted, false);
  });

  it('rejects a missing protocolVersion field', () => {
    const result = evaluateHelloResponse({ runtimeVersion: '0.3.0' });
    assert.equal(result.accepted, false);
    if (!result.accepted) {
      assert.match(result.reason, /missing or has an invalid protocolVersion/);
    }
  });

  it('rejects an empty protocolVersion string', () => {
    const result = evaluateHelloResponse({ protocolVersion: '' });
    assert.equal(result.accepted, false);
  });

  it('rejects a non-string protocolVersion', () => {
    const result = evaluateHelloResponse({ protocolVersion: 42 });
    assert.equal(result.accepted, false);
  });

  it('rejects a protocolVersion that does not match the expected', () => {
    const result = evaluateHelloResponse({ protocolVersion: 'push.runtime.v0' });
    assert.equal(result.accepted, false);
    if (!result.accepted) {
      // The reason should name BOTH versions so the user sees what to
      // align — a half-message ("mismatch") is harder to act on.
      assert.match(result.reason, new RegExp(EXPECTED_PROTOCOL_VERSION));
      assert.match(result.reason, /push\.runtime\.v0/);
    }
  });

  it('accepts and warns when runtimeVersion is missing', () => {
    const result = evaluateHelloResponse({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: ['event_v2'],
    });
    assert.equal(result.accepted, true);
    if (result.accepted) {
      assert.equal(result.runtimeVersion, null);
      assert.ok(
        result.warnings.some((w) => /runtimeVersion/.test(w)),
        `expected a runtimeVersion warning, got ${JSON.stringify(result.warnings)}`,
      );
    }
  });

  it('accepts and warns when runtimeVersion is empty', () => {
    const result = evaluateHelloResponse({
      protocolVersion: PROTOCOL_VERSION,
      runtimeVersion: '',
    });
    assert.equal(result.accepted, true);
    if (result.accepted) {
      assert.equal(result.runtimeVersion, null);
      assert.ok(result.warnings.length > 0);
    }
  });

  it('filters non-string capabilities defensively', () => {
    const result = evaluateHelloResponse({
      protocolVersion: PROTOCOL_VERSION,
      runtimeVersion: '0.3.0',
      capabilities: ['stream_tokens', 42, null, 'event_v2', { foo: 'bar' }],
    });
    assert.equal(result.accepted, true);
    if (result.accepted) {
      assert.deepEqual(result.capabilities, ['stream_tokens', 'event_v2']);
    }
  });

  it('tolerates a missing capabilities field', () => {
    const result = evaluateHelloResponse({
      protocolVersion: PROTOCOL_VERSION,
      runtimeVersion: '0.3.0',
    });
    assert.equal(result.accepted, true);
    if (result.accepted) {
      assert.deepEqual(result.capabilities, []);
    }
  });

  it('surfaces a present buildStamp for the freshness check', () => {
    const result = evaluateHelloResponse({
      protocolVersion: PROTOCOL_VERSION,
      runtimeVersion: '0.3.0',
      buildStamp: '0.3.0+abc123def456',
      capabilities: ['event_v2'],
    });
    assert.equal(result.accepted, true);
    if (result.accepted) {
      assert.equal(result.buildStamp, '0.3.0+abc123def456');
    }
  });

  it('returns buildStamp null (no extra warning) when the daemon omits it', () => {
    // An older daemon that doesn't advertise a buildStamp can't participate in
    // freshness self-heal. That is NOT a warnable condition on its own — the
    // runtimeVersion warning already covers "older binary" — so buildStamp
    // absence must add no warning of its own.
    const result = evaluateHelloResponse({
      protocolVersion: PROTOCOL_VERSION,
      runtimeVersion: '0.3.0',
      buildStamp: 42,
      capabilities: ['event_v2'],
    });
    assert.equal(result.accepted, true);
    if (result.accepted) {
      assert.equal(result.buildStamp, null);
      assert.deepEqual(result.warnings, []);
    }
  });

  it('treats an empty-string buildStamp as absent', () => {
    const result = evaluateHelloResponse({
      protocolVersion: PROTOCOL_VERSION,
      runtimeVersion: '0.3.0',
      buildStamp: '',
    });
    assert.equal(result.accepted, true);
    if (result.accepted) {
      assert.equal(result.buildStamp, null);
    }
  });
});

describe('shouldWarnAboutUnknownEvent', () => {
  it('returns true the first time a type is seen and false thereafter', () => {
    const registry = new Set();
    assert.equal(shouldWarnAboutUnknownEvent(registry, 'something.new'), true);
    assert.equal(shouldWarnAboutUnknownEvent(registry, 'something.new'), false);
    assert.equal(shouldWarnAboutUnknownEvent(registry, 'something.new'), false);
  });

  it('short-circuits to false for known-noop event types', () => {
    const registry = new Set();
    for (const noopType of TUI_KNOWN_NOOP_EVENT_TYPES) {
      assert.equal(
        shouldWarnAboutUnknownEvent(registry, noopType),
        false,
        `expected ${noopType} to be silent`,
      );
      // And the registry should NOT have been polluted by the short-
      // circuit — calling again with the same type still returns false
      // without touching the set.
      assert.equal(registry.has(noopType), false);
    }
  });

  it('includes the engine round-lifecycle events that fire on every prompt', () => {
    // Regression guard for the PR #665 review finding: the engine
    // emits `assistant.turn_start` / `assistant.turn_end` on every
    // assistant turn from both inline mode and the daemon. Missing
    // any of these from the allowlist floods the transcript with
    // "unknown event" warnings the moment the user sends a message.
    assert.ok(TUI_KNOWN_NOOP_EVENT_TYPES.has('assistant.turn_start'));
    assert.ok(TUI_KNOWN_NOOP_EVENT_TYPES.has('assistant.turn_end'));
    assert.ok(TUI_KNOWN_NOOP_EVENT_TYPES.has('harness.adaptation'));
  });

  it('includes the shared-runtime job + follow-up events', () => {
    // RunEventInput declares these in `lib/runtime-contract.ts`; the
    // TUI doesn't render them so they need to be on the allowlist
    // or strict mode would surface a warning on every delegated run.
    assert.ok(TUI_KNOWN_NOOP_EVENT_TYPES.has('job.started'));
    assert.ok(TUI_KNOWN_NOOP_EVENT_TYPES.has('job.completed'));
    assert.ok(TUI_KNOWN_NOOP_EVENT_TYPES.has('job.failed'));
    assert.ok(TUI_KNOWN_NOOP_EVENT_TYPES.has('user.follow_up_queued'));
    assert.ok(TUI_KNOWN_NOOP_EVENT_TYPES.has('user.follow_up_steered'));
  });

  it('rejects non-string types defensively', () => {
    const registry = new Set();
    assert.equal(shouldWarnAboutUnknownEvent(registry, ''), false);
    assert.equal(shouldWarnAboutUnknownEvent(registry, null), false);
    assert.equal(shouldWarnAboutUnknownEvent(registry, undefined), false);
    assert.equal(shouldWarnAboutUnknownEvent(registry, 42), false);
  });

  it('tracks distinct types independently', () => {
    const registry = new Set();
    assert.equal(shouldWarnAboutUnknownEvent(registry, 'type.a'), true);
    assert.equal(shouldWarnAboutUnknownEvent(registry, 'type.b'), true);
    assert.equal(shouldWarnAboutUnknownEvent(registry, 'type.a'), false);
    assert.equal(shouldWarnAboutUnknownEvent(registry, 'type.b'), false);
  });

  it('respects a fresh registry as a reconnect reset', () => {
    // The TUI's reconnect path clears the registry so a daemon upgrade
    // resurfaces drift on the new link. Simulate that by re-creating
    // the Set between observations.
    let registry = new Set();
    assert.equal(shouldWarnAboutUnknownEvent(registry, 'type.x'), true);
    assert.equal(shouldWarnAboutUnknownEvent(registry, 'type.x'), false);
    registry = new Set(); // reconnect
    assert.equal(shouldWarnAboutUnknownEvent(registry, 'type.x'), true);
  });
});

describe('formatUnknownEventWarning', () => {
  it('includes the event type verbatim in the warning text', () => {
    const text = formatUnknownEventWarning('weird.new.type');
    assert.match(text, /"weird\.new\.type"/);
    // Wording stays mode-neutral — `handleEngineEvent` fires from
    // both daemon and inline flows, so the warning must not claim
    // the daemon emitted it (PR #665 review).
    assert.doesNotMatch(text, /^Daemon /);
    assert.match(text, /Engine emitted/);
    assert.match(text, /rebuilding|mixed binaries/);
  });
});
