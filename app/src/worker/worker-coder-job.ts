/**
 * HTTP route handlers for `/api/jobs/*`. Forwards to the `CoderJob`
 * Durable Object bound as `env.CoderJob`. Phase 1 PR #2 — see
 * `docs/runbooks/Background Coder Tasks Phase 1.md`.
 *
 * Routes:
 *   POST /api/jobs/start         — body carries the full job envelope;
 *                                  generates jobId if absent, forwards
 *                                  to DO /start.
 *   GET  /api/jobs/:id/events    — forwards to DO /events as an SSE
 *                                  response. Last-Event-ID header
 *                                  passes through for replay.
 *   POST /api/jobs/:id/cancel    — forwards to DO /cancel.
 *   GET  /api/jobs/:id           — forwards to DO /status snapshot.
 *
 * Fails closed with NOT_CONFIGURED (503) when `env.CoderJob` is not
 * bound — mirrors the `/api/sandbox-cf/*` pattern so a partially
 * deployed environment can't silently accept jobs that will never run.
 */

import type { Env } from './worker-middleware';
import type { CoderJobStartInput } from './coder-job-do';

const JOBS_PREFIX = '/api/jobs/';

export interface JobsRouteMatch {
  action: 'start' | 'events' | 'cancel' | 'status';
  jobId: string | null;
}

/** Parse a pathname beginning with `/api/jobs/`. Returns null for
 * non-match. `/api/jobs/start` is parsed as `action=start, jobId=null`
 * because the client doesn't know the jobId at start time. */
export function matchJobsRoute(pathname: string, method: string): JobsRouteMatch | null {
  if (!pathname.startsWith(JOBS_PREFIX)) return null;
  const rest = pathname.slice(JOBS_PREFIX.length);
  const segments = rest.split('/').filter(Boolean);
  if (segments.length === 1 && segments[0] === 'start' && method === 'POST') {
    return { action: 'start', jobId: null };
  }
  // "start" is a reserved path segment under /api/jobs/; it's never a
  // jobId. Any other single segment under GET is a status snapshot.
  if (segments.length === 1 && segments[0] !== 'start' && method === 'GET') {
    return { action: 'status', jobId: segments[0] };
  }
  if (segments.length === 2 && segments[1] === 'events' && method === 'GET') {
    return { action: 'events', jobId: segments[0] };
  }
  if (segments.length === 2 && segments[1] === 'cancel' && method === 'POST') {
    return { action: 'cancel', jobId: segments[0] };
  }
  return null;
}

export async function handleJobsRoute(
  request: Request,
  env: Env,
  match: JobsRouteMatch,
): Promise<Response> {
  if (!env.CoderJob) {
    return json(
      {
        error: 'NOT_CONFIGURED',
        message: 'CoderJob DO binding is not present in this environment.',
      },
      503,
    );
  }

  switch (match.action) {
    case 'start':
      return handleStart(request, env);
    case 'events':
      return forwardToDo(env, match.jobId!, 'events', request);
    case 'cancel':
      return forwardToDo(env, match.jobId!, 'cancel', request);
    case 'status':
      return forwardToDo(env, match.jobId!, 'status', request);
  }
}

async function handleStart(request: Request, env: Env): Promise<Response> {
  let payload: Partial<CoderJobStartInput>;
  try {
    payload = (await request.json()) as Partial<CoderJobStartInput>;
  } catch {
    return json({ error: 'INVALID_BODY', message: 'POST body must be JSON.' }, 400);
  }

  const jobId = payload.jobId ?? crypto.randomUUID();
  const origin = payload.origin ?? new URL(request.url).origin;
  const input: CoderJobStartInput = {
    ...(payload as CoderJobStartInput),
    jobId,
    origin,
  };

  const missing = requiredStartFields(input);
  if (missing.length) {
    return json({ error: 'MISSING_FIELDS', fields: missing }, 400);
  }

  return forwardToDo(env, jobId, 'start', request, JSON.stringify(input));
}

function requiredStartFields(input: CoderJobStartInput): string[] {
  const missing: string[] = [];
  if (!input.chatId) missing.push('chatId');
  if (!input.repoFullName) missing.push('repoFullName');
  if (!input.branch) missing.push('branch');
  if (!input.sandboxId) missing.push('sandboxId');
  if (!input.ownerToken) missing.push('ownerToken');
  if (!input.envelope) missing.push('envelope');
  if (!input.provider) missing.push('provider');
  return missing;
}

async function forwardToDo(
  env: Env,
  jobId: string,
  action: 'start' | 'events' | 'cancel' | 'status',
  original: Request,
  overrideBody?: string,
): Promise<Response> {
  const id = env.CoderJob!.idFromName(jobId);
  const stub = env.CoderJob!.get(id);
  const url = `https://do/${action}?jobId=${encodeURIComponent(jobId)}`;
  const init: RequestInit = {
    method: action === 'events' || action === 'status' ? 'GET' : 'POST',
    headers: new Headers({
      'content-type': 'application/json',
      ...(original.headers.get('Last-Event-ID')
        ? { 'Last-Event-ID': original.headers.get('Last-Event-ID')! }
        : {}),
    }),
  };
  if (init.method === 'POST') {
    init.body = overrideBody ?? (await original.clone().text());
  }
  // CF Workers types diverge from DOM types (e.g. Headers.getSetCookie);
  // cast at this single boundary so the handler signature stays as the
  // app-wide `Response` / `Request` (DOM). The runtime types are
  // identical in practice — see `worker-cf-sandbox.ts` for the same
  // pattern.
  return (await (stub as unknown as { fetch: (r: Request) => Promise<Response> }).fetch(
    new Request(url, init),
  )) as Response;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
