import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { TRANSCRIPT_MUTATION_EVENT_TYPES } from '../../lib/session-transcript-events.ts';
import {
  formatCitationsRow,
  formatEmptyRunWarning,
  isVisibleEmission,
  shouldWarnAboutUnknownSilveryEvent,
  SILVERY_DAEMON_HANDLED_EVENT_TYPES,
  SILVERY_INLINE_HANDLED_EVENT_TYPES,
  VISIBLE_EMISSION_TYPES,
} from '../silvery/event-diagnostics.ts';

describe('formatCitationsRow', () => {
  it('renders title — url per source under a counted header', () => {
    const out = formatCitationsRow({
      citations: [
        { url: 'https://a.dev', title: 'Alpha' },
        { url: 'https://b.dev', title: 'Beta' },
      ],
    });
    assert.equal(out, 'Sources (2)\n  • Alpha — https://a.dev/\n  • Beta — https://b.dev/');
  });

  it('falls back to the url alone when the title is missing or duplicates it', () => {
    assert.equal(
      formatCitationsRow({ citations: [{ url: 'https://x.dev' }] }),
      'Sources (1)\n  • https://x.dev/',
    );
    assert.equal(
      formatCitationsRow({ citations: [{ url: 'https://x.dev', title: 'https://x.dev' }] }),
      'Sources (1)\n  • https://x.dev/',
    );
  });

  it('caps the list and reports the overflow (no flood on a big search)', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      url: `https://s${i}.dev`,
      title: `S${i}`,
    }));
    const out = formatCitationsRow({ citations: many });
    assert.match(out, /^Sources \(12\)/);
    assert.equal(out.split('\n').filter((l) => l.startsWith('  • ')).length, 8);
    assert.match(out, /… \+4 more$/);
  });

  it('returns null for nothing to show — empty, malformed, or urlless', () => {
    assert.equal(formatCitationsRow({ citations: [] }), null);
    assert.equal(formatCitationsRow({ citations: [{ title: 'no url' }] }), null);
    assert.equal(formatCitationsRow({}), null);
    assert.equal(formatCitationsRow(null), null);
    assert.equal(formatCitationsRow('nope'), null);
  });

  it('strips a url that is only whitespace', () => {
    assert.equal(formatCitationsRow({ citations: [{ url: '   ' }] }), null);
  });

  it('filters unsafe schemes and strips terminal controls from displayed sources', () => {
    const out = formatCitationsRow({
      citations: [
        { url: 'javascript:alert(1)', title: 'script' },
        { url: 'data:text/plain,spoof', title: 'data' },
        {
          url: 'https://safe.dev/\u001b[31m',
          title: 'Safe\u001b[2J\u202e title',
        },
      ],
    });

    assert.match(out, /^Sources \(1\)/);
    assert.match(out, /https:\/\/safe\.dev\/%1B\[31m/);
    assert.ok(!out.includes('javascript:'));
    assert.ok(!out.includes('data:text'));
    assert.ok(!out.includes('\u001b'));
    assert.ok(!out.includes('\u202e'));
  });
});

describe('isVisibleEmission', () => {
  it('counts content and tool/status events as visible', () => {
    for (const t of [
      'assistant_token',
      'assistant_thinking_token',
      'tool_call',
      'tool.execution_complete',
      'status',
      'assistant_citations',
    ]) {
      assert.equal(isVisibleEmission(t), true, t);
    }
  });

  it('does NOT count lifecycle markers as visible (they are not output)', () => {
    for (const t of [
      'assistant_done',
      'run_complete',
      'user_message',
      'session_started',
      'assistant.turn_start',
    ]) {
      assert.equal(isVisibleEmission(t), false, t);
    }
  });

  it('exposes a frozen-ish positive list (empty-run rests on this, not a denylist)', () => {
    assert.ok(VISIBLE_EMISSION_TYPES.has('assistant_token'));
    assert.ok(!VISIBLE_EMISSION_TYPES.has('run_complete'));
  });
});

describe('silvery unknown-event drift registry', () => {
  const caseTypesBetween = (source, startMarker, endMarker) => {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0 && end > start, `missing source markers: ${startMarker} → ${endMarker}`);
    return [...source.slice(start, end).matchAll(/case '([^']+)'/g)].map((match) => match[1]);
  };

  it('stays exactly synchronized with both event switch statements', () => {
    const controllerSource = readFileSync(
      new URL('../silvery/controller.ts', import.meta.url),
      'utf8',
    );
    const mirrorSource = readFileSync(
      new URL('../daemon-transcript-mirror.ts', import.meta.url),
      'utf8',
    );
    const inlineCases = caseTypesBetween(
      controllerSource,
      'const onEvent = (event: EngineEvent)',
      'const onDaemonEvent =',
    );
    const daemonCases = caseTypesBetween(
      mirrorSource,
      'export function applyDaemonTranscriptEvent(',
      'export function rebuildDaemonTranscriptMirror(',
    );
    const sorted = (values) => [...new Set(values)].sort();

    // Citations are rendered by the inline diagnostic observer immediately
    // before the switch; daemon-only approvals and transcript mutations are
    // handled immediately after the mirror reducer.
    assert.deepEqual(
      sorted(SILVERY_INLINE_HANDLED_EVENT_TYPES),
      sorted([...inlineCases, 'assistant_citations']),
    );
    assert.deepEqual(
      sorted(SILVERY_DAEMON_HANDLED_EVENT_TYPES),
      sorted([
        ...daemonCases,
        'approval_required',
        'approval_received',
        ...TRANSCRIPT_MUTATION_EVENT_TYPES,
      ]),
    );
  });

  it('warns once per type and respects lane-specific handling', () => {
    const inline = new Set();
    assert.equal(shouldWarnAboutUnknownSilveryEvent(inline, 'future.event', 'inline'), true);
    assert.equal(shouldWarnAboutUnknownSilveryEvent(inline, 'future.event', 'inline'), false);
    assert.equal(shouldWarnAboutUnknownSilveryEvent(inline, 'assistant_token', 'inline'), false);

    // Delegation rows exist in the daemon mirror, not the inline switch. If
    // they ever arrive inline, surfacing drift is more honest than silence.
    assert.equal(shouldWarnAboutUnknownSilveryEvent(inline, 'subagent.started', 'inline'), true);
    assert.equal(
      shouldWarnAboutUnknownSilveryEvent(new Set(), 'subagent.started', 'daemon'),
      false,
    );
  });
});

describe('formatEmptyRunWarning', () => {
  it('names the symptom and points at the decision doc', () => {
    const out = formatEmptyRunWarning();
    assert.match(out, /empty/i);
    assert.match(out, /Tool-Call Parser Convergence Gap/);
  });
});
