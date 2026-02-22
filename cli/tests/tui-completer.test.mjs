import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTabCompleter } from '../tui-completer.mjs';

// ── Fixtures ──────────────────────────────────────────────────────

function makeDeps(providerId = 'ollama') {
  const ctx = { providerConfig: { id: providerId } };

  const skills = new Map();
  skills.set('commit', { description: 'commit changes' });
  skills.set('review', { description: 'review code' });

  const getCuratedModels = (id) => {
    if (id === 'ollama') return ['gemini-3-flash-preview', 'qwen3', 'llama4', 'devstral'];
    if (id === 'mistral') return ['devstral-small-latest', 'mistral-large-latest'];
    return [];
  };

  const getProviderList = () => [
    { id: 'ollama' }, { id: 'mistral' }, { id: 'openrouter' },
    { id: 'zai' }, { id: 'google' }, { id: 'zen' },
  ];

  return { ctx, skills, getCuratedModels, getProviderList };
}

// ── Tab (cycling) ─────────────────────────────────────────────────

describe('createTabCompleter', () => {
  let tc;
  let deps;

  beforeEach(() => {
    deps = makeDeps();
    tc = createTabCompleter(deps);
  });

  it('returns null for non-slash text', () => {
    assert.equal(tc.tab('hello', false), null);
  });

  it('completes command names', () => {
    const result = tc.tab('/mo', false);
    assert.notEqual(result, null);
    assert.equal(result.text, '/model ');
    assert.equal(result.total, 1);
  });

  it('completes /new command', () => {
    const result = tc.tab('/ne', false);
    assert.notEqual(result, null);
    assert.equal(result.text, '/new ');
  });

  it('completes skill names', () => {
    tc.reset();
    const result = tc.tab('/comm', false);
    assert.notEqual(result, null);
    assert.equal(result.text, '/commit ');
  });

  it('completes model arguments', () => {
    const result = tc.tab('/model gem', false);
    assert.notEqual(result, null);
    assert.equal(result.text, '/model gemini-3-flash-preview');
  });

  it('completes provider arguments', () => {
    const result = tc.tab('/provider ol', false);
    assert.notEqual(result, null);
    assert.equal(result.text, '/provider ollama');
  });

  it('completes session subcommands', () => {
    const result = tc.tab('/session re', false);
    assert.notEqual(result, null);
    assert.equal(result.text, '/session rename ');
  });

  it('cycles forward through candidates', () => {
    const r1 = tc.tab('/provider ', false);
    assert.notEqual(r1, null);
    assert.equal(r1.text, '/provider ollama');
    assert.equal(r1.index, 0);

    const r2 = tc.tab('/provider ', false);
    assert.equal(r2.text, '/provider mistral');
    assert.equal(r2.index, 1);
  });

  it('cycles backward with Shift+Tab', () => {
    tc.tab('/provider ', false);
    const r = tc.tab('/provider ', true);
    assert.equal(r.text, '/provider zen');
    assert.equal(r.index, 5);
  });

  it('wraps around forward', () => {
    const providers = deps.getProviderList();
    for (let i = 0; i < providers.length; i++) {
      tc.tab('/provider ', false);
    }
    const r = tc.tab('/provider ', false);
    assert.equal(r.text, '/provider ollama');
    assert.equal(r.index, 0);
  });

  it('Shift+Tab on first press picks last candidate', () => {
    const r = tc.tab('/provider ', true);
    assert.notEqual(r, null);
    assert.equal(r.text, '/provider zen');
  });

  it('reset clears state, next Tab re-resolves', () => {
    tc.tab('/provider ', false);
    tc.reset();
    assert.equal(tc.isActive(), false);
    assert.equal(tc.getHint(), null);

    const r = tc.tab('/provider ', false);
    assert.equal(r.index, 0);
    assert.equal(r.text, '/provider ollama');
  });

  it('isActive reflects state', () => {
    assert.equal(tc.isActive(), false);
    tc.tab('/mo', false);
    assert.equal(tc.isActive(), true);
    tc.reset();
    assert.equal(tc.isActive(), false);
  });

  it('getHint returns 1-based index when cycling', () => {
    tc.tab('/provider ', false);
    assert.equal(tc.getHint(), 'Tab 1/6');
    tc.tab('/provider ', false);
    assert.equal(tc.getHint(), 'Tab 2/6');
  });

  it('getHint returns null in preview mode', () => {
    tc.suggest('/provider ');
    assert.equal(tc.getHint(), null);
  });

  it('returns null when no matches', () => {
    const r = tc.tab('/zzzzz', false);
    assert.equal(r, null);
    assert.equal(tc.isActive(), false);
  });

  it('command completion adds trailing space', () => {
    const r = tc.tab('/hel', false);
    assert.notEqual(r, null);
    assert.equal(r.text, '/help ');
  });

  it('multiple commands match and cycle', () => {
    const r1 = tc.tab('/ex', false);
    assert.notEqual(r1, null);
    assert.equal(r1.text, '/exit ');
  });
});

// ── Suggest (live preview) ────────────────────────────────────────

