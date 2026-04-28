/**
 * ContextLoader — bridges chatRef on the wire to prior-turn context
 * inside the AgentJob runtime.
 *
 * PR 3 ships the chain-by-prior-jobId implementation: each new turn
 * carries chatRef.checkpointId pointing at the previous turn's jobId.
 * The loader walks that chain hop-by-hop (capped at MAX_PRIOR_TURNS),
 * pulling each prior job's task + terminal summary via a cross-DO
 * fetch into the existing CoderJob DO storage. No new persistence
 * layer; PR 1's event log is the source.
 *
 * The interface is deliberately narrow so PR 4+ can replace this with
 * a typed-memory query without rewriting the executeCoderJob call
 * site. The loader returns *summaries* (intent + outcome), not full
 * transcripts — that's the bridge-not-second-history-store constraint
 * locked in during the PR 3 design discussion.
 */

import type { ChatRef } from './coder-job-do';

/** Hard cap on chain depth. Prevents unbounded growth of context
 *  preamble and bounds the cross-DO fetch fan-out per turn. */
export const MAX_PRIOR_TURNS = 3;

/** A single prior-turn entry surfaced into the new turn's preamble.
 *  task + summary cover intent and outcome; finishedAt orders the
 *  list (oldest -> newest). priorCheckpointId is internal to the
 *  loader's chain walk and intentionally omitted from this type. */
export interface PriorTurnSummary {
  jobId: string;
  task: string;
  summary: string;
  finishedAt: number;
}

export interface LoadPriorTurnsArgs {
  chatRef: ChatRef | undefined;
  /** Hard cap on hops to walk. Defaults to MAX_PRIOR_TURNS. */
  maxTurns?: number;
}

export interface ContextLoader {
  loadPriorTurns(args: LoadPriorTurnsArgs): Promise<PriorTurnSummary[]>;
}

/** Default loader: returns empty. Used when no checkpointId is set
 *  and as the test default when nothing else is injected. */
export const NULL_CONTEXT_LOADER: ContextLoader = {
  async loadPriorTurns(): Promise<PriorTurnSummary[]> {
    return [];
  },
};

// ---------------------------------------------------------------------------
// /turn-summary wire shape — what the loader fetches from each prior DO.
// ---------------------------------------------------------------------------

/** Response body of GET /turn-summary?jobId=X on a CoderJob DO.
 *  status='completed' is the only state that produces a usable
 *  summary; any other state surfaces as `summary: null` and the
 *  loader stops chain-walking there. `chatId` is included so the
 *  loader can verify the prior turn belongs to the same chat as the
 *  current run — without it a forged or malformed checkpointId could
 *  pull summaries from unrelated jobs into the new task preamble. */
export interface TurnSummaryResponse {
  jobId: string;
  chatId: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  task: string;
  summary: string | null;
  finishedAt: number | null;
  priorCheckpointId: string | null;
}

// ---------------------------------------------------------------------------
// Web loader — production implementation
// ---------------------------------------------------------------------------

/** Minimal env surface the web loader needs. Avoids importing the
 *  full Env type (which pulls Cloudflare types into anything that
 *  imports this module). */
export interface ContextLoaderEnv {
  CoderJob?: {
    idFromName(name: string): { toString(): string };
    get(id: { toString(): string }): { fetch(req: Request): Promise<Response> };
  };
}

export interface CreateWebContextLoaderArgs {
  env: ContextLoaderEnv;
  /** Logger for graceful-degradation signals. Defaults to console.warn
   *  so production runs surface the warning to Worker logs without
   *  needing a new event variant on the SSE wire. */
  log?: (message: string) => void;
}

export function createWebContextLoader(args: CreateWebContextLoaderArgs): ContextLoader {
  const { env, log = (msg: string) => console.warn(`[ContextLoader] ${msg}`) } = args;

  return {
    async loadPriorTurns({ chatRef, maxTurns = MAX_PRIOR_TURNS }): Promise<PriorTurnSummary[]> {
      if (!chatRef?.checkpointId) return [];
      if (!env.CoderJob) {
        log('CoderJob binding missing; running fresh');
        return [];
      }

      const summaries: PriorTurnSummary[] = [];
      const visited = new Set<string>();
      let nextId: string | null = chatRef.checkpointId;
      const expectedChatId = chatRef.chatId;

      while (nextId && summaries.length < maxTurns) {
        if (visited.has(nextId)) {
          log(`chain loop detected at ${nextId}; truncating`);
          break;
        }
        visited.add(nextId);

        let snapshot: TurnSummaryResponse | null;
        try {
          snapshot = await fetchTurnSummary(env, nextId);
        } catch (err) {
          log(`failed to fetch turn-summary for ${nextId}: ${(err as Error).message}`);
          break;
        }
        if (!snapshot) {
          log(`no snapshot for ${nextId}; stopping chain walk`);
          break;
        }
        if (snapshot.status !== 'completed' || snapshot.summary == null) {
          // Only completed turns contribute context; non-terminal or
          // failed prior runs are skipped and stop the walk.
          break;
        }
        // Provenance check: a forged or malformed checkpointId could
        // point at a completed job in a *different* chat. Drop those
        // before they leak into the new turn's preamble. The chain
        // walk stops at a mismatch — once we've crossed into another
        // chat's space, we can't trust further hops either.
        if (snapshot.chatId !== expectedChatId) {
          log(
            `chatId mismatch at ${nextId} (expected '${expectedChatId}', got '${snapshot.chatId ?? 'null'}'); stopping chain walk`,
          );
          break;
        }

        summaries.push({
          jobId: snapshot.jobId,
          task: snapshot.task,
          summary: snapshot.summary,
          finishedAt: snapshot.finishedAt ?? 0,
        });

        nextId = snapshot.priorCheckpointId;
      }

      // Walk produced newest -> oldest. Reverse for natural reading
      // order in the preamble (oldest first, current turn implied at
      // end).
      return summaries.reverse();
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchTurnSummary(
  env: ContextLoaderEnv,
  jobId: string,
): Promise<TurnSummaryResponse | null> {
  const namespace = env.CoderJob;
  if (!namespace) return null;
  const stub = namespace.get(namespace.idFromName(jobId));
  const url = `https://do/turn-summary?jobId=${encodeURIComponent(jobId)}`;
  const resp = await stub.fetch(new Request(url, { method: 'GET' }));
  if (!resp.ok) return null;
  return (await resp.json()) as TurnSummaryResponse;
}

// ---------------------------------------------------------------------------
// Preamble formatter
// ---------------------------------------------------------------------------

/** Format prior summaries as a preamble block. Returns an empty string
 *  when no prior turns are present so callers can unconditionally
 *  prepend without checking. The format is deliberately structured
 *  (no free-form prose) so the kernel's context budget can model the
 *  size precisely and so PR 4's typed-memory replacement can produce
 *  a drop-in alternative shape. */
export function formatPriorTurnsPreamble(summaries: PriorTurnSummary[]): string {
  if (summaries.length === 0) return '';
  const lines: string[] = ['Prior turns in this chat (oldest to newest):'];
  for (const turn of summaries) {
    lines.push(`- Task: ${turn.task}`);
    lines.push(`  Outcome: ${turn.summary}`);
  }
  lines.push('');
  return lines.join('\n');
}
