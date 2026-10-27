#!/usr/bin/env node
/**
 * deploy-worker.mjs — `wrangler deploy` with a bounded retry for one failure:
 * the sandbox image push to registry.cloudflare.com timing out.
 *
 * This is the Workers Builds deploy command for production (dashboard →
 * Workers Builds → Deploy command: `node scripts/deploy-worker.mjs`). Extra
 * arguments pass through to `wrangler deploy`.
 *
 * Why it exists: on 2026-10-25/26 two of ~8 production builds failed with
 *
 *   failed commit on ref "layer-sha256:…": failed to do request:
 *   Put "https://registry.cloudflare.com/v2/…/blobs/uploads/…?digest=…":
 *   net/http: timeout awaiting response headers
 *
 * Both times every other layer had already pushed, and the one that failed
 * was the last to finish: the final PUT that commits a large blob got no
 * response headers in time. The layer was a different digest each time, so
 * it's not one bad blob. wrangler runs a single bare `docker push` and does
 * not retry, so a human clicked Retry, which rebuilt from scratch (~7 min).
 *
 * Retrying here is cheaper than that. The image is still in the same Docker
 * daemon's build cache, so the rebuild is a cache hit with identical layer
 * digests. The registry answers "Layer already exists" for everything that
 * landed, and only the blob that timed out goes up again.
 *
 * Retries only when the output matches a registry push transport failure
 * AND the Worker upload never started. Any other failure (a build error, a
 * config error, a failure after `Uploaded <worker>`) exits on the first try
 * with wrangler's own code, so this never masks a real break or re-runs a
 * deploy that half-landed.
 *
 * Run: `node scripts/deploy-worker.mjs` (or `pnpm run deploy:worker`).
 * Env: PUSH_DEPLOY_ATTEMPTS (default 3, total attempts including the first);
 * PUSH_DEPLOY_RETRY_BASE_MS (default 15000; attempt N waits N × base).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A failed registry request, as Docker prints it: the method and URL, then the
// error, on one line.
const REGISTRY_REQUEST = /\b(?:PUT|POST|PATCH|HEAD|GET)\s+"?https:\/\/registry\.cloudflare\.com\//i;

// Transport-level failures: the request went out and the connection, not the
// registry's verdict, failed. Only the first was observed; the rest are the
// same class. An HTTP refusal (401, 403, quota) on the same request is not
// here on purpose, so it fails on the first try.
const TRANSIENT_PUSH_PATTERNS = [
  /timeout awaiting response headers/,
  /connection reset by peer/,
  /TLS handshake timeout/,
  /i\/o timeout/,
  /unexpected EOF/,
];

// wrangler prints this once the Worker script upload has finished. A failure
// after it is not an image-push failure and must not be retried blind.
const WORKER_UPLOADED = /^\s*Uploaded \S+ \(/m;

// Keep the tail of the output, where the failure lines are. A full build log
// runs to a few MB and only its last lines decide the classification.
const TAIL_BYTES = 64 * 1024;

/**
 * Decide whether a failed `wrangler deploy` attempt is the transient registry
 * push failure this wrapper retries.
 * @param {string} output combined stdout+stderr tail of the failed attempt
 */
export function isRetryablePushFailure(output) {
  if (WORKER_UPLOADED.test(output)) return false;
  // The transport error must be on the failed registry request's own line. A
  // registry URL earlier in the log plus a timeout anywhere else isn't proof.
  return output
    .split('\n')
    .some(
      (line) => REGISTRY_REQUEST.test(line) && TRANSIENT_PUSH_PATTERNS.some((re) => re.test(line)),
    );
}

function log(event, ctx) {
  console.error(JSON.stringify({ level: 'info', event, ...ctx }));
}

// Pinned: wrangler is not a project dependency, so a bare `npx wrangler` ran
// whatever release was newest on every production deploy. 4.153.0 (published
// 2026-10-26 14:24 UTC) coincides with every deploy failing "The Docker CLI is
// needed to build the configured image … but could not be launched", while
// 4.152.0 built the same tree. Bump deliberately, watching the first deploy.
const WRANGLER_VERSION = '4.152.0';

function runWranglerDeploy(args) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['--yes', `wrangler@${WRANGLER_VERSION}`, 'deploy', ...args], {
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let tail = '';
    const keep = (chunk) => {
      tail = (tail + chunk.toString('utf8')).slice(-TAIL_BYTES);
    };
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      keep(chunk);
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      keep(chunk);
    });
    child.on('error', (err) => {
      keep(Buffer.from(String(err)));
      resolve({ code: 1, tail });
    });
    child.on('close', (code, signal) => {
      resolve({ code: code ?? (signal ? 1 : 0), tail });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const parsed = Number.parseInt(process.env.PUSH_DEPLOY_ATTEMPTS ?? '', 10);
  const maxAttempts = Number.isFinite(parsed) && parsed >= 1 ? parsed : 3;
  const base = Number.parseInt(process.env.PUSH_DEPLOY_RETRY_BASE_MS ?? '', 10);
  const baseDelayMs = Number.isFinite(base) && base >= 0 ? base : 15_000;

  for (let attempt = 1; ; attempt++) {
    const { code, tail } = await runWranglerDeploy(args);
    if (code === 0) {
      if (attempt > 1) log('deploy_retry_succeeded', { attempt });
      return 0;
    }
    if (!isRetryablePushFailure(tail)) {
      log('deploy_failed_not_retryable', { attempt, code });
      return code;
    }
    if (attempt >= maxAttempts) {
      log('deploy_retry_exhausted', { attempt, code });
      return code;
    }
    const delayMs = baseDelayMs * attempt;
    log('deploy_retrying_image_push', { attempt, code, delayMs });
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
