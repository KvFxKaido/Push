## Provider Stats Endpoint

**Date:** 2026-05-02
**Status:** Active — endpoint shipped 2026-04-29, this runbook covers operating it.
**Decision:** [`docs/decisions/Provider Observability via Analytics Engine.md`](../decisions/Provider%20Observability%20via%20Analytics%20Engine.md)

## What this is

Aggregate observability for **every** provider call in the Worker — gatewayed or not. Backed by Workers Analytics Engine, exposed at `GET /api/_stats`. Covers the providers Cloudflare AI Gateway can't see (Ollama Cloud, OpenCode Zen, Kilo Code, OpenAdapter, Nvidia NIM, Blackbox AI) alongside the gatewayed ones, in a single dashboard surface.

## Mental model

Two surfaces, configured separately:

| Surface | Status | What it needs |
|---|---|---|
| **Writes** — `writeProviderStat` in `worker-middleware.ts`, fires at every terminal boundary in `createStreamProxyHandler` | Always on once `PROVIDER_STATS` binding exists | The dataset binding in `wrangler.jsonc` (already shipped) |
| **Reads** — `GET /api/_stats` handler in `app/src/worker/worker-stats.ts` | Requires 2 secrets | `STATS_ADMIN_TOKEN` + `CF_ANALYTICS_TOKEN` |

Writes have been accumulating since 2026-04-29. The read endpoint 401s until you set both secrets.

## The four-tokens problem

Easy to conflate. They are distinct:

| Secret | Used by | Where it comes from |
|---|---|---|
| `CF_AI_GATEWAY_TOKEN` | AI Gateway hop in `worker-middleware.ts` | CF dashboard → AI → AI Gateway → API tokens. **Cannot read AE.** |
| `CF_ANALYTICS_TOKEN` | `worker-stats.ts` query path → `api.cloudflare.com` | CF dashboard → My Profile → API Tokens → Custom token, scope: `Account → Analytics → Read` |
| `STATS_ADMIN_TOKEN` | Bearer auth on `/api/_stats` itself | You generate it; bind it on the Worker |
| `ADMIN_TOKEN` | Other admin endpoints (not stats) | Unrelated; do not reuse for stats |

`CF_AI_GATEWAY_TOKEN` and `CF_ANALYTICS_TOKEN` are both Cloudflare API tokens but with different scopes — one talks to `gateway.ai.cloudflare.com`, the other to `api.cloudflare.com`. There is no single token that does both.

## First-time setup

1. **Create the CF API token for AE reads.** Go to https://dash.cloudflare.com/profile/api-tokens → Create Custom Token → Permissions: `Account → Analytics → Read`. Scope to your account. Copy the value.

2. **Set both Worker secrets:**
   ```bash
   # Strong random bearer for /api/_stats
   openssl rand -hex 32 | npx wrangler secret put STATS_ADMIN_TOKEN

   # Paste the CF API token from step 1 when prompted
   npx wrangler secret put CF_ANALYTICS_TOKEN
   ```

3. **Verify with `npx wrangler secret list`.** Both names should appear.

`CF_AI_GATEWAY_ACCOUNT_ID` should already be set from the AI Gateway integration. If not, set it from CF dashboard → Workers & Pages → your account ID.

## Querying

```bash
curl -H "Authorization: Bearer $STATS_ADMIN_TOKEN" \
  'https://<your-worker-host>/api/_stats?window=24h&group_by=provider'
```

Params (enumerated, not free-form):

- `window` — `1h | 24h | 7d | 30d`
- `group_by` — `provider | provider,model | route_class`

`route_class` discriminates the three ingress paths:

- `gateway-cf` — went through CF AI Gateway (logs also visible in AI Gateway dashboard)
- `gateway-lite` — direct Worker proxy, no CF hop (the six non-catalog providers go here)
- `direct` — reserved for future bypass paths

Filter on `route_class=gateway-lite` when you specifically want the non-gateway providers.

## What you can and can't see

**Can:** request count, success rate, p50/p95 latency, token sums, errors by code, cache hit rate (when caching ships).

**Cannot:** per-request inspection. AE is aggregates only. `tokens_in`/`tokens_out` may be `-1` when the provider doesn't emit `usage` on streamed responses — that's intentional, not a bug. Cost in dollars is also out of scope (price tables churn; the doc deliberately avoids them).

