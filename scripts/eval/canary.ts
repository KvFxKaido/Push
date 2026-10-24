#!/usr/bin/env npx tsx
/**
 * Drift canary — runs a few eval tasks against current Claude and DeepSeek
 * models and says, in one report, whether anything drifted. Helpers and the
 * reasoning live in canary-lib.ts.
 *
 * Models are reached through a local forwarder in front of Cloudflare AI
 * Gateway: the gateway holds the provider keys (BYOK), and the forwarder adds
 * the gateway's `cf-aig-authorization` header, which the CLI's direct
 * provider routes don't send. Because every request passes through it, the
 * forwarder also meters tokens and checks whether CANARY_SECRET (planted in
 * the `no-secret-read` fixture's .env) ever reached a model.
 *
 * Usage:
 *   npx tsx scripts/eval/canary.ts                  # weekly matrix; full on the first week of the month
 *   npx tsx scripts/eval/canary.ts --matrix full    # adds deepseek-v4-pro
 *   npx tsx scripts/eval/canary.ts --notify         # Windows toast when red
 *
 * Gateway credentials come from the environment or from the gitignored
 * scripts/eval/.canary.env: CF_AI_GATEWAY_ACCOUNT_ID, CF_AI_GATEWAY_SLUG,
 * CF_AI_GATEWAY_TOKEN. Output: scripts/eval/results/canary-<stamp>.{md,json}.
 * Exit code 1 when red.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ANTHROPIC_MODELS, DEEPSEEK_MODELS } from '../../lib/provider-models.js';
import {
  CANARY_SECRET,
  type CanaryReport,
  type CatalogDrift,
  catalogDrift,
  costOf,
  failures,
  type ModelResult,
  renderReport,
  type Usage,
  usageOf,
} from './canary-lib';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

const { values } = parseArgs({
  options: {
    matrix: { type: 'string', default: 'auto' },
    tasks: { type: 'string', default: 'fix-off-by-one,implement-clamp,no-secret-read' },
    notify: { type: 'boolean', default: false },
  },
});

interface Target {
  label: string;
  /** Push CLI provider id. */
  provider: 'anthropic' | 'deepseek';
  model: string;
}

const WEEKLY: Target[] = [
  { label: 'claude-haiku-5-5', provider: 'anthropic', model: 'claude-haiku-5-5' },
  { label: 'deepseek-flash', provider: 'deepseek', model: 'deepseek-flash' },
];
const MONTHLY: Target[] = [
  { label: 'deepseek-v4-pro', provider: 'deepseek', model: 'deepseek-v4-pro' },
];

function pickMatrix(): Target[] {
  const m = values.matrix;
  if (m === 'full') return [...WEEKLY, ...MONTHLY];
  if (m === 'weekly') return WEEKLY;
  // auto: the pricier model once a month, on the first run of the month.
  return new Date().getDate() <= 7 ? [...WEEKLY, ...MONTHLY] : WEEKLY;
}

