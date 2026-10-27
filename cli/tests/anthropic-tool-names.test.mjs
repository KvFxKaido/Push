// The CLI's Anthropic stream enables native web search by default, and Push's
// tool registry has its own `web_search` function tool. Sending both made
// Anthropic reject every request: "tools: Tool names must be unique." Drives
// the real stream boundary and checks the tool names that reach the wire.
import { strict as assert } from 'node:assert';
import process from 'node:process';
import { afterEach, beforeEach, it } from 'node:test';
import { createProviderStream, PROVIDER_CONFIGS } from '../provider.ts';

const SSE = `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
const saved = {};
let originalFetch;
let bodies;

beforeEach(() => {
  for (const k of ['PUSH_ANTHROPIC_WEB_SEARCH', 'CF_AI_GATEWAY_ACCOUNT_ID', 'CF_AI_GATEWAY_SLUG']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  originalFetch = globalThis.fetch;
  bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const schema = { type: 'object', properties: {}, required: [], additionalProperties: false };
async function send() {
  const stream = createProviderStream(PROVIDER_CONFIGS.anthropic, 'k');
  for await (const _ of stream({
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
    tools: [
      { name: 'read_file', description: 'Read a file', input_schema: schema },
      { name: 'web_search', description: 'Search the web', input_schema: schema },
    ],
  })) {
    // drain
  }
  return bodies[0].tools.map((t) => t.name);
}

it('sends unique tool names with native web search on (the default)', async () => {
  const names = await send();
  assert.deepEqual(names, ['read_file', 'web_search']);
  assert.equal(new Set(names).size, names.length);
  assert.equal(bodies[0].tools[1].type, 'web_search_20250305');
});

it("keeps Push's own web_search tool when native search is off", async () => {
  process.env.PUSH_ANTHROPIC_WEB_SEARCH = '0';
  const names = await send();
  assert.deepEqual(names, ['read_file', 'web_search']);
  assert.equal(bodies[0].tools[1].type, undefined, 'the function tool, not the server tool');
});