For per-request inspection of **gatewayed** traffic, use Cloudflare AI Gateway logs at https://dash.cloudflare.com/ → AI → AI Gateway → push-gate → Logs (or the AI Gateway MCP tools).

For per-request inspection of **non-gatewayed** traffic, there is nothing today. `request_id` lives in `wlog` only; if you want it back, that's a future Workers Logs / Logpush decision (open question in the decision doc).

## CF Analytics Engine SQL dialect — gotchas

The handler shipped 2026-04-29 with a query written against ClickHouse syntax. CF AE exposes only a subset, with stricter type rules. Three bugs were fixed when the endpoint was first activated 2026-05-06; if you're rewriting the query, mind these:

- **Percentiles use the parameterized form.** `quantile(...)` and `quantileIf(...)` are not exposed. Only `quantileWeighted(level)(value, weight)` works (note the curried `(level)(...)` shape). Pass the built-in `_sample_interval` column as the weight — it's automatically populated and matches AE's expected weight semantics. Example: `quantileWeighted(0.5)(double1, _sample_interval)`.
- **`INTERVAL` wants `'<n>' <unit>`, not `'<n> <unit>'`.** AE rejects `INTERVAL '1 DAY'` ("non-integer INTERVAL"). The number is a quoted string, the unit is a bare keyword: `INTERVAL '1' DAY`. Bare-number form `INTERVAL 1 DAY` also fails.
- **`if(cond, then, else)` is type-strict.** `if(double_col > 0, double_col, 0)` fails because `0` is Integer; use `0.0`. `if(double_col > 0, double_col, NULL)` also fails because Double + Null isn't auto-promoted. There's no inline way to drop sentinel rows from an aggregate; for the percentile we accept that `-1` failed-request rows pull the value down slightly.

When AE returns "type error" without a specific column, simplify the query down to `SELECT count() as requests` + `GROUP BY` and add aggregates back one at a time. The error messages are vague when more than one type is in play.

## Common failure modes

- **401 Unauthorized** — `STATS_ADMIN_TOKEN` is missing or you sent the wrong value in the `Authorization` header.
- **502 with `Analytics Engine query failed`, `status: 422`** — the AE SQL parser rejected the query. Tail `npx wrangler tail --format pretty` and look for the `stats_ae_query_failed` event; the `body` field has CF's exact complaint. Common cause: editing the query without honoring the dialect rules above. Less common: `CF_ANALYTICS_TOKEN` has wrong scope (needs `Analytics: Read`) or `CF_AI_GATEWAY_ACCOUNT_ID` is wrong.
- **503 with `Worker not configured for stats`** — `CF_AI_GATEWAY_ACCOUNT_ID` or `CF_ANALYTICS_TOKEN` is missing entirely. Confirm with `npx wrangler secret list`; both names must appear.
- **Empty `groups` array but no error** — no traffic in the window. Try `window=7d`, or confirm the Worker is actually deployed with the `PROVIDER_STATS` binding (`wrangler deployments list`).
- **Schema mismatch errors** — someone reordered blobs/doubles in `writeProviderStat` without bumping `schema_version`. The decision doc requires the version bump; check git blame on `worker-middleware.ts`.

## Known data-quality issues (write-side)

Surfaced when the read endpoint first went live 2026-05-06. Both are bugs in `writeProviderStat`, separate from the read path:

- **Every row tags `route_class=direct`.** The decision doc reserves `direct` for "future bypass paths" and says the six non-CF providers should write `gateway-lite`. The helper is mislabeling, so the `route_class=gateway-lite` filter currently returns nothing. Fix: audit the `route_class` arg passed at every `writeProviderStat` call site in `worker-middleware.ts`.
- **No `gateway-cf` rows.** Gatewayed providers (Anthropic, OpenAI, etc. via CF AI Gateway) aren't being captured by `writeProviderStat`, or they're tagged something else. May be intentional (those have CF Gateway logs already) or a v1 gap. Confirm or close in a follow-up.

## Future surfaces

- A `/admin/providers` UI page is deferred until the endpoint proves useful (decision doc, "What v1 does NOT do").
- Token-to-cost translation is deferred (price-table maintenance toil).
- Per-request lookup is deferred to a future Workers Logs / Logpush decision.
- App-role auth (replacing the bearer) is deferred until the app grows real admin roles.
- Conditional sentinel filtering for percentiles is deferred — would need a CTE or a separate query path. Acceptable for v1 since failed requests are rare in normal operation.
