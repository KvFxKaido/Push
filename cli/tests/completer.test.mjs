import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCompleter } from '../completer.mjs';

const OLLAMA_MODELS = ['gemini-3-flash-preview', 'qwen3', 'llama4', 'devstral'];
const PROVIDERS = [{ id: 'ollama' }, { id: 'mistral' }, { id: 'openrouter' }];

function makeCompleter(overrides = {}) {
  const skills = overrides.skills ?? new Map([
    ['commit', { name: 'commit', description: 'Commit changes' }],
    ['review', { name: 'review', description: 'Review code' }],
  ]);
  return createCompleter({
    ctx: overrides.ctx ?? { providerConfig: { id: 'ollama' } },
    skills,
    getCuratedModels: overrides.getCuratedModels ?? ((id) => id === 'ollama' ? OLLAMA_MODELS : []),
    getProviderList: overrides.getProviderList ?? (() => PROVIDERS),
  });
}

describe('createCompleter', () => {
  it('empty line → no completions', () => {
    const c = makeCompleter();
    const [hits, sub] = c('');
    assert.deepEqual(hits, []);
    assert.equal(sub, '');
  });

  it('plain text → no completions', () => {
    const c = makeCompleter();
    const [hits, sub] = c('fix the bug');
    assert.deepEqual(hits, []);
    assert.equal(sub, 'fix the bug');
  });

  it('/ alone → all commands + skills', () => {
    const c = makeCompleter();
    const [hits, sub] = c('/');
    assert.equal(sub, '/');
    // Reserved commands
    assert.ok(hits.includes('/help'));
    assert.ok(hits.includes('/exit'));
    assert.ok(hits.includes('/quit'));
    assert.ok(hits.includes('/session'));
    assert.ok(hits.includes('/model'));
    assert.ok(hits.includes('/provider'));
    assert.ok(hits.includes('/skills'));
    // Skills
    assert.ok(hits.includes('/commit'));
    assert.ok(hits.includes('/review'));
  });

  it('/he → [/help]', () => {
    const c = makeCompleter();
    const [hits, sub] = c('/he');
    assert.deepEqual(hits, ['/help']);
    assert.equal(sub, '/he');
  });

  it('/com → [/commit] (loaded skill)', () => {
    const c = makeCompleter();
    const [hits, sub] = c('/com');
    assert.deepEqual(hits, ['/commit']);
    assert.equal(sub, '/com');
  });

  it('/s → matches session, skills, and no skills starting with s', () => {
    const c = makeCompleter();
    const [hits, sub] = c('/s');
    assert.ok(hits.includes('/session'));
    assert.ok(hits.includes('/skills'));
    assert.equal(sub, '/s');
  });

  it('/model + trailing space → all curated models for active provider', () => {
    const c = makeCompleter();
    const [hits, sub] = c('/model ');
    assert.deepEqual(hits, OLLAMA_MODELS);
    assert.equal(sub, '');
  });

  it('/model + partial → filtered model matches', () => {
    const c = makeCompleter();
    const [hits, sub] = c('/model gem');
    assert.deepEqual(hits, ['gemini-3-flash-preview']);
    assert.equal(sub, 'gem');
  });

  it('/model with no matches → empty', () => {
    const c = makeCompleter();
    const [hits, sub] = c('/model zzz');
    assert.deepEqual(hits, []);
    assert.equal(sub, 'zzz');
  });

  it('/provider + trailing space → all provider IDs', () => {
    const c = makeCompleter();
    const [hits, sub] = c('/provider ');
    assert.deepEqual(hits, ['ollama', 'mistral', 'openrouter']);
    assert.equal(sub, '');
  });

  it('/provider + partial → filtered', () => {
    const c = makeCompleter();
    const [hits, sub] = c('/provider ol');
    assert.deepEqual(hits, ['ollama']);
    assert.equal(sub, 'ol');
  });

  it('unknown /foo with no matching skill → empty', () => {
    const c = makeCompleter();
    const [hits, sub] = c('/foo');
    assert.deepEqual(hits, []);
    assert.equal(sub, '/foo');
  });

  it('skill args → no completions (free text)', () => {
    const c = makeCompleter();
    const [hits, sub] = c('/commit some message');
    assert.deepEqual(hits, []);
    assert.equal(sub, 'some message');
  });

  it('uses active provider for model completions', () => {
    const c = makeCompleter({
      ctx: { providerConfig: { id: 'mistral' } },
      getCuratedModels: (id) => id === 'mistral' ? ['devstral-small-latest', 'mistral-large-latest'] : [],
    });
    const [hits] = c('/model dev');
    assert.deepEqual(hits, ['devstral-small-latest']);
  });

  it('no skills → only reserved commands', () => {
    const c = makeCompleter({ skills: new Map() });
    const [hits] = c('/');
    assert.ok(hits.includes('/help'));
    assert.ok(hits.includes('/model'));
    assert.ok(!hits.includes('/commit'));
  });
});
