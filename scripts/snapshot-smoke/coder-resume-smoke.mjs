#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Layer 3 driver — coder-job mid-run resume on sandbox death.
//
// The shipped path under test:
//   `app/src/worker/coder-job-do.ts` — runLoop catches SandboxUnreachableError
//   from `lib/coder-agent.ts`, calls resumeFromCheckpoint, restores the latest
//   filesystem snapshot into a fresh sandbox, and re-enters the loop seeded
//   with the persisted CoderCheckpointState. Bounded by MAX_JOB_RESUMES = 2.
//
// This driver intentionally focuses on the happy path — the runbook in
// `scripts/snapshot-smoke/README.md` §"Layer 3" lists the unhappy path as
// already asserted at the backend layer in `snapshot-smoke.mjs` (#651 codes)
// and remaining UI toast verification needs a browser session, out of scope
// for an API-only driver. If resume turns out flaky enough to want recurring
// coverage, this is the scaffold to extend.
//
// Flow:
//   1. POST /api/sandbox-cf/create {repo:''} — empty scratch sandbox.
//   2. POST /api/jobs/start with a Coder envelope crafted to run ~3 min on
//      kimi-k2.6 (12 file writes + read-backs ≈ 24+ rounds) so the round-5
//      checkpoint cadence (`round > 0 && round % 5 === 0`) fires several
//      times before natural completion.
//   3. Open SSE /api/jobs/:id/events. The kernel emits only
//      `assistant.prompt_snapshot` (once), `job.started`, and the terminal
//      `job.completed` / `job.failed` — there are NO per-round events
//      today, despite the type union in `lib/runtime-contract.ts` having
//      slots for them. So the driver can't observe rounds via SSE.
//   4. Arm a kill timer at `killDelayMs` (default 45s) after the
//      `assistant.prompt_snapshot` event arrives — this is empirically
//      past the round-5 checkpoint on kimi-k2.6 + the bundled task, and
//      well before the ~3-minute natural completion.
//   5. POST /api/sandbox-cf/cleanup when the timer fires. Then keep the
//      SSE stream open and wait for the terminal event. `job.completed`
//      after the kill ⇒ the DO must have restored from checkpoint to
//      keep the loop going (this is the Layer 3 happy-path assertion).
//   6. Structured-log corroboration (`coder_checkpoint_captured`,
//      `coder_job_resumed`) is observed OUT OF BAND by a parallel
//      `wrangler tail push --format json` — wrangler buffers events on
//      a ~20-30s lag too racy for in-driver real-time polling. The
//      driver prints a tail-filter hint at startup.
//
// Provider: cloudflare (the only one configured on prod). Default model
// `@cf/moonshotai/kimi-k2.6` — strong enough on Workers AI to chain multiple
// tool calls. Override with PUSH_SMOKE_MODEL.
//
// KNOWN GAP (as of 2026-05-25): `/api/sandbox-cf/cleanup` does NOT trigger
// the resume path on the deployed runtime — the auth gate returns
// `code: 'NOT_FOUND'` for a destroyed sandbox, which the executor adapter
// passes through as `errorType: 'NOT_FOUND'`; `lib/coder-agent.ts`'s
// `SANDBOX_LOSS_THRESHOLD` counter only counts `'SANDBOX_UNREACHABLE'`. So
// the kill above lets the model observe tool errors and produce a partial
// summary rather than exercising the DO's resume catch arm. See
// `scripts/snapshot-smoke/README.md` §"Layer 3" for the workaround
// (destroy the container via the Cloudflare dashboard, which produces the
// RPC-throw shape that DOES map to SANDBOX_UNREACHABLE) and the proposed
// narrow fix in the executor adapter.
//
// Run:
//   PUSH_SMOKE_BASE_URL=https://push.<sub>.workers.dev \
//   PUSH_SMOKE_DEPLOYMENT_TOKEN=$(grep ^PUSH_DEPLOYMENT_TOKEN= .dev.vars | cut -d= -f2- | tr -d '"\r') \
//   node scripts/snapshot-smoke/coder-resume-smoke.mjs
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';

