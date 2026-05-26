#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Layer 3 cap test — exercises the `MAX_JOB_RESUMES = 2` bound by killing
// the same Coder job three times in a row. Companion to
// `coder-resume-smoke.mjs` (which does ONE kill and asserts resume works);
// this script asserts that resume STOPS working after the cap.
//
// Expected sequence on a healthy worker:
//   kill #1 → resumeFromCheckpoint(0) succeeds → resumesUsed = 1
//   kill #2 → resumeFromCheckpoint(1) succeeds → resumesUsed = 2
//   kill #3 → resumeFromCheckpoint(2): `resumesUsed >= MAX_JOB_RESUMES`,
//             returns null, original SandboxUnreachableError propagates,
//             DO emits a `job.failed` SSE event.
//
// The hard part is the kill orchestration. The script knows the original
// sandbox's owner token (from `/api/sandbox-cf/create`), but the DO never
// surfaces the post-resume sandbox identity through any public API. We
// recover it out of band:
//   - PRIMARY: KV-list-diff against the baselined `SANDBOX_TOKENS`
//     namespace + the set of sandboxIds we've already seen this run.
//     `restoreWorkspaceSnapshot` mints a fresh token via `issueToken`
//     which writes `token:<sandboxId> → { token, createdAt, ... }`, and
//     KV is settled by the time the SSE `assistant.prompt_snapshot`
//     fires for the resumed loop — so the diff reliably points at the
//     new sandbox. We then `npx wrangler kv key get` to read the token,
//     polling on null because the list-index and value-store can
//     transiently disagree.
//   - DISAMBIGUATOR: when KV-diff returns multiple unseen ids
//     (concurrent traffic on the same CF account), the script cross-
//     checks the tail log's `coder_job_resumed` line — it carries the
//     authoritative sandboxId for THIS jobId, so we can pick correctly
//     without killing an unrelated sandbox. Tail can lag 20-30s, so the
//     cross-check has its own deadline.
//   - HANG GUARD: every `await promptSnapshotPromise` races a 120s
//     timer + the SSE terminal event. A failed resume emits no follow-up
//     prompt_snapshot, so without the race the driver would block
//     forever on `await`. The race lets us report the failure cleanly
//     and exit instead.
//
// Provider: cloudflare (the only one configured on prod), model
// `@cf/moonshotai/kimi-k2.6`. Same task as the existing driver.
//
// Run:
//   PUSH_SMOKE_BASE_URL=https://push.<sub>.workers.dev \
//   PUSH_SMOKE_DEPLOYMENT_TOKEN=$(grep ^PUSH_DEPLOYMENT_TOKEN= .dev.vars | cut -d= -f2- | tr -d '"\r') \
//   node scripts/snapshot-smoke/coder-resume-cap-smoke.mjs
//
// Prereq: `wrangler kv key get` must work against the SANDBOX_TOKENS
// namespace bound in `wrangler.jsonc`. The script reads the namespace id
// from the jsonc file at startup; override with PUSH_SMOKE_KV_NAMESPACE_ID.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';