describe('suggest (live preview)', () => {
  let tc;

  beforeEach(() => {
    tc = createTabCompleter(makeDeps());
  });

  it('populates candidates as user types', () => {
    tc.suggest('/mo');
    assert.equal(tc.isActive(), true);
    const s = tc.getState();
    assert.notEqual(s, null);
    assert.equal(s.items[0], '/model');
    assert.equal(s.index, -1); // preview, no selection
  });

  it('clears candidates when text has no matches', () => {
    tc.suggest('/mo');
    assert.equal(tc.isActive(), true);
    tc.reset();
    tc.suggest('/zzz');
    assert.equal(tc.isActive(), false);
  });

  it('does not activate for non-slash text', () => {
    tc.suggest('hello');
    assert.equal(tc.isActive(), false);
    assert.equal(tc.getState(), null);
  });

  it('does not override cycling state', () => {
    tc.tab('/provider ', false); // enter cycling, index=0
    tc.suggest('/provider ol');   // should be ignored (cycling)
    const s = tc.getState();
    assert.equal(s.index, 0);    // still at cycling index 0
    assert.equal(s.items.length, 6); // original 6 candidates, not narrowed
  });

  it('Tab uses pre-suggested candidates', () => {
    tc.suggest('/provider ');
    assert.equal(tc.isActive(), true);
    assert.equal(tc.getState().index, -1); // preview

    const r = tc.tab('/provider ', false);
    assert.equal(r.text, '/provider ollama');
    assert.equal(r.index, 0); // now cycling
    assert.equal(tc.getHint(), 'Tab 1/6');
  });

  it('narrowing: suggest updates candidates after reset', () => {
    tc.suggest('/provider ');
    assert.equal(tc.getState().items.length, 6);

    tc.reset();
    tc.suggest('/provider ol');
    const s = tc.getState();
    assert.equal(s.items.length, 1);
    assert.equal(s.items[0], 'ollama');
  });

  it('suggest shows model args', () => {
    tc.suggest('/model q');
    const s = tc.getState();
    assert.notEqual(s, null);
    assert.equal(s.items[0], 'qwen3');
    assert.equal(s.index, -1);
  });
});

// ── /config completion ────────────────────────────────────────────

describe('/config completion', () => {
  let tc;

  beforeEach(() => {
    tc = createTabCompleter(makeDeps());
  });

  it('completes subcommands from /config ', () => {
    const r = tc.tab('/config ', false);
    assert.notEqual(r, null);
    assert.equal(r.text, '/config key ');
    assert.equal(r.total, 4);
  });

  it('narrows subcommands: /config k → /config key ', () => {
    const r = tc.tab('/config k', false);
    assert.notEqual(r, null);
    assert.equal(r.text, '/config key ');
    assert.equal(r.total, 1);
  });

  it('completes provider names for /config key ', () => {
    const r = tc.tab('/config key ol', false);
    assert.notEqual(r, null);
    assert.equal(r.text, '/config key ollama ');
    assert.equal(r.total, 1);
  });

  it('completes all providers for /config key ', () => {
    const r = tc.tab('/config key ', false);
    assert.notEqual(r, null);
    assert.equal(r.text, '/config key ollama ');
    assert.equal(r.total, 6);
  });

  it('completes sandbox on/off', () => {
    const r1 = tc.tab('/config sandbox o', false);
    assert.notEqual(r1, null);
    assert.equal(r1.text, '/config sandbox on');
    assert.equal(r1.total, 2);

    const r2 = tc.tab('/config sandbox o', false);
    assert.equal(r2.text, '/config sandbox off');
  });

  it('completes /config sandbox off from /config sandbox of', () => {
    const r = tc.tab('/config sandbox of', false);
    assert.notEqual(r, null);
    assert.equal(r.text, '/config sandbox off');
    assert.equal(r.total, 1);
  });

  it('returns null for unknown subcommand args', () => {
    const r = tc.tab('/config url something', false);
    assert.equal(r, null);
  });

  it('/config appears in command completion', () => {
    const r = tc.tab('/con', false);
    assert.notEqual(r, null);
    assert.equal(r.text, '/config ');
  });
});

// ── getState display labels ───────────────────────────────────────

describe('getState display labels', () => {
  let tc;

  beforeEach(() => {
    tc = createTabCompleter(makeDeps());
  });

  it('returns null when inactive', () => {
    assert.equal(tc.getState(), null);
  });

  it('returns display labels for commands', () => {
    tc.tab('/hel', false);
    const s = tc.getState();
    assert.notEqual(s, null);
    assert.equal(s.items[0], '/help');
    assert.equal(s.index, 0);
  });

  it('returns arg labels for model completion', () => {
    tc.tab('/model gem', false);
    const s = tc.getState();
    assert.notEqual(s, null);
    assert.equal(s.items[0], 'gemini-3-flash-preview');
    assert.equal(s.index, 0);
  });

  it('returns arg labels for provider completion', () => {
    tc.tab('/provider ', false);
    const s = tc.getState();
    assert.notEqual(s, null);
    assert.deepEqual(s.items, ['ollama', 'mistral', 'openrouter', 'zai', 'google', 'zen']);
    assert.equal(s.index, 0);
  });
});