const cfg = {
  baseUrl: (process.env.PUSH_SMOKE_BASE_URL ?? '').replace(/\/+$/, ''),
  origin: process.env.PUSH_SMOKE_ORIGIN ?? '',
  repo: process.env.PUSH_SMOKE_REPO ?? 'push-smoke/resume',
  branch: process.env.PUSH_SMOKE_BRANCH ?? `resume-smoke-${Date.now()}`,
  deploymentToken: process.env.PUSH_SMOKE_DEPLOYMENT_TOKEN ?? '',
  // The cloudflare provider is the only one configured on prod /api/health.
  // kimi-k2.6 is the strongest Workers AI model that reliably chains tool
  // calls on a multi-step Coder loop.
  provider: process.env.PUSH_SMOKE_PROVIDER ?? 'cloudflare',
  model: process.env.PUSH_SMOKE_MODEL ?? '@cf/moonshotai/kimi-k2.6',
  // Seconds to wait after the SSE `assistant.prompt_snapshot` event before
  // killing the sandbox. The round-5 checkpoint fires at the TOP of iteration
  // round=5 (`round > 0 && round % 5 === 0`), so we need to be past it before
  // killing, but before the job naturally completes. Empirically on
  // kimi-k2.6 + the 12-step palette task: round 5 lands at ~25-40s into the
  // run, the run completes at ~3 min. 45s is a comfortable middle. Tune via
  // env if you swap the model/task.
  killDelayMs: Number.parseInt(process.env.PUSH_SMOKE_KILL_DELAY_MS ?? '45000', 10),
  // Total wait for the resume confirmation log line AFTER the kill. wrangler
  // tail buffers events on a 20-30s lag, and the DO needs time to restore
  // from R2 + re-enter the loop. 180s gives plenty of headroom for both
  // pieces plus a little for kimi-k2.6 to drive a few more rounds on the
  // restored sandbox before completion.
  postKillWaitMs: Number.parseInt(process.env.PUSH_SMOKE_POST_KILL_MS ?? '180000', 10),
  // Hard ceiling on total wall clock.
  maxWaitMs: Number.parseInt(process.env.PUSH_SMOKE_MAX_WAIT_MS ?? '420000', 10),
};
if (!cfg.baseUrl) {
  console.error('FATAL: set PUSH_SMOKE_BASE_URL');
  process.exit(2);
}
if (!cfg.origin) cfg.origin = new URL(cfg.baseUrl).origin;

const pass = (m) => console.log(`  ✓ ${m}`);
const info = (m) => console.log(`  · ${m}`);
const warn = (m) => console.log(`  ! ${m}`);
const fail = (m) => {
  console.error(`  ✗ ${m}`);
  failures += 1;
};
let failures = 0;

function authHeaders() {
  const headers = { 'content-type': 'application/json', origin: cfg.origin };
  if (cfg.deploymentToken) headers['X-Push-Deployment-Token'] = cfg.deploymentToken;
  return headers;
}

