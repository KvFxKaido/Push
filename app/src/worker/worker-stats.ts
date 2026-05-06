import { wlog, type Env } from './worker-middleware';
import { REQUEST_ID_HEADER } from '../lib/request-id';

/**
 * GET /api/_stats handler — Analytics Engine SQL gateway.
 *
 * Returns a subset of the schema defined in
 * docs/decisions/Provider Observability via Analytics Engine.md:
 * requests, success_rate, latency percentiles (p50/p95), and token sums.
 * Fields `totals` and `errors_by_code` are not yet implemented.
 *
 * Requires:
 *   - STATS_ADMIN_TOKEN — Bearer token for this endpoint
 *   - CF_AI_GATEWAY_ACCOUNT_ID — Cloudflare account ID
 *   - CF_ANALYTICS_TOKEN — Cloudflare API token with `Analytics Engine: Read` permission
 *     (this is NOT the AI Gateway token; gateway tokens are scoped to gateway.ai.cloudflare.com
 *     and do not have Analytics:Read access to the SQL API at api.cloudflare.com)
 */
export async function handleStats(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  const token = env.STATS_ADMIN_TOKEN?.trim();
  const requestId = request.headers.get(REQUEST_ID_HEADER) ?? undefined;

  if (!token || authHeader !== `Bearer ${token}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const window = url.searchParams.get('window') || '24h';
  const groupBy = url.searchParams.get('group_by') || 'provider';

  // Validate params to prevent SQL injection (though we use templates, it's good practice)
  // CF Analytics Engine SQL takes INTERVAL as `'<number>' <unit>` — the number
  // is a quoted string and the unit is a bare keyword. The combined form
  // `'1 DAY'` and the bare-number form `1 DAY` both fail the AE parser.
  const validWindows: Record<string, { count: string; unit: string }> = {
    '1h': { count: '1', unit: 'HOUR' },
    '24h': { count: '1', unit: 'DAY' },
    '7d': { count: '7', unit: 'DAY' },
    '30d': { count: '30', unit: 'DAY' },
  };
  const interval = validWindows[window] || { count: '1', unit: 'DAY' };

  const validGroups: Record<string, string[]> = {
    provider: ['blob2'],
    'provider,model': ['blob2', 'blob3'],
    route_class: ['blob4'],
  };
  const groups = validGroups[groupBy] || ['blob2'];
  const groupSelect = groups.join(', ');

  // Analytics Engine SQL API requires Account ID and a Cloudflare API token with
  // Analytics Engine: Read permission. CF_ANALYTICS_TOKEN is a dedicated env var
  // for this — do NOT reuse CF_AI_GATEWAY_TOKEN which is gateway-scoped only.
  const accountId = env.CF_AI_GATEWAY_ACCOUNT_ID;
  const apiToken = env.CF_ANALYTICS_TOKEN;

  if (!accountId || !apiToken) {
    return new Response(
      JSON.stringify({
        error:
          'Worker not configured for stats. Set CF_AI_GATEWAY_ACCOUNT_ID and CF_ANALYTICS_TOKEN (an API token with Analytics Engine: Read permission).',
      }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  // Template the query.
  // CF Analytics Engine SQL constraints driving this shape (see
  // docs/runbooks/Provider Stats Endpoint.md for the full dialect notes):
  //   - Percentile uses the parameterized `quantileWeighted(level)(value, weight)`
  //     form with the built-in `_sample_interval` column as the weight.
  //     ClickHouse `quantile`/`quantileIf` and the flat 3-arg variant are
  //     not exposed.
  //   - `if(cond, then, else)` is type-strict: Double + Integer fails (use 0.0,
  //     not 0); Double + Null fails (no inline way to drop sentinel rows).
  // Sentinel handling:
  //   - Token sums use `if(x > 0, x, 0.0)` — both branches are Double.
  //   - Latency percentiles include failed-request rows with double1=-1,
  //     which slightly drags p50/p95 below the true value when failures are
  //     non-trivial. Acceptable for v1; tighten later if needed.
  const query = `
    SELECT
      ${groupSelect},
      count() as requests,
      avg(double9) as success_rate,
      quantileWeighted(0.5)(double1, _sample_interval) as p50_ms,
      quantileWeighted(0.95)(double1, _sample_interval) as p95_ms,
      sum(if(double6 > 0, double6, 0.0)) as tokens_in,
      sum(if(double7 > 0, double7, 0.0)) as tokens_out
    FROM push_provider_stats
    WHERE timestamp > now() - INTERVAL '${interval.count}' ${interval.unit}
      AND blob1 = '1'
    GROUP BY ${groupSelect}
    ORDER BY requests DESC
  `;

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
        },
        body: query,
      },
    );

    if (!response.ok) {
      const upstreamBody = await response.text().catch(() => '');
      wlog('error', 'stats_ae_query_failed', {
        requestId,
        status: response.status,
        body: upstreamBody.slice(0, 500),
      });
      return new Response(
        JSON.stringify({ error: 'Analytics Engine query failed', status: response.status }),
        {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    interface AnalyticsResult {
      data: Array<Record<string, string | number>>;
    }
    const result = (await response.json()) as AnalyticsResult;

    if (!result.data || !Array.isArray(result.data)) {
      return new Response(
        JSON.stringify({ error: 'Unexpected Analytics Engine response structure' }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // Map raw blobs back to readable keys
    const blobMap: Record<string, string> = {
      blob2: 'provider',
      blob3: 'model',
      blob4: 'route_class',
    };

    const groups_data = result.data.map((row) => {
      const mapped: Record<string, string | number> = {};
      for (const b of groups) {
        mapped[blobMap[b] || b] = row[b];
      }
      return {
        ...mapped,
        requests: row.requests,
        success_rate: Math.round((row.success_rate as number) * 100) / 100,
        p50_ms: Math.round(row.p50_ms as number),
        p95_ms: Math.round(row.p95_ms as number),
        tokens_in: row.tokens_in,
        tokens_out: row.tokens_out,
      };
    });

    return Response.json({
      window,
      groups: groups_data,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    wlog('error', 'stats_internal_error', { requestId, message });
    return new Response(JSON.stringify({ error: 'Internal stats error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
