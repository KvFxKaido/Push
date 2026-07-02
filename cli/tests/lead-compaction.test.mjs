import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { maybeCompactLeadHistory } from '../lead-compaction.ts';
import { isHandoffBlock } from '../../lib/llm-compaction.ts';
import { createInMemoryVerbatimLog, setDefaultVerbatimLog } from '../../lib/verbatim-log.ts';
import { estimateContextTokens } from '../context-manager.ts';
import { createSessionState } from '../session-store.ts';

// A fake provider config — only `id`, `defaultModel`, and `streamShape` are read.
const providerConfig = { id: 'ollama', defaultModel: 'test-model', streamShape: 'openai-compat' };

// Fake stream factory: replays the given events as a PushStream.
function fakeStreamFactory(events) {
  return () =>
    async function* () {
      for (const e of events) yield e;
    };
}

const summaryEvents = [
  { type: 'text_delta', text: 'Goal: build the thing. ' },
  { type: 'text_delta', text: 'Did A and B. Next: C.' },
  { type: 'done' },
];

// Build an over-budget history: a goal turn, a long middle span, and a tail.
function bigHistory() {
  const msgs = [{ role: 'user', content: 'GOAL: build the thing' }];
  for (let i = 0; i < 60; i++) {
    msgs.push({ role: 'assistant', content: `step ${i} `.repeat(900) });
    msgs.push({ role: 'user', content: `[TOOL_RESULT]\n${'x'.repeat(8000)}\n[/TOOL_RESULT]` });
  }
  msgs.push({ role: 'user', content: 'recent question that must survive verbatim' });
  return msgs;
}

function makeState(messages) {
  return createSessionState({
    provider: 'ollama',
    model: 'test-model',
    cwd: process.cwd(),
    messages,
  });
}