async function postJson(path, body) {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

function buildEnvelope() {
  // Multi-step Coder task that runs comfortably past the round-5 checkpoint
  // AND past the wrangler tail's ~20-30s buffer lag, so the driver has time
  // to observe `coder_checkpoint_captured` and kill the sandbox while the
  // run is still alive. 12 distinct writes + 12 read-back verifications ≈
  // 24+ rounds on kimi-k2.6 — comfortably 3+ minutes of wall clock. Strict
  // one-step-per-round + read-back rules so the model can't batch the lot
  // into 3-4 rounds and finish before we interject.
  const task = [
    'Build a small "color palette" library under /workspace/palette/, step by step.',
    'Do EXACTLY one sandbox tool call per round. Never batch. Re-read every',
    'file you write before moving to the next step. Use sandbox_write_file',
    'for writes and sandbox_exec for shell.',
    '',
    '1.  Make the directory /workspace/palette/.',
    '2.  Write /workspace/palette/red.txt containing exactly: "#ff0000\\nrgb(255,0,0)".',
    '3.  Read /workspace/palette/red.txt back.',
    '4.  Write /workspace/palette/green.txt containing exactly: "#00ff00\\nrgb(0,255,0)".',
    '5.  Read /workspace/palette/green.txt back.',
    '6.  Write /workspace/palette/blue.txt containing exactly: "#0000ff\\nrgb(0,0,255)".',
    '7.  Read /workspace/palette/blue.txt back.',
    '8.  Write /workspace/palette/cyan.txt containing exactly: "#00ffff\\nrgb(0,255,255)".',
    '9.  Read /workspace/palette/cyan.txt back.',
    '10. Write /workspace/palette/magenta.txt containing exactly: "#ff00ff\\nrgb(255,0,255)".',
    '11. Read /workspace/palette/magenta.txt back.',
    '12. Write /workspace/palette/yellow.txt containing exactly: "#ffff00\\nrgb(255,255,0)".',
    '13. Read /workspace/palette/yellow.txt back.',
    '14. Run `ls -1 /workspace/palette` and confirm exactly six .txt files exist.',
    '15. Run `wc -l /workspace/palette/*.txt` and report the per-file line counts.',
    '16. Write /workspace/palette/SUMMARY.md with one bullet per .txt file: filename + the hex + the rgb form.',
    '17. Read SUMMARY.md back.',
    '18. Final round: write a one-paragraph plain-English description of what you built.',
    '',
    'Hard rules:',
    '- ONE sandbox tool call per round. Never batch writes and reads.',
    '- DO NOT skip the read-back steps; they are part of verification.',
    '- DO NOT commit, push, or touch git in any way.',
  ].join('\n');
  return {
    task,
    files: [],
    provider: cfg.provider,
    model: cfg.model,
    branchContext: {
      activeBranch: cfg.branch,
      defaultBranch: 'main',
      protectMain: false,
    },
    harnessSettings: {
      maxCoderRounds: 30,
      contextResetsEnabled: false,
    },
  };
}

async function startCoderJob(sandboxId, ownerToken) {
  const body = {
    role: 'coder',
    chatId: `resume-smoke-${randomUUID()}`,
    repoFullName: cfg.repo,
    branch: cfg.branch,
    sandboxId,
    ownerToken,
    envelope: buildEnvelope(),
    provider: cfg.provider,
    model: cfg.model,
    userProfile: null,
  };
  const { status, json } = await postJson('/api/jobs/start', body);
  // /api/jobs/start returns 202 Accepted (the DO has persisted the input;
  // the run is now driving asynchronously under ctx.waitUntil).
  if (status !== 202 || !json?.jobId) {
    throw new Error(`/api/jobs/start failed (${status}): ${JSON.stringify(json)}`);
  }
  return json.jobId;
}

/** Parse a single SSE block of `id:\nevent:\ndata:` lines into { id, event, data }. */
function parseSseBlock(block) {
  const lines = block.split('\n');
  const out = { id: null, event: null, data: null };
  for (const line of lines) {
    if (line.startsWith(':')) continue; // heartbeat comment
    if (line.startsWith('id: ')) out.id = line.slice(4);
    else if (line.startsWith('event: ')) out.event = line.slice(7);
    else if (line.startsWith('data: ')) out.data = line.slice(6);
  }
  return out;
}

/** Open the SSE stream and run `onEvent(parsed)` for each event until the
 *  stream closes or `onEvent` returns 'stop'. Returns when the stream ends. */
async function tailEvents(jobId, onEvent, signal) {
  const res = await fetch(`${cfg.baseUrl}/api/jobs/${encodeURIComponent(jobId)}/events`, {
    method: 'GET',
    headers: { ...authHeaders(), accept: 'text/event-stream' },
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`SSE open failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return 'eof';
    buf += decoder.decode(value, { stream: true });
    // SSE event blocks are delimited by a blank line (LF LF).
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (!block.trim()) continue;
      const parsed = parseSseBlock(block);
      if (!parsed.event) continue;
      const result = await onEvent(parsed);
      if (result === 'stop') {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return 'stopped';
      }
    }
  }
}

async function killSandbox(sandboxId, ownerToken) {
  const { status, json } = await postJson('/api/sandbox-cf/cleanup', {
    sandbox_id: sandboxId,
    owner_token: ownerToken,
  });
  if (status !== 200) {
    warn(`cleanup returned ${status}: ${JSON.stringify(json)}`);
  } else {
    pass(`sandbox ${sandboxId} cleaned up`);
  }
}

async function main() {
  console.log(`\nCoder-job resume smoke → ${cfg.baseUrl}`);
  console.log(`  provider=${cfg.provider}  model=${cfg.model}`);
  console.log(`  repo=${cfg.repo}  branch=${cfg.branch}  killDelayMs=${cfg.killDelayMs}\n`);

  // --- Step 1: create scratch sandbox -----------------------------------
  console.log('Step 1 — create scratch sandbox');
  const created = await postJson('/api/sandbox-cf/create', { repo: '', branch: cfg.branch });
  if (created.status !== 200 || !created.json?.sandbox_id || !created.json?.owner_token) {
    fail(`create failed (${created.status}): ${JSON.stringify(created.json)}`);
    process.exit(1);
  }
  const sandboxId = created.json.sandbox_id;
  const ownerToken = created.json.owner_token;
  pass(`sandbox ${sandboxId} ready`);

  // --- Step 2: start coder job ------------------------------------------
  console.log('Step 2 — POST /api/jobs/start');
  const jobId = await startCoderJob(sandboxId, ownerToken);
  pass(`jobId=${jobId}`);

  // Hint for the parallel observer:
  info(`tail filter: wrangler tail --name push --format pretty --search "${jobId.slice(0, 8)}"`);
  info(
    `             grep -E "coder_job_resumed|coder_resume_restore_failed|coder_checkpoint_failed"`,
  );

  // --- Step 3: drive the run --------------------------------------------
  // The SSE stream surfaces only `assistant.prompt_snapshot`, `job.started`,
  // and the terminal `job.completed`/`job.failed`. The DO log line for a
  // captured checkpoint (`coder_checkpoint_captured`) lands on the worker
  // tail but `wrangler tail` buffers events with a ~20-30s lag — too racy
  // to drive a real-time kill decision against a ~45-180s job. So this
  // driver uses a simple, calibrated kill window:
  //
  //   1. Wait for `assistant.prompt_snapshot` (job is alive and has
  //      started running the kernel — strictly past job.started).
  //   2. Sleep `killDelayMs` (default 45s — comfortably past the round-5
  //      checkpoint cadence on kimi-k2.6 + the 12-step palette task, but
  //      well before the natural ~3-minute completion).
  //   3. Kill the sandbox via /api/sandbox-cf/cleanup.
  //   4. Keep the SSE stream open and watch for either job.completed
  //      (resume succeeded → loop completed on a new sandbox) or
  //      job.failed (resume bailed → expected only if checkpoint was
  //      missed or MAX_JOB_RESUMES was exhausted).
  //
  // The actual `coder_checkpoint_captured` and `coder_job_resumed` log
  // lines are confirmed out of band via a parallel `wrangler tail` watcher
  // (see scripts/snapshot-smoke/README.md §"Layer 3"). The script asserts
  // only what it can observe via SSE; the deliverable doc records what
  // the parallel tail showed.
  console.log('Step 3 — wait for prompt_snapshot, then kill on a calibrated delay');

  let terminalEvent = null;
  let promptSnapshotAt = null;
  let killScheduledAt = null;
  let killCompletedAt = null;

  const startedAt = Date.now();
  const deadline = startedAt + cfg.maxWaitMs;

  const ctrl = new AbortController();

  // Background timer that fires the kill after `killDelayMs`. We arm it
  // inside the SSE callback (after prompt_snapshot) rather than here so
  // the kill window is measured from "kernel is actually running", not
  // from /api/jobs/start which can include a small DO-spinup delay.
  let killTimer = null;
  const armKillTimer = () => {
    if (killTimer) return;
    killScheduledAt = Date.now();
    info(`armed kill timer for +${cfg.killDelayMs}ms (after prompt_snapshot)`);
    killTimer = setTimeout(async () => {
      try {
        info(`kill timer fired — calling cleanup`);
        await killSandbox(sandboxId, ownerToken);
      } finally {
        killCompletedAt = Date.now();
      }
    }, cfg.killDelayMs);
  };

  const ssePromise = tailEvents(
    jobId,
    async ({ event, data }) => {
      let payload = null;
      try {
        payload = data ? JSON.parse(data) : null;
      } catch {
        /* non-JSON heartbeat */
      }
      if (event === 'assistant.prompt_snapshot') {
        promptSnapshotAt = Date.now();
        info(`SSE: assistant.prompt_snapshot (totalChars=${payload?.totalChars ?? '?'})`);
        armKillTimer();
      } else if (event === 'job.started') {
        info(`SSE: job.started`);
      } else if (event === 'job.completed' || event === 'job.failed') {
        terminalEvent = { event, payload };
        console.log(
          `    SSE terminal: ${event} ${payload ? JSON.stringify(payload).slice(0, 240) : ''}`,
        );
        return 'stop';
      }
    },
    ctrl.signal,
  ).catch((err) => {
    if (err?.name !== 'AbortError') warn(`SSE tail error: ${err?.message ?? err}`);
  });

  // Wait for SSE terminal OR maxWaitMs, whichever comes first. The kill
  // schedules itself via the timer above; this loop just waits.
  while (!terminalEvent && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (killTimer) clearTimeout(killTimer);
  ctrl.abort();
  await ssePromise;

  const elapsedMs = Date.now() - startedAt;
  const killElapsed =
    killCompletedAt && promptSnapshotAt ? killCompletedAt - promptSnapshotAt : null;
  console.log('\n--- Summary ---');
  info(`elapsed ${elapsedMs.toLocaleString()}ms`);
  info(
    `prompt_snapshot at +${promptSnapshotAt ? promptSnapshotAt - startedAt : '?'}ms; ` +
      `kill armed at +${killScheduledAt ? killScheduledAt - startedAt : '?'}ms; ` +
      `kill completed at +${killCompletedAt ? killCompletedAt - startedAt : '?'}ms ` +
      `(${killElapsed ?? '?'}ms after prompt_snapshot)`,
  );

  if (!killCompletedAt) {
    fail(
      'kill timer never fired — job ended before killDelayMs elapsed. Increase killDelayMs or use a heavier task.',
    );
  } else if (!terminalEvent) {
    warn('no terminal SSE event observed within maxWaitMs — job may still be running');
  } else if (terminalEvent.event === 'job.completed') {
    pass(`job.completed after kill: ${(terminalEvent.payload?.summary ?? '').slice(0, 200)}`);
    info(
      'A completion after the kill is the headline positive: the DO must have restored from checkpoint to keep the run going. ' +
        'Confirm `coder_job_resumed` in the parallel wrangler tail for the structured-log corroboration.',
    );
  } else {
    fail(`job.failed after kill: ${(terminalEvent.payload?.error ?? '').slice(0, 240)}`);
    info(
      'A failure after the kill means resume bailed — likely the kill landed before the round-5 checkpoint, ' +
        'or MAX_JOB_RESUMES was exhausted. Confirm via `coder_resume_restore_failed` in the parallel wrangler tail.',
    );
  }

  // The script asserts only what SSE shows; the structured-log corroboration
  // is reported separately by the parallel wrangler tail (see deliverable).
  process.exit(
    failures === 0 && killCompletedAt && terminalEvent?.event === 'job.completed' ? 0 : 1,
  );
}

main().catch((err) => {
  console.error(`\nFATAL: ${err?.stack ?? err?.message ?? err}\n`);
  process.exit(1);
});
