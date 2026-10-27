// CLI routing through Cloudflare AI Gateway (Anthropic + DeepSeek). Drives the
// real stream boundary (`createProviderStream`) and key resolution
// (`resolveApiKey`) with the same CF_AI_GATEWAY_* env the Worker reads.
import { strict as assert } from 'node:assert';
import process from 'node:process';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createProviderStream, PROVIDER_CONFIGS, resolveApiKey } from '../provider.ts';
import { executeToolCall } from '../tools.ts';

const ENV_KEYS = [
  'CF_AI_GATEWAY_ACCOUNT_ID',
  'CF_AI_GATEWAY_SLUG',
  'CF_AI_GATEWAY_TOKEN',
  'CF_AI_GATEWAY_BYOK',
  'PUSH_ANTHROPIC_API_KEY',
  'ANTHROPIC_API_KEY',
  'PUSH_ANTHROPIC_URL',
  'PUSH_DEEPSEEK_API_KEY',
  'DEEPSEEK_API_KEY',
];
const ANTHROPIC_SSE =
  `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } })}\n\n` +
  `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
const GATEWAY = 'https://gateway.ai.cloudflare.com/v1/acct123/push-gate';

let saved;
let originalFetch;
let calls;
let responses;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  originalFetch = globalThis.fetch;
  calls = [];
  responses = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    const next = responses.shift() ?? { status: 200, body: ANTHROPIC_SSE };
    return new Response(next.body, {
      status: next.status,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function gatewayEnv(extra = {}) {
  Object.assign(process.env, {
    CF_AI_GATEWAY_ACCOUNT_ID: 'acct123',
    CF_AI_GATEWAY_SLUG: 'push-gate',
    CF_AI_GATEWAY_TOKEN: 'aig-token',
    ...extra,
  });
}

async function send(provider, apiKey) {
  const stream = createProviderStream(PROVIDER_CONFIGS[provider], apiKey);
  let text = '';
  for await (const ev of stream({
    provider,
    model: provider === 'anthropic' ? 'claude-sonnet-5-5' : 'deepseek-v4-pro',
    messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
  })) {
    if (ev.type === 'text_delta') text += ev.text;
  }
  return text;
}

describe('CLI AI Gateway routing', () => {
  it('routes Anthropic through the gateway with cf-aig-authorization, keeping the key', async () => {
    gatewayEnv();
    assert.equal(await send('anthropic', 'direct-key'), 'ok');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${GATEWAY}/anthropic/v1/messages`);
    assert.equal(calls[0].headers['cf-aig-authorization'], 'Bearer aig-token');
    assert.equal(calls[0].headers['cf-aig-skip-cache'], 'true');
    assert.equal(calls[0].headers['x-api-key'], 'direct-key');
  });

  it('is keyless when the gateway holds the key (BYOK): no key needed, none sent', async () => {
    gatewayEnv({ CF_AI_GATEWAY_BYOK: 'anthropic,deepseek' });
    // No Anthropic key anywhere, and resolution still succeeds.
    assert.equal(resolveApiKey(PROVIDER_CONFIGS.anthropic), '');
    assert.equal(await send('anthropic', ''), 'ok');
    assert.equal(calls[0].url, `${GATEWAY}/anthropic/v1/messages`);
    assert.equal(calls[0].headers['x-api-key'], undefined);
  });

  it('still demands a key when the gateway is configured but does not hold it', () => {
    gatewayEnv();
    assert.throws(() => resolveApiKey(PROVIDER_CONFIGS.anthropic), /Missing API key for anthropic/);
  });

  it('falls back to the direct endpoint when the gateway fails before output', async () => {
    gatewayEnv({ CF_AI_GATEWAY_BYOK: 'anthropic' });
    responses.push({ status: 502, body: '{"error":"gateway down"}' });
    const logged = [];
    const originalError = console.error;
    console.error = (line) => logged.push(String(line));
    try {
      assert.equal(await send('anthropic', 'direct-key'), 'ok');
    } finally {
      console.error = originalError;
    }
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, `${GATEWAY}/anthropic/v1/messages`);
    assert.equal(calls[0].headers['x-api-key'], undefined, 'BYOK gateway attempt is keyless');
    assert.equal(calls[1].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(calls[1].headers['x-api-key'], 'direct-key');
    assert.equal(calls[1].headers['cf-aig-authorization'], undefined, 'token never goes direct');
    assert.ok(
      logged.some((l) => l.includes('"cli_gateway_fell_back_direct"')),
      logged.join('\n'),
    );
  });

  it('has no fallback without a direct key: the gateway error surfaces', async () => {
    gatewayEnv({ CF_AI_GATEWAY_BYOK: 'anthropic' });
    responses.push({ status: 502, body: '{"error":"gateway down"}' });
    await assert.rejects(() => send('anthropic', ''));
    assert.equal(calls.length, 1);
  });

  it("routes DeepSeek's Anthropic-compatible endpoint through the gateway", async () => {
    gatewayEnv({ CF_AI_GATEWAY_BYOK: 'deepseek' });
    assert.equal(await send('deepseek', ''), 'ok');
    assert.equal(calls[0].url, `${GATEWAY}/deepseek/anthropic/v1/messages`);
    assert.equal(calls[0].headers['x-api-key'], undefined);
  });

  it('never hijacks a user-overridden endpoint', async () => {
    gatewayEnv({ CF_AI_GATEWAY_BYOK: 'anthropic' });
    process.env.PUSH_ANTHROPIC_URL = 'https://proxy.example/v1/messages';
    await send('anthropic', 'direct-key');
    assert.equal(calls[0].url, 'https://proxy.example/v1/messages');
    assert.equal(calls[0].headers['cf-aig-authorization'], undefined);
  });

  it('goes direct, with no gateway headers, when the gateway is not configured', async () => {
    await send('anthropic', 'direct-key');
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(calls[0].headers['cf-aig-authorization'], undefined);
    assert.equal(calls[0].headers['cf-aig-skip-cache'], undefined);
  });

  it('lets the Auditor commit gate run keyless through gateway BYOK', async () => {
    // Codex P1: resolveApiKey returns '' for BYOK, but the gate read an empty
    // key as "no credentials" and failed every git_commit closed.
    gatewayEnv({ CF_AI_GATEWAY_BYOK: 'anthropic' });
    const verdict = JSON.stringify({ verdict: 'safe', summary: 'ok', risks: [] });
    responses.push({
      status: 200,
      body:
        `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: verdict } })}\n\n` +
        `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    });
    const run = promisify(execFile);
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'push-gw-gate-'));
    try {
      await run('git', ['init', '-q'], { cwd: repo });
      await run('git', ['config', 'user.email', 't@push.dev'], { cwd: repo });
      await run('git', ['config', 'user.name', 'Push Test'], { cwd: repo });
      await run('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
      await fs.writeFile(path.join(repo, 'a.txt'), 'hello\n');
      const result = await executeToolCall(
        { tool: 'git_commit', args: { message: 'add a' } },
        repo,
        {
          role: 'coder',
          auditorGate: true,
          providerId: 'anthropic',
          model: 'claude-sonnet-5-5',
        },
      );
      assert.ok(!/could not run/.test(result.text), result.text);
      assert.equal(
        calls[0]?.url,
        `${GATEWAY}/anthropic/v1/messages`,
        'the Auditor ran via the gateway',
      );
      assert.equal(calls[0].headers['x-api-key'], undefined);
      assert.equal(result.ok, true, result.text);
    } finally {
      await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
    }
  });
});
