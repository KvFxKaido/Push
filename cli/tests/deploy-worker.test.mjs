// Deploy wrapper (scripts/deploy-worker.mjs). The retry itself needs a live
// registry; these pin which failures it retries. Fixtures are the tails of the
// real 2026-10-25/26 production build logs, account id and upload ids redacted.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isRetryablePushFailure } from '../../scripts/deploy-worker.mjs';

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
