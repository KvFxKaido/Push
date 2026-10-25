// Runs the Pi arm once against a local `wrangler dev` and writes
// results/pi/<runId>.json (the shared run record) and <runId>.transcript.json (pi's own record).
//
//   node run.mjs                 start a run and wait for it
//   node run.mjs --resume <id>   wait for a run started earlier (after killing and restarting wrangler dev)
//   node run.mjs --status <id>   print what pi has not settled yet
//
// PI_ARM_URL overrides the dev server URL (default http://127.0.0.1:8787).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.env.PI_ARM_URL ?? 'http://127.0.0.1:8787';
const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'results', 'pi');
const [flag, id] = process.argv.slice(2);

async function call(method, path) {
  const res = await fetch(base + path, { method });
  const body = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${body}`);
  return JSON.parse(body);
}

if (flag === '--status') {
  console.log(JSON.stringify(await call('GET', `/runs/${id}/status`), null, 2));
  process.exit(0);
}

let runId = id;
if (flag !== '--resume') {
  const receipt = await call('POST', '/run?wait=0');
  runId = receipt.runId;
  console.error(JSON.stringify({ level: 'info', event: 'pi_run_submitted', ...receipt }));
}
if (!runId) throw new Error('usage: node run.mjs [--resume <runId> | --status <runId>]');

// Blocks until pi settles the operation, then the DO runs the host-side checks.
const { record, transcript } = await call('GET', `/runs/${runId}/result`);
mkdirSync(outDir, { recursive: true });
const transcriptPath = join(outDir, `${runId}.transcript.json`);
writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2));
writeFileSync(
  join(outDir, `${runId}.json`),
  JSON.stringify({ ...record, transcriptPath }, null, 2),
);
console.error(
  JSON.stringify({
    level: 'info',
    event: 'pi_run_written',
    runId,
    testExit: record.verify.testExit,
    toolCalls: record.toolCalls.length,
    file: join(outDir, `${runId}.json`),
  }),
);
