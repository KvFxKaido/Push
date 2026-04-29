import type { Env } from './worker-middleware';

/**
 * GET /api/_stats handler — Analytics Engine SQL gateway.
 * Implementation of docs/decisions/Provider Observability via Analytics Engine.md
 */
export async function handleStats(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  const token = env.STATS_ADMIN_TOKEN?.trim();

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
  const validWindows: Record<string, string> = {
    '1h': '1 HOUR',
    '24h': '1 DAY',
    '7d': '7 DAY',
    '30d': '30 DAY',
  };
  const interval = validWindows[window] || '1 DAY';

  const validGroups: Record<string, string[]> = {
    provider: ['blob2'],
    'provider,model': ['blob2', 'blob3'],
    route_class: ['blob4'],
  };
  const groups = validGroups[groupBy] || ['blob2'];
  const groupSelect = groups.join(', ');

  // Analytics Engine SQL API requires Account ID and a Cloudflare API Token (not the admin token).
  // We check for CF_AI_GATEWAY_ACCOUNT_ID as a reasonable fallback for the account ID.
  const accountId = env.CF_AI_GATEWAY_ACCOUNT_ID;
  const apiToken = env.CF_AI_GATEWAY_TOKEN; // Reusing gateway token for API access if possible, or following spec

  if (!accountId || !apiToken) {
    return new Response(
      JSON.stringify({ error: 'Worker not configured with Cloudflare API credentials for stats.' }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  // Template the query
  const query = `
    SELECT
      ${groupSelect},
      count() as requests,
      avg(double9) as success_rate,
      quantile(0.5)(double1) as p50_ms,
      quantile(0.95)(double1) as p95_ms,
      sum(double6) as tokens_in,
      sum(double7) as tokens_out
    FROM push_provider_stats
    WHERE timestamp > now() - INTERVAL '${interval}'
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
      const error = await response.text();
      return new Response(
        JSON.stringify({ error: 'Analytics Engine query failed', detail: error }),
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
    return new Response(JSON.stringify({ error: 'Internal stats error', message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
