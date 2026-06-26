/**
 * Phase-0 latency-spike measurement page (Durable Runs — Adopt-on-Silence).
 *
 * Served at GET /api/runhost/spike/page, behind the universal session gate
 * (the push_session cookie rides on same-origin navigation). Designed to be
 * run from a phone on cellular against the deployed Worker.
 *
 * Four arms per trial, interleaved so clock/network drift hits all arms
 * equally:
 *   direct  — POST /api/<provider>/chat        (today's in-page loop path)
 *   relay   — POST /api/runhost/spike/relay     (provider SSE through the DO)
 *   ws      — GET  /api/runhost/spike/ws        (provider stream over WS-from-DO)
 *   server  — POST /api/runhost/spike/server-turn (DO-internal turn, no phone
 *              in the loop — the adopted-run datum)
 *
 * Self-contained vanilla JS by design: zero app-bundle churn for throwaway
 * code, and both compared arms share identical client code so the deltas
 * are valid even though absolute numbers differ slightly from the real app.
 */

import { getZenGoTransport, ZEN_GO_MODELS } from '../lib/zen-go';

// Derived from the canonical Zen-Go transport map so the page's native-SSE
// capability advertisement can't drift from `getZenGoTransport` when the catalog
// changes. Interpolated into the served script below.
const ZEN_GO_ANTHROPIC_MODEL_IDS = ZEN_GO_MODELS.filter(
  (id) => getZenGoTransport(id) === 'anthropic',
);

