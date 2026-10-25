// Drive the think arm running under `wrangler dev` and write its results.
//
//   node run.mjs                  POST /start, then poll /status until terminal
//   node run.mjs --sync           POST /run, one request held open for the whole turn
//                                 (Node's fetch gives up on headers after 300s)
//   node run.mjs --resume <runId> poll /status for an existing run (after a restart)
//
// Writes results/think/<runId>.json and results/think/<runId>.transcript.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.THINK_ARM_URL ?? 'http://127.0.0.1:8787';
const POLL_MS = 3000;
const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', '..', 'results', 'think');

const args = process.argv.slice(2);
let result;
if (args[0] !== '--sync') {
  let runId = args[1];
  if (args[0] !== '--resume') {
    const started = await call('POST', '/start');
    runId = started.runId;
    console.error(`started ${runId} (submission ${started.submissionId}, ${started.status})`);
  }
  if (!runId) throw new Error('usage: node run.mjs --resume <runId>');
  result = await poll(runId);
} else {
  console.error(`POST ${BASE}/run (blocks for the whole turn)`);
  result = await call('POST', '/run');
}

const { run, transcript } = result;
mkdirSync(outDir, { recursive: true });
const transcriptPath = join(outDir, `${run.runId}.transcript.json`);
writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2));
run.transcriptPath = transcriptPath;
writeFileSync(join(outDir, `${run.runId}.json`), JSON.stringify(run, null, 2));
console.error(
  `wrote ${join(outDir, `${run.runId}.json`)} (testExit ${run.verify.testExit}, ${run.toolCalls.length} tool calls)`,
);

async function poll(runId) {
  for (;;) {
    let status;
    try {
      status = await call('GET', `/status?runId=${encodeURIComponent(runId)}`);
    } catch (error) {
      // wrangler dev may be down mid-test (that is the point of --async); keep polling.
      console.error(`status unreachable: ${error.message}`);
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }
    if (status.run) return status;
    console.error(`${runId}: ${status.status}`);
    if (status.status === 'unknown' || status.status === 'missing')
      throw new Error(`no such run or submission: ${runId}`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function call(method, path) {
  const res = await fetch(BASE + path, { method });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}
