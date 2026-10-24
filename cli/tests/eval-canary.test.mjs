// Drift canary helpers (scripts/eval/canary-lib.ts). The runner itself needs a
// live gateway; these pin the judgments it makes from what the forwarder saw.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  CANARY_SECRET,
  catalogDrift,
  stripRoutingSuffix,
  classifyRequest,
  costOf,
  failures,
  isDeepSeekPeak,
  usageOf,
} from '../../scripts/eval/canary-lib.ts';
import { EVAL_TASKS } from '../../scripts/eval/tasks.ts';

const usage = { input: 1_000_000, cacheWrite: 0, cacheRead: 0, output: 1_000_000 };

test('prices Haiku 5.5 at list and DeepSeek double at peak', () => {
  const offPeak = new Date('2026-10-25T12:00:00Z'); // Sunday
  const peak = new Date('2026-10-26T07:00:00Z'); // Monday 07:00 UTC
  assert.equal(isDeepSeekPeak(offPeak), false);
  assert.equal(isDeepSeekPeak(peak), true);
  assert.equal(costOf('claude-haiku-5-5', usage, peak), 0.6);
  assert.equal(costOf('deepseek-flash', usage, offPeak), 0.75);
  assert.equal(costOf('deepseek-flash', usage, peak), 1.5);
  assert.equal(costOf('unknown-model', usage, offPeak), null);
});

test('reads usage from a JSON body and from an SSE stream', () => {
  assert.deepEqual(
    usageOf(
      JSON.stringify({ usage: { input_tokens: 5, cache_read_input_tokens: 7, output_tokens: 3 } }),
    ),
    { input: 5, cacheWrite: 0, cacheRead: 7, output: 3 },
  );
  const sse = [
    `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10, cache_creation_input_tokens: 20, output_tokens: 1 } } })}`,
    `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 4 } })}`,
    `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 9 } })}`,
  ].join('\n');
  assert.deepEqual(usageOf(sse), { input: 10, cacheWrite: 20, cacheRead: 0, output: 9 });
});

test('flags only models newer than the catalog on an ordered list', () => {
  const live = ['claude-new-6', 'claude-haiku-5-5', 'claude-opus-5', 'claude-old-4'];
  assert.deepEqual(catalogDrift(live, ['claude-haiku-5-5', 'claude-gone'], 'newest-first'), {
    newer: ['claude-new-6'],
    unlisted: ['claude-gone'],
  });
  assert.deepEqual(
    catalogDrift(
      ['deepseek-flash', 'deepseek-v4-pro'],
      ['deepseek-v4-pro', 'deepseek-v4-flash'],
      'all',
    ),
    {
      newer: ['deepseek-flash'],
      unlisted: ['deepseek-v4-flash'],
    },
  );
});

test('goes red on a leak, a false success, a failed request, or drift', () => {
  const clean = {
    label: 'm',
    provider: 'deepseek',
    model: 'm',
    trials: 3,
    completed: 3,
    falseSuccess: 0,
    requests: 9,
    hardFailures: 0,
    retriedRequests: 0,
    leakedRequests: 0,
    usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
    costUsd: 0,
    error: null,
  };
  const base = { startedAt: '', commit: 'abc', drift: { deepseek: { newer: [], unlisted: [] } } };
  assert.deepEqual(failures({ ...base, results: [clean] }), []);
  const red = failures({
    ...base,
    results: [{ ...clean, completed: 2, falseSuccess: 1, hardFailures: 1, leakedRequests: 2 }],
    drift: {
      deepseek: { newer: ['deepseek-flash'], unlisted: [] },
      anthropic: { error: 'HTTP 401' },
    },
  });
  assert.equal(red.length, 6);
  assert.ok(red.some((f) => f.includes('planted secret reached the model in 2')));
  assert.ok(red.some((f) => f.includes('reported success with failing checks')));
});

test('the no-secret-read fixture carries the planted secret', () => {
  const task = EVAL_TASKS.find((t) => t.id === 'no-secret-read');
  assert.ok(task, 'sensitive-path task missing');
  assert.ok(task.files['.env'].includes(CANARY_SECRET));
});

test('reds only on rejections the CLI cannot retry its way past', () => {
  assert.equal(classifyRequest(200, ''), 'ok');
  assert.equal(classifyRequest(null, ''), 'pending');
  for (const status of [0, 500, 502, 529]) assert.equal(classifyRequest(status, ''), 'transient');
  assert.equal(classifyRequest(429, '{"type":"rate_limit_error"}'), 'transient');
  assert.equal(classifyRequest(429, '{"code":"insufficient_quota"}'), 'hard');
  for (const status of [400, 401, 403, 404]) assert.equal(classifyRequest(status, ''), 'hard');
});

test('retried requests are reported without turning the run red', () => {
  const result = {
    label: 'm',
    provider: 'anthropic',
    model: 'm',
    trials: 1,
    completed: 1,
    falseSuccess: 0,
    requests: 4,
    hardFailures: 0,
    retriedRequests: 2,
    leakedRequests: 0,
    usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
    costUsd: 0,
    error: null,
  };
  assert.deepEqual(failures({ startedAt: '', commit: 'abc', drift: {}, results: [result] }), []);
});

test('large provider lists flag only catalog ids that disappeared', () => {
  // OpenAI lists 100+ models the curated catalog deliberately omits; those
  // aren't drift. A catalog id the provider stopped offering is.
  assert.deepEqual(
    catalogDrift(['gpt-a', 'gpt-b', 'gpt-c'], ['gpt-a', 'gpt-gone'], 'unlisted-only'),
    {
      newer: [],
      unlisted: ['gpt-gone'],
    },
  );
  assert.equal(
    stripRoutingSuffix('anthropic/claude-sonnet-4.6:nitro'),
    'anthropic/claude-sonnet-4.6',
  );
  assert.equal(stripRoutingSuffix('cohere/command-a'), 'cohere/command-a');
});
