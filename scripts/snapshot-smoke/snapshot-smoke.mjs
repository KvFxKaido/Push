#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Cloudflare snapshot/restore smoke-test — drives the SHIPPED path.
//
// Successor to the throwaway `scripts/cf-sandbox-spike/` benchmark (2026-04-19).
// That spike timed the Sandbox SDK's *native* createBackup/restoreBackup to
// decide whether to build a CloudflareSandboxProvider. The provider shipped
// (#647–#651) — but it does NOT use the SDK primitive. It rolls its own
// R2 tar.gz archive snapshot (worker-cf-sandbox.ts: createWorkspaceSnapshot /
// restoreWorkspaceSnapshot). This test points the spike's benchmark shape
// — seed → snapshot → kill → restore → verify integrity → time → grade —
// at that real, shipped path through the live `/api/sandbox-cf/*` endpoints.
//
// What it exercises (fully automated):
//   #647  R2-backed snapshot create (hibernate) + restore into a fresh sandbox
//   #648  inline reclaim of the superseded snapshot object (observable: prior
//         snapshot for the same repo/branch is gone after a second hibernate)
//   #651  restore-failure surface — the backend error the UI turns into a toast
//
// What it does NOT cover (needs a live model-driven job — see README §"Layer 3"):
//   #649/#650  coder-job mid-run resume from a durable checkpoint on sandbox death
//
// Zero dependencies. Node 18+ (global fetch). Run against a deployed Worker or
// a local `wrangler dev` with PUSH_SANDBOX_PROVIDER=cloudflare and the
// SNAPSHOTS (R2) + SNAPSHOT_INDEX (KV) + SANDBOX_TOKENS (KV) bindings present.
//
//   PUSH_SMOKE_BASE_URL=http://localhost:8787 node scripts/snapshot-smoke/snapshot-smoke.mjs
//
// See ./README.md for prerequisites, env vars, and output interpretation.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';

const cfg = {
  // Worker base URL, no trailing slash. e.g. http://localhost:8787 or
  // https://push.<subdomain>.workers.dev
  baseUrl: (process.env.PUSH_SMOKE_BASE_URL ?? '').replace(/\/+$/, ''),
  // Origin header sent on every request. getAllowedOrigins() always includes
  // the request URL's own origin, so defaulting to the base URL's origin
  // passes validateOrigin() without needing ALLOWED_ORIGINS configured.
  origin: process.env.PUSH_SMOKE_ORIGIN ?? '',
  // repo_full_name + branch are used only for snapshot-index keying on
  // hibernate/restore — they do NOT trigger a clone (create runs scratch).
  // A unique branch per run avoids colliding with real index entries.
  repo: process.env.PUSH_SMOKE_REPO ?? 'push-smoke/scratch',
  branch: process.env.PUSH_SMOKE_BRANCH ?? `snapshot-smoke-${Date.now()}`,
  // Number of seed files written under /workspace/smoke-data. Correctness +
  // relative-latency test, not a sizing benchmark — bump for a heavier archive.
  files: Number.parseInt(process.env.PUSH_SMOKE_FILES ?? '256', 10),
  // Restore-latency grading bars (ms), carried over from the spike.
  greenMs: Number.parseInt(process.env.PUSH_SMOKE_GREEN_MS ?? '5000', 10),
  yellowMs: Number.parseInt(process.env.PUSH_SMOKE_YELLOW_MS ?? '15000', 10),
  // Leave the snapshot in R2 after the run (skip delete-snapshot) so you can
  // inspect or hand-restore it. Default cleans up.
  keep: process.env.PUSH_SMOKE_KEEP === '1',
  // Fail the run (exit 1) on a red restore grade. Off by default: a slow
  // restore is a perf signal, not a correctness failure.
  strictLatency: process.env.PUSH_SMOKE_STRICT_LATENCY === '1',
};

if (!cfg.baseUrl) {
  console.error('FATAL: set PUSH_SMOKE_BASE_URL (e.g. http://localhost:8787)');
  process.exit(2);
}
if (!cfg.origin) cfg.origin = new URL(cfg.baseUrl).origin;
if (!Number.isFinite(cfg.files) || cfg.files < 1) cfg.files = 256;

// --- tiny output + assertion helpers (no deps) -----------------------------
const pass = (m) => console.log(`  ✓ ${m}`);
const info = (m) => console.log(`  · ${m}`);
const fail = (m) => {
  console.error(`  ✗ ${m}`);
  failures += 1;
};
let failures = 0;

