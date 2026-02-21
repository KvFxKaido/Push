/**
 * stats.mjs — Aggregate provider compliance and tool-usage metrics
 * from persisted session event logs.
 */
import { listSessions, loadSessionEvents } from './session-store.mjs';
import { fmt } from './format.mjs';

/**
 * Aggregate stats across all (or filtered) sessions.
 * Returns { providers: { [id]: ProviderStats }, totals: TotalStats }
 */
export async function aggregateStats(filter = {}) {
  const sessions = await listSessions();
  const providers = {};
  const totals = { sessions: 0, runs: 0, rounds: 0, toolCalls: 0, toolErrors: 0, malformedCalls: 0 };

  for (const session of sessions) {
    if (filter.provider && session.provider !== filter.provider) continue;
    if (filter.model && session.model !== filter.model) continue;

    let events;
    try {
      events = await loadSessionEvents(session.sessionId);
    } catch {
      continue;
    }

    const key = `${session.provider}/${session.model}`;
    if (!providers[key]) {
      providers[key] = {
        provider: session.provider,
        model: session.model,
        sessions: 0,
        runs: 0,
        rounds: 0,
        toolCalls: 0,
        toolErrors: 0,
        malformedCalls: 0,
        malformedReasons: {},
        outcomes: {},
      };
    }
    const p = providers[key];
    p.sessions++;
    totals.sessions++;

    for (const event of events) {
      switch (event.type) {
        case 'run_complete': {
          p.runs++;
          totals.runs++;
          const outcome = event.payload?.outcome || 'unknown';
          p.outcomes[outcome] = (p.outcomes[outcome] || 0) + 1;
          if (typeof event.payload?.rounds === 'number') {
            p.rounds += event.payload.rounds;
            totals.rounds += event.payload.rounds;
          }
          break;
        }
        case 'tool_call': {
          p.toolCalls++;
          totals.toolCalls++;
          break;
        }
        case 'tool_result': {
          if (event.payload?.isError) {
            p.toolErrors++;
            totals.toolErrors++;
          }
          break;
        }
        case 'malformed_tool_call': {
          p.malformedCalls++;
          totals.malformedCalls++;
          const reason = event.payload?.reason || 'unknown';
          p.malformedReasons[reason] = (p.malformedReasons[reason] || 0) + 1;
          break;
        }
        case 'error': {
          // Count provider-level errors
          if (event.payload?.code === 'PROVIDER_ERROR') {
            p.toolErrors++;
            totals.toolErrors++;
          }
          break;
        }
      }
    }
  }

  return { providers, totals };
}

/**
 * Format stats for terminal display.
 */
export function formatStats({ providers, totals }) {
  const lines = [];

  lines.push(fmt.bold('Push CLI — Provider Stats'));
  lines.push(fmt.dim('═'.repeat(50)));

  if (totals.sessions === 0) {
    lines.push(fmt.dim('No sessions found.'));
    return lines.join('\n');
  }

  lines.push(`Total: ${totals.sessions} sessions, ${totals.runs} runs, ${totals.rounds} rounds`);
  const errCount = totals.toolErrors > 0 ? fmt.yellow(String(totals.toolErrors)) : String(totals.toolErrors);
  const malCount = totals.malformedCalls > 0 ? fmt.yellow(String(totals.malformedCalls)) : String(totals.malformedCalls);
  lines.push(`${fmt.dim('Tool calls:')} ${totals.toolCalls} ${fmt.dim('|')} ${fmt.dim('Errors:')} ${errCount} ${fmt.dim('|')} ${fmt.dim('Malformed:')} ${malCount}`);
  lines.push('');

  const keys = Object.keys(providers).sort();
  for (const key of keys) {
    const p = providers[key];
    lines.push(`${fmt.bold('─ ' + key)}`);
    lines.push(`  ${fmt.dim('Sessions:')} ${p.sessions} ${fmt.dim('|')} ${fmt.dim('Runs:')} ${p.runs} ${fmt.dim('|')} ${fmt.dim('Rounds:')} ${p.rounds}`);
    const avgRounds = p.runs > 0 ? (p.rounds / p.runs).toFixed(1) : '-';
    lines.push(`  ${fmt.dim('Avg rounds/run:')} ${avgRounds}`);
    const pErr = p.toolErrors > 0 ? fmt.yellow(String(p.toolErrors)) : String(p.toolErrors);
    const pMal = p.malformedCalls > 0 ? fmt.yellow(String(p.malformedCalls)) : String(p.malformedCalls);
    lines.push(`  ${fmt.dim('Tool calls:')} ${p.toolCalls} ${fmt.dim('|')} ${fmt.dim('Errors:')} ${pErr} ${fmt.dim('|')} ${fmt.dim('Malformed:')} ${pMal}`);

    if (Object.keys(p.outcomes).length > 0) {
      const outcomeStr = Object.entries(p.outcomes).map(([k, v]) => `${k}:${v}`).join(', ');
      lines.push(`  ${fmt.dim('Outcomes:')} ${outcomeStr}`);
    }

    if (Object.keys(p.malformedReasons).length > 0) {
      const reasonStr = Object.entries(p.malformedReasons).map(([k, v]) => `${k}:${v}`).join(', ');
      lines.push(`  ${fmt.dim('Malformed reasons:')} ${reasonStr}`);
    }

    lines.push('');
  }

  return lines.join('\n');
}
