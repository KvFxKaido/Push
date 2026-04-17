import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeResponse, makeErrorResponse, normalizeProviderInput } from '../pushd.ts';

// ─── makeResponse ───────────────────────────────────────────────

describe('makeResponse', () => {
  it('builds correct envelope shape', () => {
    const res = makeResponse('req_1', 'hello', 'sess_1', true, { foo: 1 });
    assert.equal(res.v, 'push.runtime.v1');
    assert.equal(res.kind, 'response');
    assert.equal(res.requestId, 'req_1');
    assert.equal(res.type, 'hello');
    assert.equal(res.sessionId, 'sess_1');
    assert.equal(res.ok, true);
    assert.deepEqual(res.payload, { foo: 1 });
    assert.equal(res.error, null);
  });

  it('defaults error to null when omitted', () => {
    const res = makeResponse('req_2', 'run', 'sess_2', true, {});
    assert.equal(res.error, null);
  });

  it('includes error when provided', () => {
    const err = { code: 'BOOM', message: 'bad' };
    const res = makeResponse('req_3', 'run', null, false, {}, err);
    assert.deepEqual(res.error, err);
    assert.equal(res.ok, false);
  });

  it('normalizes falsy sessionId to null', () => {
    assert.equal(makeResponse('r', 't', '', true, {}).sessionId, null);
    assert.equal(makeResponse('r', 't', undefined, true, {}).sessionId, null);
    assert.equal(makeResponse('r', 't', 0, true, {}).sessionId, null);
    assert.equal(makeResponse('r', 't', null, true, {}).sessionId, null);
  });

  it('preserves truthy sessionId', () => {
    assert.equal(makeResponse('r', 't', 'sess_abc', true, {}).sessionId, 'sess_abc');
  });
});

// ─── makeErrorResponse ──────────────────────────────────────────

describe('makeErrorResponse', () => {
  it('builds an error response with ok=false', () => {
    const res = makeErrorResponse('req_e1', 'run', 'NOT_FOUND', 'Session not found');
    assert.equal(res.ok, false);
    assert.equal(res.sessionId, null);
    assert.deepEqual(res.payload, {});
    assert.deepEqual(res.error, {
      code: 'NOT_FOUND',
      message: 'Session not found',
      retryable: false,
    });
  });

  it('defaults retryable to false', () => {
    const res = makeErrorResponse('req_e2', 'run', 'ERR', 'fail');
    assert.equal(res.error.retryable, false);
  });

  it('passes retryable=true when specified', () => {
    const res = makeErrorResponse('req_e3', 'run', 'TIMEOUT', 'timed out', true);
    assert.equal(res.error.retryable, true);
  });

  it('preserves envelope fields from makeResponse', () => {
    const res = makeErrorResponse('req_e4', 'hello', 'BAD', 'nope');
    assert.equal(res.v, 'push.runtime.v1');
    assert.equal(res.kind, 'response');
    assert.equal(res.requestId, 'req_e4');
    assert.equal(res.type, 'hello');
  });
});

// ─── normalizeProviderInput ─────────────────────────────────────

describe('normalizeProviderInput', () => {
  it('trims whitespace and lowercases', () => {
    assert.equal(normalizeProviderInput('  OpenAI  '), 'openai');
    assert.equal(normalizeProviderInput('Anthropic'), 'anthropic');
  });

  it('rejects non-string types', () => {
    assert.equal(normalizeProviderInput(42), '');
    assert.equal(normalizeProviderInput(null), '');
    assert.equal(normalizeProviderInput(undefined), '');
    assert.equal(normalizeProviderInput(true), '');
    assert.equal(normalizeProviderInput({}), '');
  });

  it('rejects sentinel strings "undefined" and "null"', () => {
    assert.equal(normalizeProviderInput('undefined'), '');
    assert.equal(normalizeProviderInput('null'), '');
    assert.equal(normalizeProviderInput('  UNDEFINED  '), '');
    assert.equal(normalizeProviderInput('  Null  '), '');
  });

  it('rejects empty and whitespace-only strings', () => {
    assert.equal(normalizeProviderInput(''), '');
    assert.equal(normalizeProviderInput('   '), '');
  });

  it('passes through valid provider names', () => {
    assert.equal(normalizeProviderInput('zen'), 'zen');
    assert.equal(normalizeProviderInput('ollama'), 'ollama');
    assert.equal(normalizeProviderInput('openrouter'), 'openrouter');
  });
});