export const SPIKE_PAGE_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Push — Durable Runs latency spike</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, sans-serif; background: #0b0f14; color: #dce3ea; margin: 0; padding: 16px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #7d8a96; font-size: 12px; margin-bottom: 16px; }
  fieldset { border: 1px solid #243140; border-radius: 8px; margin: 0 0 12px; padding: 10px; }
  legend { font-size: 12px; color: #7d8a96; padding: 0 6px; }
  label { display: inline-flex; align-items: center; gap: 6px; font-size: 14px; margin: 4px 12px 4px 0; }
  input[type=text], input[type=number], select { background: #121a24; color: #dce3ea; border: 1px solid #2c3a4a; border-radius: 6px; padding: 6px 8px; font-size: 14px; }
  input[type=number] { width: 70px; }
  button { background: #0ea5e9; color: #04141f; font-weight: 600; border: 0; border-radius: 8px; padding: 10px 18px; font-size: 15px; }
  button:disabled { opacity: .5; }
  #status { font-size: 13px; color: #9fb2c2; margin: 10px 0; min-height: 18px; white-space: pre-wrap; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; margin-top: 8px; }
  th, td { border: 1px solid #243140; padding: 5px 7px; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  th { color: #7d8a96; font-weight: 500; }
  textarea { width: 100%; height: 140px; background: #121a24; color: #9fb2c2; border: 1px solid #2c3a4a; border-radius: 6px; font-size: 11px; margin-top: 10px; }
  .err { color: #f87171; }
</style>
</head>
<body>
<h1>Durable Runs — latency spike</h1>
<div class="sub">Phase 0 instrument. Numbers land in docs/decisions/Durable Runs — Adopt-on-Silence.md.</div>

<fieldset><legend>Target</legend>
  <label>Provider
    <select id="provider">
      <option value="zen" selected>zen</option>
      <option value="zen-go">zen (go)</option>
      <option value="openrouter">openrouter</option>
      <option value="anthropic">anthropic</option>
      <option value="openai">openai</option>
      <option value="google">google</option>
      <option value="cloudflare">cloudflare</option>
    </select>
  </label>
  <label>Model <input type="text" id="model" value="glm-5.1" size="18"></label>
  <label>Max tokens <input type="number" id="maxTokens" value="256"></label>
</fieldset>

<fieldset><legend>Run</legend>
  <label>Trials <input type="number" id="trials" value="6" min="1" max="30"></label>
  <label>Network label <input type="text" id="network" value="cellular" size="10"></label>
  <label>DO instance <input type="text" id="instance" value="latency-spike" size="12"></label>
  <br>
  <label><input type="checkbox" id="armDirect" checked> direct</label>
  <label><input type="checkbox" id="armRelay" checked> relay-SSE</label>
  <label><input type="checkbox" id="armWs" checked> relay-WS</label>
  <label><input type="checkbox" id="armServer" checked> server-turn</label>
</fieldset>

<button id="run">Run trials</button>
<div id="status"></div>
<div id="results"></div>
<textarea id="raw" readonly placeholder="Raw JSON appears here after a run"></textarea>
<button id="copy" style="margin-top:6px">Copy JSON</button>

<script src="/api/runhost/spike/page.js"></script>
</body>
</html>
`;

/**
 * The page script, served separately at GET /api/runhost/spike/page.js so the
 * strict global CSP (script-src 'self') applies unchanged — no inline-script
 * exception, no hash maintenance.
 */
export const SPIKE_PAGE_JS = `'use strict';
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildSpec() {
  const providerSel = $('provider').value;
  return {
    provider: providerSel === 'zen-go' ? 'zen' : providerSel,
    zenGo: providerSel === 'zen-go',
    model: $('model').value.trim(),
    maxTokens: Number($('maxTokens').value) || 256,
  };
}

function directUrl(spec) {
  return spec.zenGo ? '/api/zen/go/chat' : '/api/' + spec.provider + '/chat';
}

// Scan decoded SSE text incrementally; returns events found in this chunk.
function makeSseScanner() {
  let buffer = '';
  return function scan(chunkText) {
    buffer += chunkText.replace(/\\r\\n/g, '\\n');
    const out = { deltaChars: 0, gotDelta: false, done: false, marks: {} };
    let idx = buffer.indexOf('\\n\\n');
    while (idx !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of rawEvent.split('\\n')) {
        const t = line.trim();
        const mark = t.match(/^: spike (\\w+)=(\\d+)$/);
        if (mark) { out.marks[mark[1]] = Number(mark[2]); continue; }
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]') { out.done = true; continue; }
        try {
          // First token of ANY kind — reasoning models stream
          // reasoning_content before (or instead of) content.
          const parsed = JSON.parse(data);
          const d = parsed.choices?.[0]?.delta;
          let delta = (typeof d?.content === 'string' && d.content.length) ? d.content
            : (typeof d?.reasoning_content === 'string' && d.reasoning_content.length) ? d.reasoning_content
            : null;
          // Anthropic Messages SSE (Zen-Go MiniMax/Qwen now proxy raw): text /
          // thinking arrive as content_block_delta, not under choices (Codex P2, #1181).
          if (delta === null && parsed.type === 'content_block_delta') {
            const ad = parsed.delta;
            delta = (typeof ad?.text === 'string' && ad.text.length) ? ad.text
              : (typeof ad?.thinking === 'string' && ad.thinking.length) ? ad.thinking
              : null;
          }
          if (delta !== null) { out.gotDelta = true; out.deltaChars += delta.length; }
        } catch {}
      }
      idx = buffer.indexOf('\\n\\n');
    }
    return out;
  };
}

// Direct provider endpoints take the OpenAI-compatible shape; the spike
// endpoints take SpikeChatRequest. Strict upstreams (OpenAI) reject unknown
// params, so each target gets exactly its own shape.
function bodyFor(mode, spec) {
  if (mode === 'direct') {
    return { model: spec.model, messages: [{ role: 'user', content: PROMPT }], stream: true, max_tokens: spec.maxTokens };
  }
  return { provider: spec.provider, zenGo: spec.zenGo, model: spec.model, maxTokens: spec.maxTokens, prompt: PROMPT };
}

function nativeSseHeaders(spec) {
  const zenGoAnthropic = spec.zenGo && ${JSON.stringify(ZEN_GO_ANTHROPIC_MODEL_IDS)}.includes(spec.model);
  return spec.provider === 'anthropic' || zenGoAnthropic ? { 'X-Push-Native-SSE': '1' } : {};
}

async function measureSseArm(url, spec, mode) {
  const t0 = performance.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...nativeSseHeaders(spec) },
    body: JSON.stringify(bodyFor(mode, spec)),
  });
  if (!res.ok || !res.body) throw new Error(url + ' -> HTTP ' + res.status + ' ' + (await res.text().catch(() => '')).slice(0, 120));
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const scan = makeSseScanner();
  let ttfbMs = null, ttftMs = null, chars = 0; const marks = {};
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (ttfbMs === null) ttfbMs = performance.now() - t0;
    const r = scan(decoder.decode(value, { stream: true }));
    Object.assign(marks, r.marks);
    if (r.gotDelta && ttftMs === null) ttftMs = performance.now() - t0;
    chars += r.deltaChars;
    if (r.done) break;
  }
  return { ttfbMs, ttftMs, totalMs: performance.now() - t0, chars, ...(
    marks.upstream_first_byte_ms !== undefined ? { doUpstreamFirstByteMs: marks.upstream_first_byte_ms } : {}) };
}

function spikeUrl(path) {
  const inst = encodeURIComponent($('instance').value.trim() || 'latency-spike');
  return '/api/runhost/spike/' + path + '?instance=' + inst;
}

async function measureWsArm(spec) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const ws = new WebSocket(proto + location.host + spikeUrl('ws'));
    let connectMs = null, sentAt = null, ttftMs = null, serverDone = null, chars = 0;
    const fail = (msg) => { try { ws.close(); } catch {} reject(new Error(msg)); };
    const timer = setTimeout(() => fail('ws timeout'), 70000);
    ws.onopen = () => {
      connectMs = performance.now() - t0;
      sentAt = performance.now();
      ws.send(JSON.stringify({ provider: spec.provider, zenGo: spec.zenGo, model: spec.model, maxTokens: spec.maxTokens, prompt: PROMPT }));
    };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'delta') { if (ttftMs === null) ttftMs = performance.now() - sentAt; chars += m.text.length; }
      else if (m.t === 'done') serverDone = m;
      else if (m.t === 'error') { clearTimeout(timer); fail('ws: ' + m.message); }
    };
    ws.onerror = () => { clearTimeout(timer); fail('ws error (check session/auth)'); };
    ws.onclose = () => {
      clearTimeout(timer);
      if (!serverDone) { reject(new Error('ws closed before done')); return; }
      resolve({ connectMs, ttftMs, totalMs: performance.now() - sentAt, chars,
        serverFirstByteMs: serverDone.serverFirstByteMs, serverFirstTokenMs: serverDone.serverFirstTokenMs, serverTotalMs: serverDone.serverTotalMs });
    };
  });
}

