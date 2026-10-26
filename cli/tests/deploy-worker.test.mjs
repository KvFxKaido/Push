// Deploy wrapper (scripts/deploy-worker.mjs). The classifier tests pin which
// failures it retries; fixtures are the tails of the real 2026-10-25/26
// production build logs, account id and upload ids redacted. The entry-point
// tests run the script itself against a fake `npx` on PATH, so no registry.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isRetryablePushFailure } from '../../scripts/deploy-worker.mjs';

const SCRIPT = path.join(import.meta.dirname, '..', '..', 'scripts', 'deploy-worker.mjs');

const pushHeader = [
  'Image does not exist remotely, pushing: registry.cloudflare.com/<acct>/push-sandbox-sandbox:wrangler-mvobphni',
  'The push refers to repository [registry.cloudflare.com/<acct>/push-sandbox-sandbox]',
  '4afda7e4a767: Layer already exists',
  'c7144c5eae60: Pushed',
].join('\n');

const headerTimeout = [
  pushHeader,
  'failed commit on ref "layer-sha256:ae21d7d43a0f6218a7f6726d892cd2bdfc533b876b945bb65ec2599635849ff9": failed to do request: Put "https://registry.cloudflare.com/v2/<acct>/push-sandbox-sandbox/blobs/uploads/<upload>?digest=sha256%3Aae21d7d4": net/http: timeout awaiting response headers',
  'Error response from daemon: No such image: push-sandbox-sandbox:wrangler-mvobphni',
  '✘ [ERROR] Docker command exited with code: 1',
].join('\n');

test('retries the observed registry blob-commit timeout', () => {
  assert.equal(isRetryablePushFailure(headerTimeout), true);
});

test('retries other transport failures on the registry push', () => {
  const reset = `${pushHeader}\nPut "https://registry.cloudflare.com/v2/x/blobs/uploads/y": read tcp 10.0.0.1:443: connection reset by peer`;
  assert.equal(isRetryablePushFailure(reset), true);
});

test('does not retry once the Worker upload has happened', () => {
  const after = `${headerTimeout}\nUploaded push (285.03 sec)\n✘ [ERROR] something after upload`;
  assert.equal(isRetryablePushFailure(after), false);
});

test('does not retry a Docker build failure', () => {
  const buildFail = [
    '#23 [stage-2 15/19] RUN pnpm install --frozen-lockfile',
    '#23 ERROR: process "/bin/sh -c pnpm install --frozen-lockfile" did not complete successfully: exit code: 1',
    '✘ [ERROR] Docker command exited with code: 1',
  ].join('\n');
  assert.equal(isRetryablePushFailure(buildFail), false);
});

test('does not retry a timeout that is not the registry push', () => {
  assert.equal(
    isRetryablePushFailure(
      'fetch https://api.cloudflare.com/...: net/http: timeout awaiting response headers',
    ),
    false,
  );
});

test('does not retry a registry refusal (auth, quota) without a transport failure', () => {
  const denied = `${pushHeader}\nunauthorized: authentication required\n✘ [ERROR] Docker command exited with code: 1`;
  assert.equal(isRetryablePushFailure(denied), false);
});

test('does not retry a refused blob commit (401/403)', () => {
  const url =
    'https://registry.cloudflare.com/v2/<acct>/push-sandbox-sandbox/blobs/uploads/<upload>?digest=sha256%3Aae21d7d4';
  for (const status of ['401 Unauthorized', '403 Forbidden']) {
    for (const line of [
      `failed commit on ref "layer-sha256:ae21d7d4": unexpected status from PUT request to ${url}: ${status}`,
      `failed commit on ref "layer-sha256:ae21d7d4": failed to do request: Put "${url}": ${status}`,
    ]) {
      assert.equal(isRetryablePushFailure(`${pushHeader}\n${line}`), false, line);
    }
  }
});

test('does not retry a timeout on a line other than the registry request', () => {
  const elsewhere = `${pushHeader}\nGET https://api.cloudflare.com/client/v4/x: net/http: timeout awaiting response headers`;
  assert.equal(isRetryablePushFailure(elsewhere), false);
});

// --- Entry point: the script run as the deploy command, with a fake `npx`. ---

// Each attempt pops the next outcome: 'timeout' (the observed registry
// failure), 'build' (a non-retryable failure) or 'ok'. It records its argv.
const FAKE_NPX = `
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'));
state.calls.push(process.argv.slice(2));
const outcome = state.outcomes[state.calls.length - 1] ?? 'ok';
fs.writeFileSync(process.env.FAKE_STATE, JSON.stringify(state));
if (outcome === 'timeout') {
  console.error('failed commit on ref "layer-sha256:ab": failed to do request: Put "https://registry.cloudflare.com/v2/x/blobs/uploads/y": net/http: timeout awaiting response headers');
  process.exit(1);
}
if (outcome === 'build') {
  console.error('#23 ERROR: exit code: 1');
  process.exit(7);
}
console.log('Uploaded push (1.00 sec)');
`;

function runDeploy(outcomes, { attempts } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'deploy-worker-'));
  try {
    writeFileSync(path.join(dir, 'fake-npx.cjs'), FAKE_NPX);
    // `npx` for POSIX (spawned directly), `npx.cmd` for Windows (via cmd.exe).
    writeFileSync(path.join(dir, 'npx'), "#!/usr/bin/env node\nrequire('./fake-npx.cjs');\n");
    chmodSync(path.join(dir, 'npx'), 0o755);
    writeFileSync(path.join(dir, 'npx.cmd'), '@node "%~dp0fake-npx.cjs" %*\r\n');
    const statePath = path.join(dir, 'state.json');
    writeFileSync(statePath, JSON.stringify({ outcomes, calls: [] }));

    const env = { ...process.env, FAKE_STATE: statePath, PUSH_DEPLOY_RETRY_BASE_MS: '0' };
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    env[pathKey] = `${dir}${path.delimiter}${env[pathKey] ?? ''}`;
    if (attempts) env.PUSH_DEPLOY_ATTEMPTS = String(attempts);
    else delete env.PUSH_DEPLOY_ATTEMPTS;

    const r = spawnSync(process.execPath, [SCRIPT, '--minify'], { env, encoding: 'utf8' });
    const { calls } = JSON.parse(readFileSync(statePath, 'utf8'));
    return { status: r.status, calls, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('entry point: retries the push timeout and succeeds, forwarding args', () => {
  const { status, calls, stderr } = runDeploy(['timeout', 'ok']);
  assert.equal(status, 0);
  assert.deepEqual(calls, [
    ['wrangler', 'deploy', '--minify'],
    ['wrangler', 'deploy', '--minify'],
  ]);
  assert.match(stderr, /"event":"deploy_retry_succeeded","attempt":2/);
});

test('entry point: stops after PUSH_DEPLOY_ATTEMPTS and exits non-zero', () => {
  const { status, calls, stderr } = runDeploy(['timeout', 'timeout', 'timeout', 'ok'], {
    attempts: 2,
  });
  assert.equal(status, 1);
  assert.equal(calls.length, 2);
  assert.match(stderr, /"event":"deploy_retry_exhausted","attempt":2/);
});

test("entry point: a non-retryable failure runs once and keeps wrangler's exit code", () => {
  const { status, calls, stderr } = runDeploy(['build', 'ok']);
  assert.equal(status, 7);
  assert.equal(calls.length, 1);
  assert.match(stderr, /"event":"deploy_failed_not_retryable","attempt":1,"code":7/);
});