const cfg = {
  baseUrl: (process.env.PUSH_SMOKE_BASE_URL ?? '').replace(/\/+$/, ''),
  origin: process.env.PUSH_SMOKE_ORIGIN ?? '',
  repo: process.env.PUSH_SMOKE_REPO ?? 'push-smoke/resume-cap',
  branch: process.env.PUSH_SMOKE_BRANCH ?? `resume-cap-${Date.now()}`,
  deploymentToken: process.env.PUSH_SMOKE_DEPLOYMENT_TOKEN ?? '',
  provider: process.env.PUSH_SMOKE_PROVIDER ?? 'cloudflare',
  model: process.env.PUSH_SMOKE_MODEL ?? '@cf/moonshotai/kimi-k2.6',
  // Delay between the FIRST prompt_snapshot and kill 1. Has to be past the
  // round-5 checkpoint cadence so the first kill has a snapshot to restore
  // from. Calibrated for kimi-k2.6 + the palette task.
  firstKillDelayMs: Number.parseInt(process.env.PUSH_SMOKE_FIRST_KILL_MS ?? '45000', 10),
  // Delay between each post-resume prompt_snapshot and the next kill. Much
  // shorter than the first because the DO's `checkpoint` SQLite row still
  // carries the round-5 snapshot until a fresh checkpoint replaces it —
  // subsequent kills can reuse it. We just need the resumed loop to make
  // at least ONE tool call so the SANDBOX_UNREACHABLE/fatal throw fires.
  // Without a short delay, kimi-k2.6 finishes the remaining ~13 steps in
  // 30s and the cap test never gets a second kill in edgewise.
  subsequentKillDelayMs: Number.parseInt(process.env.PUSH_SMOKE_NEXT_KILL_MS ?? '8000', 10),
  // After each kill, how long to wait for the resume log line + new token
  // to appear in KV before giving up. wrangler tail buffers events on a
  // ~20-30s lag; the restore itself takes ~5-10s; KV propagation is
  // sub-second. 90s is a comfortable ceiling.
  resumeTimeoutMs: Number.parseInt(process.env.PUSH_SMOKE_RESUME_TIMEOUT_MS ?? '90000', 10),
  // After the FINAL kill (the one we expect to exhaust the cap), how long
  // to wait for the job.failed SSE event. The DO's `executeJob` catch arm
  // fires immediately when the loop throws, so this is generous on purpose.
  finalFailureTimeoutMs: Number.parseInt(process.env.PUSH_SMOKE_FAIL_TIMEOUT_MS ?? '60000', 10),
  // Hard ceiling on total wall clock.
  maxWaitMs: Number.parseInt(process.env.PUSH_SMOKE_MAX_WAIT_MS ?? '900000', 10),
  // KV namespace id for SANDBOX_TOKENS. Auto-detected from wrangler.jsonc
  // unless overridden.
  kvNamespaceId: process.env.PUSH_SMOKE_KV_NAMESPACE_ID ?? '',
  // wrangler tail log path. The script spawns the tail itself.
  tailLogPath: process.env.PUSH_SMOKE_TAIL_LOG ?? `/tmp/coder-resume-cap-tail.log`,
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

/** Discover SANDBOX_TOKENS KV namespace id from wrangler.jsonc unless one
 *  was provided via env. wrangler.jsonc isn't strict JSON (allows comments
 *  and trailing commas) — strip both before parsing. */
async function resolveKvNamespaceId() {
  if (cfg.kvNamespaceId) return cfg.kvNamespaceId;
  const raw = await fs.readFile(new URL('../../wrangler.jsonc', import.meta.url).pathname, 'utf8');
  // Strip // and /* */ comments and trailing commas — minimal-effort but
  // good enough for the wrangler-shaped jsonc we have.
  const cleaned = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,(\s*[}\]])/g, '$1');
  const parsed = JSON.parse(cleaned);
  const binding = (parsed.kv_namespaces ?? []).find((b) => b.binding === 'SANDBOX_TOKENS');
  if (!binding?.id) {
    throw new Error(
      'SANDBOX_TOKENS binding not found in wrangler.jsonc — set PUSH_SMOKE_KV_NAMESPACE_ID instead.',
    );
  }
  return binding.id;
}

/** `npx wrangler kv key list --namespace-id ID --remote --prefix token:`.
 *  Returns the array of sandboxIds (the part after `token:`) present in the
 *  namespace right now. Used to discover the new sandbox after a resume: we
 *  diff against the set we've already seen, and the new one is whatever's
 *  left. KV propagation is sub-second so this is much faster than waiting
 *  for `wrangler tail` to flush a `coder_job_resumed` line (which buffers
 *  ~20-30s and would race a fast resumed run to its natural completion). */
async function listSandboxIdsFromKv(kvId) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'npx',
      ['wrangler', 'kv', 'key', 'list', '--namespace-id', kvId, '--remote', '--prefix', 'token:'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`wrangler kv list exited ${code}: ${stderr || stdout}`));
      }
      try {
        const records = JSON.parse(stdout);
        const ids = (Array.isArray(records) ? records : [])
          .map((r) =>
            typeof r?.name === 'string' && r.name.startsWith('token:') ? r.name.slice(6) : null,
          )
          .filter((id) => id !== null);
        resolve(ids);
      } catch (e) {
        reject(new Error(`failed to parse wrangler kv list output: ${e.message}`));
      }
    });
    proc.on('error', reject);
  });
}