async function measureServerArm(spec) {
  const t0 = performance.now();
  const res = await fetch(spikeUrl('server-turn'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: spec.provider, zenGo: spec.zenGo, model: spec.model, maxTokens: spec.maxTokens, prompt: PROMPT }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !body.ok) throw new Error('server-turn HTTP ' + res.status + ' ' + JSON.stringify(body).slice(0, 120));
  return { clientRoundTripMs: performance.now() - t0, serverFirstByteMs: body.serverFirstByteMs,
    serverFirstTokenMs: body.serverFirstTokenMs, serverTotalMs: body.serverTotalMs, chars: body.contentChars };
}

const PROMPT = 'Count from 1 to 30 as words (one, two, three, ...), comma-separated, no other text.';

function quantile(values, q) {
  const s = values.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  if (!s.length) return null;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return Math.round(s[lo] + (s[hi] - s[lo]) * (pos - lo));
}

function summarize(samples) {
  const keys = new Set(); samples.forEach((s) => Object.keys(s).forEach((k) => keys.add(k)));
  const out = {};
  for (const k of keys) {
    const vals = samples.map((s) => s[k]);
    out[k] = { p50: quantile(vals, 0.5), p90: quantile(vals, 0.9), min: quantile(vals, 0), n: vals.filter((v) => typeof v === 'number').length };
  }
  return out;
}

// Error strings carry upstream response bodies — escape before they touch
// innerHTML (raw upstream content must never render as markup).
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
}

function renderResults(result) {
  const div = $('results');
  let html = '';
  for (const [arm, data] of Object.entries(result.arms)) {
    html += '<h3 style="font-size:14px;margin:14px 0 2px">' + esc(arm) + (data.errors.length ? ' <span class="err">(' + data.errors.length + ' errored)</span>' : '') + '</h3>';
    const summary = summarize(data.samples);
    html += '<table><tr><th>metric</th><th>p50</th><th>p90</th><th>min</th><th>n</th></tr>';
    for (const [k, v] of Object.entries(summary)) {
      html += '<tr><td>' + esc(k) + '</td><td>' + v.p50 + '</td><td>' + v.p90 + '</td><td>' + v.min + '</td><td>' + v.n + '</td></tr>';
    }
    html += '</table>';
    if (data.errors.length) html += '<div class="err" style="font-size:11px">' + data.errors.map((e) => esc(e.slice(0, 160))).join('<br>') + '</div>';
  }
  div.innerHTML = html;
  $('raw').value = JSON.stringify(result, null, 1);
}

$('copy').onclick = () => { $('raw').select(); navigator.clipboard?.writeText($('raw').value); };

$('run').onclick = async () => {
  const spec = buildSpec();
  const trials = Math.max(1, Math.min(30, Number($('trials').value) || 6));
  const arms = [];
  if ($('armDirect').checked) arms.push(['direct', () => measureSseArm(directUrl(spec), spec, 'direct')]);
  if ($('armRelay').checked) arms.push(['relay', () => measureSseArm(spikeUrl('relay'), spec, 'relay')]);
  if ($('armWs').checked) arms.push(['ws', () => measureWsArm(spec)]);
  if ($('armServer').checked) arms.push(['server', () => measureServerArm(spec)]);
  if (!arms.length) return;

  $('run').disabled = true;
  const result = {
    page: 'durable-runs-latency-spike/v1',
    when: new Date().toISOString(),
    ua: navigator.userAgent,
    network: $('network').value.trim(),
    spec, trials,
    arms: Object.fromEntries(arms.map(([name]) => [name, { samples: [], errors: [] }])),
  };
  try {
    for (let t = 0; t < trials; t++) {
      for (const [name, fn] of arms) {
        $('status').textContent = 'trial ' + (t + 1) + '/' + trials + ' — ' + name + '…';
        try { result.arms[name].samples.push(await fn()); }
        catch (e) { result.arms[name].errors.push(String(e && e.message || e)); }
        await sleep(300);
      }
      renderResults(result);
    }
    $('status').textContent = 'done — ' + trials + ' trials. Copy the JSON into the decision doc.';
  } finally {
    $('run').disabled = false;
  }
};
`;
