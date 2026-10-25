// One local front door to the model for every arm, and the neutral witness.
//
// Each arm points its Anthropic base URL at http://127.0.0.1:8789/<arm>. The
// proxy forwards /v1/messages upstream and records every request and response
// body to results/wire/<arm>/, so we can see what each harness actually sent
// the model instead of trusting the harness's own transcript.
//
// Upstream, in order of preference (read from shared/.proxy.env or the shell):
//   1. AI Gateway with BYOK: CF_AI_GATEWAY_ACCOUNT_ID + CF_AI_GATEWAY_SLUG, plus
//      CF_AI_GATEWAY_TOKEN when the gateway is authenticated. No Anthropic key
//      is needed or sent; the gateway injects its stored one.
//   2. Direct: ANTHROPIC_API_KEY against api.anthropic.com.
//
// Usage: node shared/model-proxy.mjs
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BAKEOFF_PROXY_PORT ?? 8789);
const ARMS = new Set(['push', 'think', 'pi']);

loadEnvFile(join(here, '.proxy.env'));
const upstream = resolveUpstream();
console.error(
  JSON.stringify({ level: 'info', event: 'proxy_upstream', mode: upstream.mode, port: PORT }),
);

const wireDir = join(here, '..', 'results', 'wire');

createServer(async (req, res) => {
  // /<arm>/v1/messages or /<arm>/<runId>/v1/messages. The run id files each
  // request under its run without trusting clocks (WSL's drifts from Windows').
  const [, arm, ...rest] = (req.url ?? '').split('/');
  const runId = rest[0] && rest[0] !== 'v1' ? decodeURIComponent(rest.shift()) : null;
  const path = '/' + rest.join('/');
  if (!ARMS.has(arm) || req.method !== 'POST' || !path.startsWith('/v1/messages')) {
    console.error(
      JSON.stringify({ level: 'warn', event: 'proxy_rejected', method: req.method, url: req.url }),
    );
    res.writeHead(404).end('bake-off proxy: expected POST /<push|think|pi>/v1/messages');
    return;
  }

  const { body, asked } = normalize(await readBody(req));
  const seq = Date.now();
  const logFile = join(wireDir, arm, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  mkdirSync(dirname(logFile), { recursive: true });
  appendFileSync(logFile, JSON.stringify({ seq, runId, dir: 'request', path, body, asked }) + '\n');

  const headers = {
    'content-type': 'application/json',
    'anthropic-version': req.headers['anthropic-version'] ?? '2023-06-01',
    ...(req.headers['anthropic-beta'] ? { 'anthropic-beta': req.headers['anthropic-beta'] } : {}),
    ...upstream.headers,
  };

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstream.base + path, { method: 'POST', headers, body });
  } catch (error) {
    appendFileSync(
      logFile,
      JSON.stringify({ seq, runId, dir: 'error', message: String(error) }) + '\n',
    );
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'proxy_upstream_failed',
        arm,
        message: String(error),
      }),
    );
    res.writeHead(502).end('bake-off proxy: upstream unreachable');
    return;
  }

  res.writeHead(upstreamRes.status, {
    'content-type': upstreamRes.headers.get('content-type') ?? 'application/json',
  });
  // Stream through to the arm while keeping a full copy for the record.
  let copy = '';
  const decoder = new TextDecoder();
  for await (const chunk of upstreamRes.body) {
    copy += decoder.decode(chunk, { stream: true });
    res.write(chunk);
  }
  res.end();
  appendFileSync(
    logFile,
    JSON.stringify({ seq, runId, dir: 'response', status: upstreamRes.status, body: copy }) + '\n',
  );
  console.error(
    JSON.stringify({ level: 'info', event: 'proxy_forwarded', arm, status: upstreamRes.status }),
  );
}).listen(PORT, '127.0.0.1');

// Hold the model's reasoning knobs equal across arms. Harnesses pick different
// defaults (Pi sends thinking off, Push sends nothing, which means adaptive), and
// that difference would swamp the loop difference under test. Strip both so
// every arm gets the API default, and keep what the harness asked for in the
// log so the original choice stays visible.
function normalize(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { body: raw, asked: null };
  }
  const asked = {
    thinking: parsed.thinking ?? null,
    effort: parsed.output_config?.effort ?? null,
    temperature: parsed.temperature ?? null,
    top_p: parsed.top_p ?? null,
    top_k: parsed.top_k ?? null,
  };
  delete parsed.thinking;
  // Haiku 5.5 rejects non-default sampling values with a 400, and Push's
  // model gate misses it (found by this spike), so hold these equal too.
  delete parsed.temperature;
  delete parsed.top_p;
  delete parsed.top_k;
  if (parsed.output_config) {
    delete parsed.output_config.effort;
    if (Object.keys(parsed.output_config).length === 0) delete parsed.output_config;
  }
  return { body: JSON.stringify(parsed), asked };
}

function resolveUpstream() {
  const {
    CF_AI_GATEWAY_ACCOUNT_ID: account,
    CF_AI_GATEWAY_SLUG: slug,
    CF_AI_GATEWAY_TOKEN: token,
  } = process.env;
  if (account && slug) {
    return {
      mode: token ? 'gateway-byok-authenticated' : 'gateway-byok',
      base: `https://gateway.ai.cloudflare.com/v1/${account}/${slug}/anthropic`,
      headers: token ? { 'cf-aig-authorization': `Bearer ${token}` } : {},
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      mode: 'direct',
      base: 'https://api.anthropic.com',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY },
    };
  }
  console.error(JSON.stringify({ level: 'error', event: 'proxy_no_upstream' }));
  console.error(
    'Set CF_AI_GATEWAY_ACCOUNT_ID + CF_AI_GATEWAY_SLUG (+ CF_AI_GATEWAY_TOKEN) in shared/.proxy.env, or ANTHROPIC_API_KEY.',
  );
  process.exit(1);
}

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