describe('maybeCompactLeadHistory', () => {
  it('collapses the older span into a handoff and persists context_compacted', async () => {
    const state = makeState(bigHistory());
    const beforeCount = state.messages.length;
    const beforeTokens = estimateContextTokens(state.messages);
    const events = [];
    const statuses = [];

    const compacted = await maybeCompactLeadHistory(state, providerConfig, 'key', {
      streamFactory: fakeStreamFactory(summaryEvents),
      onStatus: (phase) => statuses.push(phase),
      persistEvent: (type, payload) => events.push({ type, payload }),
    });

    assert.equal(compacted, true);
    // Status pill fired.
    assert.ok(statuses.includes('Compacting context…'));
    // History shrank and the goal + recent tail survive.
    assert.ok(state.messages.length < beforeCount);
    assert.equal(state.messages[0].content, 'GOAL: build the thing');
    assert.equal(
      state.messages[state.messages.length - 1].content,
      'recent question that must survive verbatim',
    );
    // A single model-written handoff replaced the span.
    const handoffs = state.messages.filter((m) => isHandoffBlock(m.content));
    assert.equal(handoffs.length, 1);
    assert.match(handoffs[0].content, /Did A and B/);
    // Net tokens dropped, and the event carries the delta.
    assert.ok(estimateContextTokens(state.messages) < beforeTokens);
    const evt = events.find((e) => e.type === 'context_compacted');
    assert.ok(evt);
    assert.equal(evt.payload.mode, 'llm_handoff');
    assert.ok(evt.payload.afterTokens < evt.payload.beforeTokens);
  });

  it('triggers on the eager summarizeTokens, not the patient handoffTokens (bounded-preamble guard)', async () => {
    // The CLI lead feeds a bounded preamble, so the [CONTEXT HANDOFF] is the only
    // carrier of older context and must fire eagerly. On a 1M-window model the
    // patient handoffTokens is ~400k while the eager summarizeTokens is 88k.
    // bigHistory (~245k) sits between them: compaction MUST still fire. A revert
    // to handoffTokens would skip it (245k < 400k) and silently drop every turn
    // beyond the preamble (Codex P1, PR #1194).
    const state = createSessionState({
      provider: 'ollama',
      model: 'deepseek-v4-pro', // 1M window → summarizeTokens 88k, handoffTokens 400k
      cwd: process.cwd(),
      messages: bigHistory(),
    });
    const beforeTokens = estimateContextTokens(state.messages);
    assert.ok(
      beforeTokens > 88_000 && beforeTokens < 400_000,
      `fixture must sit between the eager and patient triggers; got ${beforeTokens}`,
    );
    const compacted = await maybeCompactLeadHistory(state, providerConfig, 'key', {
      streamFactory: fakeStreamFactory(summaryEvents),
      persistEvent: () => {},
    });
    assert.equal(compacted, true);
    assert.equal(state.messages.filter((m) => isHandoffBlock(m.content)).length, 1);
  });

  it('is a no-op when the history is under budget', async () => {
    const state = makeState([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
    const events = [];
    const compacted = await maybeCompactLeadHistory(state, providerConfig, 'key', {
      streamFactory: fakeStreamFactory(summaryEvents),
      persistEvent: (type, payload) => events.push({ type, payload }),
    });
    assert.equal(compacted, false);
    assert.equal(state.messages.length, 2);
    assert.equal(events.length, 0);
  });

  it('fails soft (leaves history untouched) when the summarizer returns empty', async () => {
    const state = makeState(bigHistory());
    const before = [...state.messages];
    const events = [];
    const compacted = await maybeCompactLeadHistory(state, providerConfig, 'key', {
      streamFactory: fakeStreamFactory([{ type: 'done' }]), // empty → failure
      persistEvent: (type, payload) => events.push({ type, payload }),
    });
    assert.equal(compacted, false);
    assert.equal(state.messages.length, before.length);
    assert.equal(events.length, 0);
  });

  it('retains the raw span in the verbatim log and embeds a recall ref in the handoff', async () => {
    // The CLI collapse is destructive — the span is REPLACED in state.messages —
    // so the verbatim entry is the only surviving copy of the original turns.
    const verbatimLog = createInMemoryVerbatimLog();
    setDefaultVerbatimLog(verbatimLog);
    try {
      const state = makeState(bigHistory());
      const compacted = await maybeCompactLeadHistory(state, providerConfig, 'key', {
        streamFactory: fakeStreamFactory(summaryEvents),
        persistEvent: () => {},
        resolveScope: async () => ({ repoFullName: 'owner/repo', branch: 'main' }),
      });
      assert.equal(compacted, true);

      const handoff = state.messages.find((m) => isHandoffBlock(m.content));
      const refMatch = handoff.content.match(/memory_expand refs=\["(vb_[^"]+)"\]/);
      assert.ok(refMatch, 'handoff must carry a recall ref');
      const entry = await verbatimLog.read(refMatch[1]);
      assert.ok(entry, 'ref must resolve in the verbatim log');
      assert.equal(entry.kind, 'compacted_span');
      assert.deepEqual(entry.scope, { repoFullName: 'owner/repo', branch: 'main' });
      // The retained text is the rendered span — it carries the collapsed turns.
      assert.match(entry.text, /### ASSISTANT\nstep 0 /);
    } finally {
      setDefaultVerbatimLog(null); // reset the lazy process default for other suites
    }
  });

  it('omits the recall line (but still compacts) when the workspace has no repo identity', async () => {
    const verbatimLog = createInMemoryVerbatimLog();
    setDefaultVerbatimLog(verbatimLog);
    try {
      const state = makeState(bigHistory());
      const compacted = await maybeCompactLeadHistory(state, providerConfig, 'key', {
        streamFactory: fakeStreamFactory(summaryEvents),
        persistEvent: () => {},
        resolveScope: async () => ({}), // unidentified workspace
      });
      assert.equal(compacted, true);
      const handoff = state.messages.find((m) => isHandoffBlock(m.content));
      assert.ok(handoff);
      assert.ok(!handoff.content.includes('memory_expand'));
      assert.equal(await verbatimLog.size(), 0);
    } finally {
      setDefaultVerbatimLog(null);
    }
  });
});