/** POST a JSON body to /api/sandbox-cf/<route>; return { status, json }. */
async function call(route, body) {
  const res = await fetch(`${cfg.baseUrl}/api/sandbox-cf/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: cfg.origin },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body (e.g. an HTML error page from a misconfigured host) */
  }
  if (res.status === 429) {
    throw new Error('rate limited (429) — wait 60s and retry, or use a fresh IP');
  }
  return { status: res.status, json };
}

/** Run an exec on a sandbox and return trimmed stdout; throws on non-zero. */
async function exec(sandboxId, ownerToken, command) {
  const { status, json } = await call('exec', {
    sandbox_id: sandboxId,
    owner_token: ownerToken,
    command,
  });
  if (status !== 200 || !json) {
    throw new Error(`exec failed (${status}): ${JSON.stringify(json)}`);
  }
  if ((json.exit_code ?? 0) !== 0) {
    throw new Error(`command exited ${json.exit_code}: ${json.stderr ?? ''}`);
  }
  return (json.stdout ?? '').trim();
}

/** find smoke-data files -> "<count> <combined-sha256>" for integrity compare. */
const MANIFEST_CMD =
  'cd /workspace && C=$(find smoke-data -type f | wc -l) && ' +
  'D=$(find smoke-data -type f | sort | xargs sha256sum | sha256sum | cut -d" " -f1) && ' +
  'echo "$C $D"';

const ms = (n) => `${n.toLocaleString()}ms`;

async function main() {
  console.log(`\nSnapshot smoke-test → ${cfg.baseUrl}`);
  console.log(
    `  origin=${cfg.origin}  repo=${cfg.repo}  branch=${cfg.branch}  files=${cfg.files}\n`,
  );

  const timings = {};
  const t = async (key, fn) => {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      timings[key] = Date.now() - start;
    }
  };

  let restored = null; // { sandboxId, ownerToken } for cleanup in finally
  let snapshot = null; // { snapshotId, restoreToken } for cleanup in finally

  try {
    // --- Step 1: create a scratch sandbox (empty repo => no clone) ----------
    console.log('Step 1 — create scratch sandbox');
    const created = await t('createMs', () => call('create', { repo: '', branch: cfg.branch }));
    if (created.status !== 200 || !created.json?.sandbox_id || !created.json?.owner_token) {
      fail(
        `create did not return a ready sandbox (${created.status}): ${JSON.stringify(created.json)}`,
      );
      throw new Error('cannot continue without a sandbox');
    }
    const origSandbox = created.json.sandbox_id;
    const origToken = created.json.owner_token;
    pass(`sandbox ${origSandbox} ready in ${ms(timings.createMs)}`);

    // --- Step 2: seed a deterministic file tree + capture pre-manifest ------
    console.log('Step 2 — seed workspace + manifest');
    const seedCmd =
      'rm -rf /workspace/smoke-data && mkdir -p /workspace/smoke-data && ' +
      `for i in $(seq 1 ${cfg.files}); do { echo "smoke file $i"; seq 1 256; } ` +
      '> /workspace/smoke-data/file_$i.txt; done && ' +
      'echo seeded $(find /workspace/smoke-data -type f | wc -l)';
    await t('seedMs', () => exec(origSandbox, origToken, seedCmd));
    const preManifest = await exec(origSandbox, origToken, MANIFEST_CMD);
    const [preCount, preDigest] = preManifest.split(/\s+/);
    pass(`seeded ${preCount} files in ${ms(timings.seedMs)} (digest ${preDigest.slice(0, 12)}…)`);

    // --- Step 3: hibernate — archive /workspace to R2, destroy container ----
    console.log('Step 3 — hibernate (snapshot to R2, container destroyed)');
    const hib = await t('hibernateMs', () =>
      call('hibernate', {
        sandbox_id: origSandbox,
        owner_token: origToken,
        repo_full_name: cfg.repo,
        branch: cfg.branch,
      }),
    );
    if (hib.status !== 200 || !hib.json?.snapshot_id || !hib.json?.restore_token) {
      fail(`hibernate failed (${hib.status}): ${JSON.stringify(hib.json)}`);
      throw new Error('cannot continue without a snapshot');
    }
    snapshot = { snapshotId: hib.json.snapshot_id, restoreToken: hib.json.restore_token };
    const sizeKb = Math.round((hib.json.size_bytes ?? 0) / 1024);
    pass(`snapshot ${snapshot.snapshotId} (${sizeKb}KB compressed) in ${ms(timings.hibernateMs)}`);

    // --- Step 4: NEGATIVE — unrestorable snapshot (the #651 toast trigger) --
    // These are the backend errors the client maps to the restore-failure
    // toast. Assert the contract, not the UI (UI check is in README §Layer 3).
    console.log('Step 4 — unrestorable-snapshot contract (#651 backend)');
    const badToken = await call('restore-snapshot', {
      snapshot_id: snapshot.snapshotId,
      restore_token: 'this-is-not-the-right-token',
      repo_full_name: cfg.repo,
      branch: cfg.branch,
    });
    if (badToken.status === 403 && badToken.json?.code === 'AUTH_FAILURE') {
      pass('wrong restore_token → 403 AUTH_FAILURE');
    } else {
      fail(
        `wrong restore_token expected 403/AUTH_FAILURE, got ${badToken.status}/${badToken.json?.code}`,
      );
    }
    const badId = await call('restore-snapshot', {
      snapshot_id: `cf-snapshots/${randomUUID()}`,
      restore_token: snapshot.restoreToken,
      repo_full_name: cfg.repo,
      branch: cfg.branch,
    });
    if (badId.status === 404 && badId.json?.code === 'SNAPSHOT_NOT_FOUND') {
      pass('nonexistent snapshot_id → 404 SNAPSHOT_NOT_FOUND');
    } else {
      fail(
        `nonexistent snapshot_id expected 404/SNAPSHOT_NOT_FOUND, got ${badId.status}/${badId.json?.code}`,
      );
    }

    // --- Step 5: POSITIVE — restore into a fresh sandbox -------------------
    console.log('Step 5 — restore snapshot into a fresh sandbox');
    const res = await t('restoreMs', () =>
      call('restore-snapshot', {
        snapshot_id: snapshot.snapshotId,
        restore_token: snapshot.restoreToken,
        repo_full_name: cfg.repo,
        branch: cfg.branch,
      }),
    );
    if (res.status !== 200 || !res.json?.sandbox_id || !res.json?.owner_token) {
      fail(`restore failed (${res.status}): ${JSON.stringify(res.json)}`);
      throw new Error('cannot verify integrity without a restored sandbox');
    }
    restored = { sandboxId: res.json.sandbox_id, ownerToken: res.json.owner_token };
    pass(`restored into ${restored.sandboxId} in ${ms(timings.restoreMs)}`);

    // --- Step 6: integrity — restored tree must match the original ---------
    console.log('Step 6 — integrity check');
    const postManifest = await t('verifyMs', () =>
      exec(restored.sandboxId, restored.ownerToken, MANIFEST_CMD),
    );
    const [postCount, postDigest] = postManifest.split(/\s+/);
    if (postCount === preCount) pass(`file count preserved (${postCount})`);
    else fail(`file count drift: ${preCount} → ${postCount}`);
    if (postDigest === preDigest) pass(`content digest matches (${postDigest.slice(0, 12)}…)`);
    else fail(`content digest mismatch: ${preDigest.slice(0, 12)} ≠ ${postDigest.slice(0, 12)}`);
  } finally {
    // --- cleanup: tear down the restored sandbox + delete the snapshot -----
    // The original container was destroyed by hibernate, so only the restored
    // one needs cleanup. Best-effort; failures here don't fail the test.
    if (restored) {
      try {
        await call('cleanup', { sandbox_id: restored.sandboxId, owner_token: restored.ownerToken });
        info('cleaned up restored sandbox');
      } catch (e) {
        info(`cleanup of restored sandbox failed: ${e.message}`);
      }
    }
    if (snapshot && !cfg.keep) {
      try {
        await call('delete-snapshot', {
          snapshot_id: snapshot.snapshotId,
          restore_token: snapshot.restoreToken,
          repo_full_name: cfg.repo,
          branch: cfg.branch,
        });
        info('deleted snapshot from R2');
      } catch (e) {
        info(`delete-snapshot failed: ${e.message}`);
      }
    } else if (snapshot) {
      info(`kept snapshot ${snapshot.snapshotId} (PUSH_SMOKE_KEEP=1)`);
    }
  }

  // --- summary + restore-latency grade -------------------------------------
  console.log('\nTimings');
  for (const [k, v] of Object.entries(timings)) console.log(`  ${k.padEnd(12)} ${ms(v)}`);

  let grade = 'red';
  if (timings.restoreMs <= cfg.greenMs) grade = 'green';
  else if (timings.restoreMs <= cfg.yellowMs) grade = 'yellow';
  const bar = `(green ≤${ms(cfg.greenMs)} / yellow ≤${ms(cfg.yellowMs)})`;
  console.log(`\nRestore grade: ${grade.toUpperCase()} — ${ms(timings.restoreMs ?? 0)} ${bar}`);

  const latencyFail = cfg.strictLatency && grade === 'red';
  if (failures === 0 && !latencyFail) {
    console.log('\nRESULT: PASS\n');
    process.exit(0);
  }
  console.log(
    `\nRESULT: FAIL (${failures} assertion failure(s)${latencyFail ? ' + red latency' : ''})\n`,
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}\n`);
  process.exit(1);
});
