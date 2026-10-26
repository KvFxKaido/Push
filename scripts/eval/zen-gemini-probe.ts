// One-off diagnostic: replays a two-round Gemini tool-call turn against Zen
// using Push's own serializer (toGeminiGenerateContent) and parser
// (geminiEventStream), then tries round 2 in a few variants and prints Zen's
// full response for each. Reads the key from ZEN_PROBE_KEY; never prints it.
//
//   ZEN_PROBE_KEY=... npx tsx scripts/eval/zen-gemini-probe.ts [model]
import process from 'node:process';
import { geminiEventStream, toGeminiGenerateContent } from '../../lib/gemini-bridge.js';

const key = process.env.ZEN_PROBE_KEY?.trim();
if (!key) {
  console.error('Set ZEN_PROBE_KEY first.');
  process.exit(1);
}
const model = process.argv[2] ?? 'gemini-3.8-flash';
const base = `https://opencode.ai/zen/v1/models/${encodeURIComponent(model)}`;
const redact = (s: string) => s.split(key).join('<key>');

const tools = [
  {
    name: 'get_time',
    description: 'Returns the current time.',
    parameters: { type: 'object', properties: {} },
  },
];
const user = {
  id: 'u1',
  role: 'user' as const,
  content: 'Call the get_time tool, then tell me the time it returned.',
  timestamp: 0,
};

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}:${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key as string },
    body: JSON.stringify(body),
  });
}

// Round 1: let the model call the tool.
const round1 = toGeminiGenerateContent({
  provider: 'zen',
  model,
  messages: [user],
  tools,
} as never);
const r1 = await post('streamGenerateContent?alt=sse', round1);
console.log(`round 1: HTTP ${r1.status}`);
if (!r1.ok) {
  console.log(redact(await r1.text()));
  process.exit(1);
}
const calls: Array<{ name: string; args: unknown; thoughtSignature?: string }> = [];
let text = '';
for await (const ev of geminiEventStream(r1)) {
  if (ev.type === 'native_tool_call') calls.push(ev.call as never);
  if (ev.type === 'text_delta') text += ev.text;
}
console.log(
  `round 1 result: ${calls.length} call(s) ${JSON.stringify(calls.map((c) => ({ name: c.name, hasSignature: Boolean(c.thoughtSignature) })))}; text=${JSON.stringify(text.slice(0, 120))}`,
);
if (calls.length === 0) {
  console.log('No tool call in round 1, so round 2 cannot be probed. Try another model.');
  process.exit(0);
}

// Round 2: replay the call and its result, as Push does.
const call = calls[0];
const round2 = toGeminiGenerateContent({
  provider: 'zen',
  model,
  tools,
  messages: [
    user,
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: 0,
      contentBlocks: [
        {
          type: 'tool_use',
          id: 'call_1',
          name: call.name,
          input: call.args ?? {},
          ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
        },
      ],
    },
    {
      id: 'r1',
      role: 'user',
      content: '',
      timestamp: 0,
      contentBlocks: [{ type: 'tool_result', tool_use_id: 'call_1', content: '12:00 UTC' }],
    },
  ],
} as never) as { contents: Array<{ parts: Array<Record<string, unknown>> }> };

const stripIds = (body: typeof round2) =>
  JSON.parse(
    JSON.stringify(body, (k, v) =>
      (k === 'functionCall' || k === 'functionResponse') && v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).filter(([kk]) => kk !== 'id'))
        : v,
    ),
  );

const variants: Array<[string, unknown]> = [
  ['as Push sends it', round2],
  ['without functionCall/functionResponse ids', stripIds(round2)],
];
console.log(
  'round 2 contents shape:',
  JSON.stringify(
    round2.contents.map((c) => ({
      role: (c as never as { role: string }).role,
      parts: c.parts.map((p) => Object.keys(p)),
    })),
  ),
);
for (const [label, body] of variants) {
  for (const path of ['streamGenerateContent?alt=sse', 'generateContent']) {
    const r = await post(path, body);
    const t = redact(await r.text());
    console.log(
      `\nround 2 [${label}] ${path.split('?')[0]}: HTTP ${r.status}\n${t.slice(0, 600) || '(empty body)'}`,
    );
  }
}
