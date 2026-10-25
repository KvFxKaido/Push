// Push arm: run the bake-off task through Push's own headless lead loop.
//
// Push runs against a fresh temp copy of the fixture with a throwaway HOME, so
// it never reads or writes the real ~/.push. Its model traffic goes through the
// bake-off proxy (http://127.0.0.1:8789/push), which supplies credentials.
//
// Usage: node spikes/harness-bakeoff/arms/push/run.mjs   (proxy must be running)
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL, TASK_PROMPT } from '../../shared/task.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const spikeRoot = resolve(here, '..', '..');
// BAKEOFF_PUSH_ROOT runs another checkout's CLI (e.g. a fix branch) against the
// same fixture and proxy; the default is the spike's own worktree.
const repoRoot = process.env.BAKEOFF_PUSH_ROOT ?? resolve(spikeRoot, '..', '..');
const proxyBase = process.env.BAKEOFF_PROXY_URL ?? 'http://127.0.0.1:8789';

// BAKEOFF_ARM_LABEL files a variant (e.g. push-fixed, with a patched lib/)
// separately from stock Push; the proxy path stays /push either way.
const armLabel = process.env.BAKEOFF_ARM_LABEL ?? 'push';
const runId = `${armLabel}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const scratch = mkdtempSync(join(tmpdir(), 'bakeoff-push-'));
const work = join(scratch, 'workspace');
const fakeHome = join(scratch, 'home');
mkdirSync(fakeHome, { recursive: true });

// Same starting state the container arms get from reset-workspace.
cpSync(join(spikeRoot, 'fixture'), work, { recursive: true });
git(['init', '-q', '-b', 'main']);
git(['add', '-A']);
git(['-c', 'user.name=bakeoff', '-c', 'user.email=bakeoff@invalid', 'commit', '-qm', 'fixture']);

// BAKEOFF_MODEL swaps the model (e.g. an id off Push's catalog to force
// text-dispatch tools); BAKEOFF_ACCEPT adds an --accept check to the run.
const model = process.env.BAKEOFF_MODEL ?? MODEL;
const args = [
  '--import',
  'tsx',
  join(repoRoot, 'cli', 'cli.ts'),
  'run',
  '--task',
  TASK_PROMPT,
  '--provider',
  'anthropic',
  '--model',
  model,
  ...(process.env.BAKEOFF_ACCEPT ? ['--accept', process.env.BAKEOFF_ACCEPT] : []),
  '--cwd',
  work,
  '--allow-exec',
  '--max-rounds',
  '30',
  '--jsonl',
];
const env = {
  ...process.env,
  HOME: fakeHome,
  USERPROFILE: fakeHome,
  PUSH_TUI_ENABLED: '0',
  // Headless ignores --url and --api-key (found by this spike; both are in
  // --help), so the endpoint and key go in through env. The proxy drops the key
  // and supplies the real credential upstream.
  PUSH_ANTHROPIC_URL: `${proxyBase}/push/${runId}/v1/messages`,
  PUSH_ANTHROPIC_API_KEY: 'via-bakeoff-proxy',
  // Parity: the other arms' model gets no server-side tools.
  PUSH_ANTHROPIC_WEB_SEARCH: '0',
};

const startedAt = new Date();
const { stdout, stderr, code } = await run(process.execPath, args, { cwd: repoRoot, env });
const wallMs = Date.now() - startedAt.getTime();

const events = stdout
  .split('\n')
  .filter((line) => line.startsWith('{'))
  .map((line) => JSON.parse(line));

// Pair each tool start with its completion. Push runs read-only calls in
// parallel and completes them in start order, so match the oldest open call.
const toolCalls = [];
for (const event of events) {
  if (event.type === 'tool.execution_start') {
    toolCalls.push({ name: event.payload.toolName, input: event.payload.args, output: '' });
  } else if (event.type === 'tool.execution_complete') {
    const open = toolCalls.find((c) => c.name === event.payload.toolName && c.output === '');
    const text = event.payload.text ?? event.payload.preview ?? '';
    if (open) open.output = (event.payload.isError ? '[error] ' : '') + text;
  }
}
const done = events.findLast((e) => e.type === 'run_complete');

// Host-side verification: never trust the agent's own claim of success.
const test = spawnSync('npm test', { cwd: work, encoding: 'utf8', shell: true });
const verify = {
  testExit: test.status ?? -1,
  testOutput: (test.stdout ?? '') + (test.stderr ?? ''),
  diff: git(['diff', '--', '.', ':(exclude)test']),
  testsDiff: git(['diff', '--', 'test']),
};

// Native record: the JSONL stream as Push emitted it, plus Push's own session files.
const outDir = join(spikeRoot, 'results', armLabel);
mkdirSync(outDir, { recursive: true });
const transcriptPath = join(outDir, `${runId}.transcript.json`);
writeFileSync(
  transcriptPath,
  JSON.stringify({ jsonl: events, stderr, exitCode: code, sessions: readSessions() }, null, 2),
);

const record = {
  arm: armLabel,
  runId,
  model,
  startedAt: startedAt.toISOString(),
  wallMs,
  finalText: done?.payload?.summary ?? '',
  toolCalls,
  // Filled from the proxy's wire log by score.mjs, the same meter for every arm.
  usage: { inputTokens: null, outputTokens: null },
  verify,
  transcriptPath,
  notes: [
    `push exit code ${code}`,
    `outcome ${done?.payload?.outcome ?? 'none'}`,
    `scratch ${scratch}`,
  ],
};
writeFileSync(join(outDir, `${runId}.json`), JSON.stringify(record, null, 2));
console.log(
  `${runId}: tests ${verify.testExit === 0 ? 'PASS' : 'FAIL'}, ${toolCalls.length} tool calls, ${Math.round(wallMs / 1000)}s`,
);

function git(gitArgs) {
  const result = spawnSync('git', gitArgs, { cwd: work, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${gitArgs.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function readSessions() {
  const dir = join(fakeHome, '.push', 'sessions');
  try {
    return readdirSync(dir, { recursive: true })
      .filter((f) => String(f).endsWith('.json') || String(f).endsWith('.jsonl'))
      .map((f) => ({ file: String(f), content: readFileSync(join(dir, String(f)), 'utf8') }));
  } catch {
    return [];
  }
}

function run(cmd, cmdArgs, options) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, cmdArgs, options);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (exitCode) => resolvePromise({ stdout: out, stderr: err, code: exitCode }));
  });
}