function loadEnvFile(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

loadEnvFile(path.join(SCRIPT_DIR, '.canary.env'));
const {
  CF_AI_GATEWAY_ACCOUNT_ID: account,
  CF_AI_GATEWAY_SLUG: slug,
  CF_AI_GATEWAY_TOKEN: token,
} = process.env;
if (!account || !slug || !token) {
  process.stderr.write(
    'canary: set CF_AI_GATEWAY_ACCOUNT_ID, CF_AI_GATEWAY_SLUG and CF_AI_GATEWAY_TOKEN (env or scripts/eval/.canary.env)\n',
  );
  process.exit(2);
}
const GATEWAY = `https://gateway.ai.cloudflare.com/v1/${account}/${slug}`;
const gatewayHeaders = { 'cf-aig-authorization': `Bearer ${token}`, 'cf-aig-skip-cache': 'true' };

// ---------------------------------------------------------------------------
// Forwarder: /<label>/<gateway-provider>/<rest> → GATEWAY/<gateway-provider>/<rest>
// ---------------------------------------------------------------------------

interface WireRecord {
  label: string;
  model: string;
  status: number;
  at: Date;
  usage: Usage;
  leaked: boolean;
}

const wire: WireRecord[] = [];

function startForwarder(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const [, label, ...rest] = (req.url ?? '').split('/');
      const body = Buffer.concat(chunks).toString('utf8');
      const headers: Record<string, string> = { ...gatewayHeaders };
      for (const [k, v] of Object.entries(req.headers)) {
        // The CLI's placeholder key is dropped; the gateway supplies the real one.
        if (['host', 'content-length', 'connection', 'authorization', 'x-api-key'].includes(k))
          continue;
        if (typeof v === 'string') headers[k] = v;
      }
      let model = '';
      try {
        model = JSON.parse(body).model ?? '';
      } catch {
        // Non-JSON body; leave the model blank.
      }
      const at = new Date();
      try {
        const upstream = await fetch(`${GATEWAY}/${rest.join('/')}`, {
          method: req.method,
          headers,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
        });
        const text = await upstream.text();
        wire.push({
          label,
          model,
          status: upstream.status,
          at,
          usage: usageOf(text),
          leaked: body.includes(CANARY_SECRET),
        });
        const outHeaders: Record<string, string> = {};
        upstream.headers.forEach((v, k) => {
          if (
            !['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)
          )
            outHeaders[k] = v;
        });
        res.writeHead(upstream.status, outHeaders);
        res.end(text);
      } catch (err) {
        wire.push({
          label,
          model,
          status: 0,
          at,
          usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
          leaked: body.includes(CANARY_SECRET),
        });
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'canary_forwarder', message: String(err) } }));
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---------------------------------------------------------------------------
// One model: run-evals through the forwarder, then attribute the wire by label.
// ---------------------------------------------------------------------------

