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
  {
    name: 'get_date',
    description: 'Returns the current date.',
    parameters: { type: 'object', properties: {} },
  },
];
const user = {
  id: 'u1',
  role: 'user' as const,
  content: 'Call get_time and get_date in parallel (both in one turn), then tell me both results.',
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

// Round 2: replay every call and its result, one message per result as Push
// stores them, then compare the serializer's output with the old split form.
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
      contentBlocks: calls.map((c, i) => ({
        type: 'tool_use',
        id: `call_${i}`,
        name: c.name,
        input: c.args ?? {},
        ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}),
      })),
    },
    ...calls.map((c, i) => ({
      id: `r${i}`,
      role: 'user',
      content: '',
      timestamp: 0,
      contentBlocks: [
        {
          type: 'tool_result',
          tool_use_id: `call_${i}`,
          content: c.name === 'get_time' ? '12:00 UTC' : '2026-10-26',
        },
      ],
    })),
  ],
} as never) as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };

// The pre-fix shape: one user turn per functionResponse.
const split = {
  ...round2,
  contents: round2.contents.flatMap((c) =>
    c.role === 'user' && c.parts.length > 1 && c.parts.every((p) => 'functionResponse' in p)
      ? c.parts.map((p) => ({ role: 'user', parts: [p] }))
      : [c],
  ),
};
const shape = (b: typeof round2) =>
  JSON.stringify(
    b.contents.map((c) => ({ role: c.role, parts: c.parts.map((p) => Object.keys(p)[0]) })),
  );
console.log('merged shape:', shape(round2));
console.log('split shape: ', shape(split));
for (const [label, body] of [
  ['merged (fixed serializer)', round2],
  ['split (one turn per result, pre-fix)', split],
] as const) {
  const r = await post('generateContent', body);
  const t = redact(await r.text());
  console.log(`
round 2 [${label}]: HTTP ${r.status}
${t.slice(0, 400) || '(empty body)'}`);
}