/** Poll the KV list until a sandboxId appears that isn't in the caller's
 *  `known` set. Returns that id, or null on timeout. On the unambiguous
 *  case (exactly one fresh id) we return it directly. On the ambiguous
 *  case (multiple fresh ids — concurrent test traffic or shared CF account
 *  noise) we cross-check against the tail log's `coder_job_resumed`
 *  payload for THIS jobId: it carries the authoritative sandboxId the DO
 *  actually minted. Without that disambiguator we'd risk killing an
 *  unrelated sandbox on the next loop iteration. */
async function waitForNewSandboxIdViaKv({ kvId, known, jobId, tailPath, deadlineAt }) {
  while (Date.now() < deadlineAt) {
    try {
      const ids = await listSandboxIdsFromKv(kvId);
      const fresh = ids.filter((id) => !known.has(id));
      if (fresh.length === 1) return fresh[0];
      if (fresh.length > 1) {
        // Ambiguous: somebody else's test/work introduced a new sandbox in
        // parallel. Consult the tail log's structured `coder_job_resumed`
        // line for THIS jobId to disambiguate. Tail can lag 20-30s, so
        // give it real time before failing. If the log says a specific
        // sandboxId belongs to our job AND it's in `fresh`, use it.
        // Otherwise fail rather than guess (a wrong guess kills someone
        // else's sandbox on the next /cleanup call).
        warn(
          `KV diff returned ${fresh.length} unseen sandboxes — cross-checking the tail log's coder_job_resumed line for jobId=${jobId.slice(0, 8)}`,
        );
        const tailDeadline = Math.min(deadlineAt, Date.now() + 45000);
        const logSandboxId = await waitForResumeLog(tailPath, jobId, 0, tailDeadline);
        if (logSandboxId && fresh.includes(logSandboxId)) {
          info(`tail cross-check picked sandboxId=${logSandboxId} for our jobId`);
          return logSandboxId;
        }
        if (logSandboxId) {
          warn(
            `tail says our resume sandboxId is ${logSandboxId}, but it's not in the KV fresh set — KV may have evicted it; aborting to avoid killing an unrelated sandbox`,
          );
        } else {
          warn('no coder_job_resumed line for our jobId in the tail within the cross-check window');
        }
        return null;
      }
    } catch (e) {
      // Don't fail the test on a transient wrangler issue; retry.
      warn(`KV list attempt failed (will retry): ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

/** `npx wrangler kv key get --namespace-id ID --remote token:<id>`. Returns
 *  the record's `token` field (a UUID), or null if the key isn't there yet. */
async function readOwnerTokenFromKv(kvId, sandboxId) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'npx',
      ['wrangler', 'kv', 'key', 'get', `token:${sandboxId}`, '--namespace-id', kvId, '--remote'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        if (/value not found|key was not found/i.test(stderr + stdout)) return resolve(null);
        return reject(new Error(`wrangler kv get exited ${code}: ${stderr || stdout}`));
      }
      try {
        const record = JSON.parse(stdout);
        if (typeof record?.token === 'string') return resolve(record.token);
        resolve(null);
      } catch {
        // wrangler sometimes pads with newlines / log lines; try to extract
        // the inner JSON object.
        const match = stdout.match(/\{[\s\S]*"token"[\s\S]*?\}/);
        if (match) {
          try {
            const record = JSON.parse(match[0]);
            if (typeof record?.token === 'string') return resolve(record.token);
          } catch {
            /* fall through */
          }
        }
        resolve(null);
      }
    });
    proc.on('error', reject);
  });
}

/** Spawn `wrangler tail` and stream its JSON output to a file. Returns a
 *  handle the caller MUST await on `ready` before opening any traffic that
 *  will produce tail events the test depends on — otherwise the first
 *  wrangler stdout chunks can arrive before `fs.open` resolves and the
 *  data listener is attached, dropping them silently. Surfaces fs.open or
 *  write failures as a rejected `ready` so the caller fails loud instead
 *  of silently degrading later log-corroboration checks. */
function startTailToFile(path) {
  const proc = spawn('npx', ['wrangler', 'tail', 'push', '--format', 'json'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Buffer everything wrangler emits between spawn and `fs.open` resolving,
  // then flush it to the file once the handle is open. Without buffering,
  // chunks delivered before the listener attaches are lost.
  const earlyChunks = [];
  const bufferingListener = (chunk) => earlyChunks.push(chunk);
  proc.stdout.on('data', bufferingListener);
  proc.stderr.on('data', bufferingListener);

  const ready = (async () => {
    const handle = await fs.open(path, 'w');
    // Replay buffered chunks BEFORE swapping listeners so order is preserved.
    for (const chunk of earlyChunks) {
      await handle.write(chunk);
    }
    proc.stdout.off('data', bufferingListener);
    proc.stderr.off('data', bufferingListener);
    proc.stdout.on('data', (chunk) => {
      handle.write(chunk).catch((err) => {
        warn(`tail-log write failed (data may be missing): ${err.message}`);
      });
    });
    proc.stderr.on('data', (chunk) => {
      handle.write(chunk).catch((err) => {
        warn(`tail-log stderr write failed: ${err.message}`);
      });
    });
    proc.on('close', () => handle.close().catch(() => {}));
  })();
  return { proc, ready };
}

/** Poll the tail log for the next `coder_job_resumed` line matching jobId.
 *  Returns the new sandboxId from the log payload, or null on timeout.
 *  The log line shape (per `coder-job-do.ts` resumeFromCheckpoint):
 *    "{\"level\":\"info\",\"event\":\"coder_job_resumed\",\"jobId\":\"X\",\"round\":N,\"sandboxId\":\"Y\"}"
 *
 *  Coupling note: this regex is intentionally pinned to `wrangler tail
 *  --format json`'s string-escaped representation of the worker's
 *  structured log + the field order `JSON.stringify` produces from
 *  `coder-job-do.ts`. If either format changes, this match silently
 *  becomes null. That's tolerable here because both paths that consume
 *  this helper (the KV-ambiguous disambiguator + the cap-log
 *  corroborator) treat null as a DIAGNOSTIC degradation, not a primary
 *  assertion: the script still pass/fails on the SSE-observed
 *  job.failed / job.completed terminal. Worth tightening if/when we
 *  build automation that depends on this signal alone.
 */
async function waitForResumeLog(tailPath, jobId, sinceOffset, deadlineAt) {
  // Escape jobId for use in a regex (UUIDs are ASCII-safe, but be belt-and-braces).
  const idEsc = jobId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `\\\\"event\\\\":\\\\"coder_job_resumed\\\\"[\\s\\S]*?\\\\"jobId\\\\":\\\\"${idEsc}\\\\"[\\s\\S]*?\\\\"sandboxId\\\\":\\\\"([0-9a-f-]+)\\\\"`,
  );
  while (Date.now() < deadlineAt) {
    try {
      const txt = await fs.readFile(tailPath, 'utf8');
      const slice = txt.slice(sinceOffset);
      const m = slice.match(re);
      if (m) return m[1];
    } catch {
      /* tail file may not exist yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

/** Poll the tail log for an event-name match (e.g. `coder_resume_restore_failed`)
 *  scoped to a jobId. Returns true on match, false on timeout. */
async function waitForJobEventLog(tailPath, jobId, eventName, sinceOffset, deadlineAt) {
  const idEsc = jobId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const evEsc = eventName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `\\\\"event\\\\":\\\\"${evEsc}\\\\"[\\s\\S]*?\\\\"jobId\\\\":\\\\"${idEsc}\\\\"`,
  );
  while (Date.now() < deadlineAt) {
    try {
      const txt = await fs.readFile(tailPath, 'utf8');
      if (re.test(txt.slice(sinceOffset))) return true;
    } catch {
      /* tail file may not exist yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** Like `readOwnerTokenFromKv` but with a poll-with-timeout loop — KV
 *  propagation usually finishes in <1s but the test should tolerate
 *  multi-second eventual-consistency in pathological cases. */
async function waitForKvToken(kvId, sandboxId, deadlineAt) {
  while (Date.now() < deadlineAt) {
    try {
      const tok = await readOwnerTokenFromKv(kvId, sandboxId);
      if (tok) return tok;
    } catch (e) {
      warn(`KV read attempt failed (will retry): ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

function buildEnvelope() {
  // Long enough to span THREE checkpoint cycles + three kills (~3-5 min).
  // 12 distinct color files + read-backs + summary + verification = 24+
  // mechanical steps, ≥18 rounds on kimi-k2.6 even with batching pressure.
  const task = [
    'Build a small "color palette" library under /workspace/palette/, step by step.',
    'Do EXACTLY one sandbox tool call per round. Never batch. Re-read every',
    'file you write before moving to the next step.',
    '',
    '1.  Make the directory /workspace/palette/.',
    '2.  Write /workspace/palette/red.txt: "#ff0000\\nrgb(255,0,0)".',
    '3.  Read /workspace/palette/red.txt back.',
    '4.  Write /workspace/palette/green.txt: "#00ff00\\nrgb(0,255,0)".',
    '5.  Read /workspace/palette/green.txt back.',
    '6.  Write /workspace/palette/blue.txt: "#0000ff\\nrgb(0,0,255)".',
    '7.  Read /workspace/palette/blue.txt back.',
    '8.  Write /workspace/palette/cyan.txt: "#00ffff\\nrgb(0,255,255)".',
    '9.  Read /workspace/palette/cyan.txt back.',
    '10. Write /workspace/palette/magenta.txt: "#ff00ff\\nrgb(255,0,255)".',
    '11. Read /workspace/palette/magenta.txt back.',
    '12. Write /workspace/palette/yellow.txt: "#ffff00\\nrgb(255,255,0)".',
    '13. Read /workspace/palette/yellow.txt back.',
    '14. Run `ls -1 /workspace/palette` to confirm six .txt files exist.',
    '15. Run `wc -l /workspace/palette/*.txt`.',
    '16. Write /workspace/palette/SUMMARY.md with one bullet per file.',
    '17. Read SUMMARY.md back.',
    '18. Final round: one-paragraph plain-English wrap-up.',
    '',
    'Hard rules: ONE sandbox tool call per round. Never commit, push, or touch git.',
  ].join('\n');
  return {
    task,
    files: [],
    provider: cfg.provider,
    model: cfg.model,
    branchContext: { activeBranch: cfg.branch, defaultBranch: 'main', protectMain: false },
    harnessSettings: { maxCoderRounds: 60, contextResetsEnabled: false },
  };
}

async function startCoderJob(sandboxId, ownerToken) {
  const body = {
    role: 'coder',
    chatId: `resume-cap-${randomUUID()}`,
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
  if (status !== 202 || !json?.jobId) {
    throw new Error(`/api/jobs/start failed (${status}): ${JSON.stringify(json)}`);
  }
  return json.jobId;
}

function parseSseBlock(block) {
  const lines = block.split('\n');
  let id = null;
  let event = null;
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('id: ')) id = line.slice(4);
    else if (line.startsWith('event: ')) event = line.slice(7);
    else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
  }
  return { id, event, data: dataLines.length ? dataLines.join('\n') : null };
}

async function openSseStream(jobId, onEvent, signal) {
  const res = await fetch(`${cfg.baseUrl}/api/jobs/${encodeURIComponent(jobId)}/events`, {
    method: 'GET',
    headers: { ...authHeaders(), accept: 'text/event-stream' },
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`SSE open failed (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return 'eof';
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
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

async function killSandbox(sandboxId, ownerToken, label) {
  const { status, json } = await postJson('/api/sandbox-cf/cleanup', {
    sandbox_id: sandboxId,
    owner_token: ownerToken,
  });
  if (status === 200) {
    pass(`${label}: sandbox ${sandboxId} cleaned up`);
    return true;
  }
  fail(`${label}: cleanup returned ${status}: ${JSON.stringify(json)}`);
  return false;
}

async function main() {
  console.log(`\nCoder-job resume CAP smoke → ${cfg.baseUrl}`);
  console.log(`  provider=${cfg.provider}  model=${cfg.model}`);
  console.log(
    `  repo=${cfg.repo}  branch=${cfg.branch}  ` +
      `firstKill=+${cfg.firstKillDelayMs}ms  subsequentKill=+${cfg.subsequentKillDelayMs}ms\n`,
  );

  const kvId = await resolveKvNamespaceId();
  info(`SANDBOX_TOKENS namespace id = ${kvId}`);

  // Start tail BEFORE creating the job so we don't miss early events.
  // Await `ready` so the file handle is open before any traffic produces
  // events the test depends on. The fixed sleep below is still needed to
  // give the wrangler subprocess time to dial the worker; without it,
  // early prod log lines can arrive before the websocket attaches.
  await fs.rm(cfg.tailLogPath, { force: true });
  const tail = startTailToFile(cfg.tailLogPath);
  await tail.ready.catch((err) => {
    throw new Error(`failed to start wrangler tail to ${cfg.tailLogPath}: ${err.message}`);
  });
  info(`wrangler tail spawned → ${cfg.tailLogPath} (pid=${tail.proc.pid})`);
  await new Promise((r) => setTimeout(r, 4000));

  const cleanup = async () => {
    try {
      tail.proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  };
  process.on('exit', cleanup);

  // Baseline the KV namespace BEFORE creating our scratch sandbox so the
  // KV-diff strategy below correctly identifies only the sandbox(es) minted
  // by THIS run, ignoring the dozens of stale `token:<uuid>` keys left over
  // from previous tests (24h TTL). Without this, the diff would include
  // every other recent sandbox and we couldn't pick out ours.
  info(`baselining SANDBOX_TOKENS KV state`);
  const baselineIds = new Set(await listSandboxIdsFromKv(kvId).catch(() => []));
  info(`KV baseline = ${baselineIds.size} pre-existing token entries`);

  // --- Step 1: create scratch sandbox + start job ----------------------
  console.log('Step 1 — create scratch sandbox');
  const created = await postJson('/api/sandbox-cf/create', { repo: '', branch: cfg.branch });
  if (created.status !== 200 || !created.json?.sandbox_id || !created.json?.owner_token) {
    fail(`create failed (${created.status}): ${JSON.stringify(created.json)}`);
    await cleanup();
    process.exit(1);
  }
  let sandboxId = created.json.sandbox_id;
  let ownerToken = created.json.owner_token;
  pass(`sandbox ${sandboxId} ready`);

  console.log('Step 2 — POST /api/jobs/start');
  const jobId = await startCoderJob(sandboxId, ownerToken);
  pass(`jobId=${jobId}`);

  const startedAt = Date.now();
  const overallDeadline = startedAt + cfg.maxWaitMs;

  // --- Step 3: orchestrate THREE kills --------------------------------
  console.log(
    'Step 3 — drive 3 sequential kills via /cleanup; expect 2 successful resumes then job.failed',
  );

  let promptSnapshotPromise = null;
  let resolvePromptSnapshot = null;
  let terminalEvent = null;
  const newPromptSnapshotPromise = () =>
    new Promise((resolve) => {
      resolvePromptSnapshot = resolve;
    });
  promptSnapshotPromise = newPromptSnapshotPromise();

  const sseAbort = new AbortController();
  const ssePromise = openSseStream(
    jobId,
    async ({ event, data }) => {
      let payload = null;
      try {
        payload = data ? JSON.parse(data) : null;
      } catch {
        /* heartbeat */
      }
      if (event === 'assistant.prompt_snapshot') {
        info(`SSE: assistant.prompt_snapshot (totalChars=${payload?.totalChars ?? '?'})`);
        if (resolvePromptSnapshot) {
          resolvePromptSnapshot();
          resolvePromptSnapshot = null;
        }
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
    sseAbort.signal,
  ).catch((err) => {
    if (err?.name !== 'AbortError') warn(`SSE error: ${err?.message ?? err}`);
  });

  const MAX_JOB_RESUMES = 2;
  const targetKills = MAX_JOB_RESUMES + 1; // 3
  const resumesObserved = []; // sandbox ids discovered via KV-diff post-resume

  // Track every sandboxId we know belongs to this run. The diff against
  // SANDBOX_TOKENS KV identifies whatever new sandboxId the DO minted during
  // resume — much faster than waiting on the lagged wrangler tail log. Seed
  // with `baselineIds` (pre-existing entries from other runs) + the
  // original sandbox so neither shows up as "new".
  const knownSandboxIds = new Set([...baselineIds, sandboxId]);

  for (let k = 1; k <= targetKills; k++) {
    if (terminalEvent) {
      fail(`unexpected terminal SSE event before kill ${k} (${terminalEvent.event})`);
      break;
    }

    // Wait for the kernel to be running on the current sandbox. The
    // CoderJob emits `assistant.prompt_snapshot` once per runCoderAgent
    // entry — once at job start (kill 1), then again after each
    // successful resumeFromCheckpoint (kills 2/3). The SSE callback above
    // sets resolvePromptSnapshot which resolves this promise.
    //
    // Race against `terminalEvent` and `maxWaitMs` so the await can't hang
    // forever when a resume fails: a terminal SSE event (job.failed /
    // job.completed) arrives without a follow-up prompt_snapshot when
    // resumeFromCheckpoint bails (cap hit, no checkpoint, restore failed).
    // Without this guard the loop would block indefinitely; with it we
    // fall through to the same "unexpected terminal" branch the top of
    // the loop already handles.
    info(`waiting for prompt_snapshot before kill ${k}`);
    const promptWaitDeadline = Math.min(overallDeadline, Date.now() + 120000);
    const promptWaitResult = await Promise.race([
      promptSnapshotPromise.then(() => 'snapshot'),
      (async () => {
        while (Date.now() < promptWaitDeadline && !terminalEvent) {
          await new Promise((r) => setTimeout(r, 500));
        }
        return terminalEvent ? 'terminal' : 'deadline';
      })(),
    ]);
    promptSnapshotPromise = newPromptSnapshotPromise();
    if (promptWaitResult === 'terminal') {
      // The top-of-loop check on the next iteration would report this as
      // unexpected, but be explicit here so the failure mode is clear in
      // the run log when k > 1 (a resume gave up without re-entering).
      fail(
        `terminal SSE event (${terminalEvent.event}) arrived before prompt_snapshot ${k} — ` +
          'previous resume likely bailed (check tail for coder_resume_*)',
      );
      break;
    }
    if (promptWaitResult === 'deadline') {
      fail(`prompt_snapshot ${k} did not arrive within 120s and no terminal SSE event either`);
      break;
    }

    // For kills 2/3, the prompt_snapshot we just observed is the resumed
    // loop's. The DO already finished `restoreWorkspaceSnapshot` (which
    // wrote the new sandbox's token to SANDBOX_TOKENS KV) before
    // re-entering runCoderAgent, so KV is settled by the time we get here.
    // Diff against `knownSandboxIds` to identify the new one — and when
    // KV shows multiple unseen sandboxes (concurrent CF account traffic),
    // cross-check the tail's `coder_job_resumed` line for OUR jobId so
    // we never kill an unrelated sandbox.
    if (k > 1) {
      info(`discovering new sandboxId via SANDBOX_TOKENS KV diff`);
      const newSandboxId = await waitForNewSandboxIdViaKv({
        kvId,
        known: knownSandboxIds,
        jobId,
        tailPath: cfg.tailLogPath,
        deadlineAt: Date.now() + 60000,
      });
      if (!newSandboxId) {
        fail(`kill ${k}: could not identify new sandboxId via KV diff (+ tail cross-check)`);
        break;
      }
      // Poll for the token. The KV list/get can transiently disagree
      // (eventual consistency between list-index and value reads), so a
      // single null GET is not a real failure — retry with a generous
      // budget rather than failing the run.
      const newToken = await waitForKvToken(kvId, newSandboxId, Date.now() + 15000);
      if (!newToken) {
        fail(
          `kill ${k}: KV list returned ${newSandboxId} but no token record within 15s ` +
            '(possible KV propagation lag; consider raising the polling budget)',
        );
        break;
      }
      resumesObserved.push(newSandboxId);
      knownSandboxIds.add(newSandboxId);
      sandboxId = newSandboxId;
      ownerToken = newToken;
      pass(`resume ${k - 1} confirmed via SSE + KV: sandboxId=${newSandboxId}`);
    }

    // First kill waits past the round-5 checkpoint cadence so the DO has a
    // snapshot to restore from. Subsequent kills reuse that same snapshot
    // (the DO's `checkpoint` row carries it until a fresh checkpoint
    // replaces it at round 10) and only need to give the resumed loop a
    // beat to make one tool call so the SANDBOX_UNREACHABLE/fatal throw
    // fires inside the kernel's toolExec wrapper.
    const delay = k === 1 ? cfg.firstKillDelayMs : cfg.subsequentKillDelayMs;
    info(`sleeping ${delay}ms before kill ${k} on sandbox ${sandboxId}`);
    await new Promise((r) => setTimeout(r, delay));

    if (terminalEvent) {
      // The resumed loop completed faster than `subsequentKillDelayMs`.
      // Rare but possible if the model races through the remaining steps —
      // we still want to fail loud rather than try to kill a dead sandbox.
      fail(
        `terminal SSE event ${terminalEvent.event} arrived during pre-kill delay for kill ${k}; ` +
          'lower PUSH_SMOKE_NEXT_KILL_MS or use a heavier task',
      );
      break;
    }

    await killSandbox(sandboxId, ownerToken, `kill ${k}`);

    if (k === targetKills) {
      // Kill 3 should exhaust the cap. The DO's runLoop catches
      // SandboxUnreachableError, calls resumeFromCheckpoint(2), which
      // short-circuits on `resumesUsed >= MAX_JOB_RESUMES` and emits a
      // `coder_resume_cap_exhausted` warn log before returning null. The
      // original error propagates → job.failed.
      console.log(
        `Step 4 — kill ${k} should exhaust the cap; expect job.failed (not job.completed)`,
      );
      const failDeadline = Math.min(overallDeadline, Date.now() + cfg.finalFailureTimeoutMs);
      while (Date.now() < failDeadline && !terminalEvent) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!terminalEvent) {
        fail(`no terminal SSE event within ${cfg.finalFailureTimeoutMs}ms after kill ${k}`);
      } else if (terminalEvent.event === 'job.failed') {
        pass(`cap exhausted as expected: job.failed after ${MAX_JOB_RESUMES} resumes + kill ${k}`);
        // Strengthen the assertion: a job.failed could come from many
        // causes. The `coder_resume_cap_exhausted` log uniquely confirms
        // this failure was the cap, not e.g. an unrelated R2 restore
        // error. The tail log lags ~20-30s so give it real time to flush.
        info('waiting for coder_resume_cap_exhausted log to corroborate (tail lag)');
        const capLogDeadline = Math.min(overallDeadline, Date.now() + 45000);
        const capLogObserved = await waitForJobEventLog(
          cfg.tailLogPath,
          jobId,
          'coder_resume_cap_exhausted',
          0,
          capLogDeadline,
        );
        if (capLogObserved) {
          pass(
            'tail log shows coder_resume_cap_exhausted — failure was the cap, not a restore error',
          );
        } else {
          warn(
            'coder_resume_cap_exhausted not seen in tail log within deadline; ' +
              'job.failed still asserts the user-visible outcome but the cap-specific signal was missed (tail lag or worker not yet on the new code)',
          );
        }
      } else if (terminalEvent.event === 'job.completed') {
        // Could mean cap leaked (3rd resume succeeded) OR the kill never
        // landed before the model finished. KV-diff catches the leak case.
        try {
          const idsNow = await listSandboxIdsFromKv(kvId);
          const fresh = idsNow.filter((id) => !knownSandboxIds.has(id));
          if (fresh.length > 0) {
            fail(
              `MAX_JOB_RESUMES bound LEAKED — KV shows new sandbox(es) ${fresh.join(', ')} after kill ${k}; ` +
                'resume succeeded past the cap',
            );
          } else {
            fail(
              `cap test produced job.completed without a new sandbox — kill ${k} did not propagate as failure; ` +
                'check whether the model finished before the kill landed',
            );
          }
        } catch (e) {
          fail(`job.completed after kill ${k}, and KV diff threw: ${e.message}`);
        }
      }
      break;
    }
  }

  // Drain the SSE stream so the script exits cleanly.
  sseAbort.abort();
  await ssePromise;

  // --- Summary ----------------------------------------------------------
  const elapsedMs = Date.now() - startedAt;
  console.log('\n--- Summary ---');
  info(`elapsed ${elapsedMs.toLocaleString()}ms`);
  info(`MAX_JOB_RESUMES = ${MAX_JOB_RESUMES}; kills attempted = ${targetKills}`);
  info(`resumes observed = ${resumesObserved.length} (sandboxes ${resumesObserved.join(', ')})`);
  info(`terminal SSE event = ${terminalEvent?.event ?? '(none)'}`);

  if (resumesObserved.length !== MAX_JOB_RESUMES) {
    fail(
      `expected exactly ${MAX_JOB_RESUMES} resumes before the cap; got ${resumesObserved.length}`,
    );
  } else if (terminalEvent?.event !== 'job.failed') {
    fail(
      `expected job.failed after kill ${targetKills} (cap exhausted); got ${terminalEvent?.event ?? '(no terminal)'}`,
    );
  } else {
    pass(
      `MAX_JOB_RESUMES cap honored: ${MAX_JOB_RESUMES} resumes then job.failed on kill ${targetKills}`,
    );
  }

  await cleanup();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nFATAL: ${err?.stack ?? err?.message ?? err}\n`);
  process.exit(1);
});