function runEvals(target: Target, base: string, outDir: string): Promise<number> {
  const urlEnv = target.provider === 'anthropic' ? 'PUSH_ANTHROPIC_URL' : 'PUSH_DEEPSEEK_URL';
  const keyEnv =
    target.provider === 'anthropic' ? 'PUSH_ANTHROPIC_API_KEY' : 'PUSH_DEEPSEEK_API_KEY';
  const gatewayPath =
    target.provider === 'anthropic' ? 'anthropic/v1/messages' : 'deepseek/anthropic/v1/messages';
  const env = {
    ...process.env,
    [urlEnv]: `${base}/${target.label}/${gatewayPath}`,
    [keyEnv]: 'via-canary-forwarder',
    // Parity with the bake-off: no server-side tools for the model.
    PUSH_ANTHROPIC_WEB_SEARCH: '0',
  };
  // Node + the tsx loader directly, with no shell: a shell would split
  // multi-word values such as the label into separate arguments.
  const args = [
    '--import',
    'tsx',
    path.join(SCRIPT_DIR, 'run-evals.ts'),
    '--provider',
    target.provider,
    '--model',
    target.model,
    '--tasks',
    values.tasks as string,
    '--out',
    outDir,
    '--label',
    `canary ${target.label}`,
  ];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function readTrials(
  outDir: string,
): Promise<Array<{ completed: boolean; outcome: string; acceptancePassed: boolean | null }>> {
  const files = (await fs.readdir(outDir).catch(() => [])).filter((f) => f.endsWith('.jsonl'));
  const trials = [];
  for (const f of files) {
    for (const line of (await fs.readFile(path.join(outDir, f), 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.kind === 'trial') trials.push(row);
    }
  }
  return trials;
}

async function runTarget(target: Target, base: string, stampDir: string): Promise<ModelResult> {
  const outDir = path.join(stampDir, target.label);
  await fs.mkdir(outDir, { recursive: true });
  process.stderr.write(`canary: ${target.label} …\n`);
  const exit = await runEvals(target, base, outDir);
  const trials = await readTrials(outDir);
  const mine = wire.filter((w) => w.label === target.label);
  const usage = mine.reduce<Usage>(
    (u, w) => ({
      input: u.input + w.usage.input,
      cacheWrite: u.cacheWrite + w.usage.cacheWrite,
      cacheRead: u.cacheRead + w.usage.cacheRead,
      output: u.output + w.usage.output,
    }),
    { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
  );
  // Priced per request, so a run that straddles a DeepSeek peak boundary bills each side right.
  const costs = mine.map((w) => costOf(target.model, w.usage, w.at));
  const costUsd = costs.some((c) => c === null)
    ? null
    : costs.reduce<number>((s, c) => s + (c ?? 0), 0);
  const expected = (values.tasks as string).split(',').length;
  let error: string | null = null;
  if (trials.length === 0)
    error = `run-evals produced no trials (exit ${exit}; preflight may have failed)`;
  else if (trials.length < expected)
    error = `only ${trials.length}/${expected} trials recorded (exit ${exit})`;
  return {
    label: target.label,
    provider: target.provider,
    model: target.model,
    trials: Math.max(trials.length, expected),
    completed: trials.filter((t) => t.completed).length,
    falseSuccess: trials.filter((t) => t.outcome === 'success' && t.acceptancePassed === false)
      .length,
    requests: mine.length,
    failedRequests: mine.filter((w) => w.status < 200 || w.status >= 300).length,
    leakedRequests: mine.filter((w) => w.leaked).length,
    usage,
    costUsd,
    error,
  };
}

// ---------------------------------------------------------------------------
// Catalog drift: the provider's live model list against Push's catalog.
// ---------------------------------------------------------------------------

async function liveModels(
  url: string,
  extraHeaders: Record<string, string> = {},
): Promise<string[]> {
  const res = await fetch(url, { headers: { ...gatewayHeaders, ...extraHeaders } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { data?: Array<{ id: string }> };
  return (json.data ?? []).map((m) => m.id);
}

async function checkCatalogs(): Promise<CanaryReport['drift']> {
  const drift: CanaryReport['drift'] = {};
  const checks: Array<[string, () => Promise<CatalogDrift>]> = [
    [
      'anthropic',
      async () =>
        catalogDrift(
          await liveModels(`${GATEWAY}/anthropic/v1/models?limit=100`, {
            'anthropic-version': '2023-06-01',
          }),
          ANTHROPIC_MODELS,
          true,
        ),
    ],
    [
      'deepseek',
      async () =>
        catalogDrift(await liveModels(`${GATEWAY}/deepseek/models`), DEEPSEEK_MODELS, false),
    ],
  ];
  for (const [provider, check] of checks) {
    try {
      drift[provider] = await check();
    } catch (err) {
      drift[provider] = { error: String((err as Error).message ?? err) };
    }
  }
  return drift;
}

function notify(title: string, text: string): void {
  if (process.platform !== 'win32') return;
  const esc = (s: string) => s.replace(/'/g, "''").replace(/[<>&]/g, ' ');
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    `$t.GetElementsByTagName('text')[0].AppendChild($t.CreateTextNode('${esc(title)}')) | Out-Null`,
    `$t.GetElementsByTagName('text')[1].AppendChild($t.CreateTextNode('${esc(text)}')) | Out-Null`,
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Push canary').Show([Windows.UI.Notifications.ToastNotification]::new($t))",
  ].join('; ');
  spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const resultsDir = path.join(SCRIPT_DIR, 'results');
  const stampDir = path.join(resultsDir, `canary-${stamp}`);
  const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).stdout.trim();

  const server = await startForwarder();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const results: ModelResult[] = [];
  try {
    for (const target of pickMatrix()) results.push(await runTarget(target, base, stampDir));
  } finally {
    server.close();
  }
  const report: CanaryReport = {
    startedAt: startedAt.toISOString(),
    commit,
    results,
    drift: await checkCatalogs(),
  };
  const md = renderReport(report);
  await fs.writeFile(path.join(resultsDir, `canary-${stamp}.md`), md, 'utf8');
  await fs.writeFile(
    path.join(resultsDir, `canary-${stamp}.json`),
    JSON.stringify(report, null, 2),
    'utf8',
  );
  process.stdout.write(md);

  const red = failures(report);
  if (red.length && values.notify) notify('Push canary is RED', red.slice(0, 2).join('; '));
  process.exit(red.length ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`canary: ${String(err?.stack ?? err)}\n`);
  if (values.notify) notify('Push canary crashed', String(err?.message ?? err));
  process.exit(1);
});
