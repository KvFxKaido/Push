# Provider Observability via Analytics Engine

Date: 2026-04-28
Status: Spec — not yet implemented. v1 covers all OpenAI-compatible chat handlers (gateway-routed and direct).

## Context

Cloudflare AI Gateway gives us logs, cost tracking, and caching, but only for providers in CF's catalog (`openrouter`, `anthropic`, `openai`, `vertex`, etc. — full list in `Cloudflare AI Gateway Integration.md`). Six of our OpenAI-compatible providers — Ollama Cloud, OpenCode Zen, Kilo Code, OpenAdapter, Nvidia NIM, Blackbox AI — are not in that catalog and CF does not support BYO upstreams. They will continue to flow through our Worker proxy directly.

LiteLLM was the obvious "self-hostable gateway with arbitrary upstream support" answer; the April 2026 breach took it off the table for now.

This spec adds aggregate observability inside the Worker for every provider call — gatewayed or not — so we get one consistent dashboard surface across the whole catalog without depending on a third-party gateway for the non-CF providers.

## What v1 does

One Workers Analytics Engine dataset, one writeDataPoint per terminal request boundary in `createStreamProxyHandler`, one read endpoint behind a bearer token.

### Schema

```
schema_version = "1"

blobs:   [schema_version, provider, model, route_class, error_code]
doubles: [ttfb_ms, duration_ms, upstream_status,
          bytes_in, bytes_out, tokens_in, tokens_out,
          cache_hit, success]
indexes: [provider]
```

Field semantics:

- **schema_version** — string, first blob. Future positional changes bump this so SQL queries can filter `WHERE blob1 = '1'` and never silently mix shapes. Add new fields by appending; reorder only by bumping.
- **provider** — same identifier we use in route paths (`openrouter`, `zen`, `kilocode`, etc.).
- **model** — exactly the model string the request asked for. No normalization.
- **route_class** — `gateway-cf` (CF AI Gateway hop), `gateway-lite` (our Worker proxy with no CF hop), `direct` (reserved for future bypass paths). Lets us compare the three.
- **error_code** — empty string on success; otherwise the same code we already emit (`UPSTREAM_QUOTA_OR_RATE_LIMIT`, `TIMEOUT`, etc.). No raw error messages.
- **ttfb_ms** — request start → upstream first byte received.
- **duration_ms** — request start → upstream stream fully drained (or error terminal).
- **upstream_status** — HTTP status code from the upstream; `0` if we never reached it (auth failure, validation rejection).
- **bytes_in / bytes_out** — request body bytes / upstream response bytes (running counter for streams).
- **tokens_in / tokens_out** — `-1` when unknown. Many providers omit `usage` from streamed responses; do not pretend zero.
- **cache_hit** — `0` or `1`. `-1` when caching is not yet wired (v1 default until a future tier ships caching).
- **success** — `0` or `1`. Aligns with `upstream_status < 400 && !error_code`.

### Indexing

Single index on `provider`. Cheapest natural slice for "how is X behaving today" queries. Tradeoff documented:

- **Why provider, not (provider, model)** — AE allows one index per write. Provider is the lowest-cardinality choice and the one we most often filter by first. Model is still queryable via blob predicates; it is just not the index-accelerated path.
- **What we lose** — model-only filters (`WHERE blob3 = 'gpt-4o'` across all providers) scan instead of seek. Acceptable at our traffic; revisit if dashboards get slow.
- **What we'd change** — if model filtering becomes the dominant query, write a second dataset with `index = model` rather than reshape the first. Datasets are cheap; reshaping breaks history.

### Sampling

Write 100% of requests in v1. AE free tier is 10M datapoints/month; we are nowhere near that. Revisit only if a future surge demands it.

## Read endpoint

`GET /api/_stats?window=24h&group_by=provider`

Auth: `Authorization: Bearer <STATS_ADMIN_TOKEN>`. Separate env var, **not** the existing app session/role layer. Reasoning: this surface predates a real admin role, and a plain bearer keeps the blast radius small until the app actually grows multi-user admin semantics.

Query params:

- `window` — `1h | 24h | 7d | 30d`. Fixed buckets only; no arbitrary ranges in v1 to keep SQL templated.
- `group_by` — `provider | provider,model | route_class`.

Response shape:

```json
{
  "window": "24h",
  "totals": { "requests": 1240, "success_rate": 0.97, "p95_ms": 2100 },
  "groups": [
    {
      "provider": "openrouter",
      "requests": 412,
      "success_rate": 0.98,
      "p50_ms": 850,
      "p95_ms": 2400,
      "errors_by_code": { "UPSTREAM_QUOTA_OR_RATE_LIMIT": 6, "TIMEOUT": 2 },
      "tokens_in": 142000,
      "tokens_out": 38000,
      "cache_hit_rate": null
    }
  ]
}
```

`cache_hit_rate` is `null` when no rows in the window have `cache_hit >= 0` (i.e. caching is not wired yet). Once caching ships it becomes a fraction in `[0, 1]`.

The Worker holds the SQL templates and calls AE's SQL API. No client-supplied SQL, no dynamic GROUP BYs beyond the enumerated `group_by` values.

## What v1 does NOT do

Out of scope; opening any of these is its own decision:

- **UI.** Ship the endpoint first. Build a `/admin/providers` page only after the endpoint proves useful and we know what slice to render.
- **Cost / $ per token.** Maintaining a model-price table is real ongoing toil and prices churn. Track raw token counts; let consumers compute cost externally if they want it.
- **Per-request lookup.** AE is for aggregates. `request_id` stays in `wlog` only; if we want per-request inspection later, that is a Workers Logs query (or a Logpush-to-storage decision), not an AE surface.
- **App-role auth.** A bearer token is enough until we have real admin roles. Migrate when the app does.
- **Caching.** Tier 3 from the original discussion. The schema reserves `cache_hit` so we can light it up without a bump to `schema_version`.

## Where the seams will live

- `wrangler.jsonc` — declare the dataset binding:
  ```jsonc
  "analytics_engine_datasets": [
    { "binding": "PROVIDER_STATS", "dataset": "push_provider_stats" }
  ]
  ```
  No account-bound identifiers added; safe for the public repo (per `feedback_public_repo_wrangler_vars.md`).
- `worker-middleware.ts` — a single telemetry helper (`writeProviderStat(env, fields)`) called at the stream terminal boundary inside `createStreamProxyHandler`. Centralized so all six handlers + OpenRouter pick it up automatically.
- `worker-stats.ts` (new) — the `/api/_stats` handler, SQL templates, bearer auth, response shaping.
- Tests — schema-version pinning (any reorder of blobs/doubles must bump the version), bearer auth (missing/invalid token → 401), one happy-path query per `group_by`.

## Build order

1. Add `analytics_engine_datasets` binding in `wrangler.jsonc`. Confirm typing flows into `Env`.
2. Add `writeProviderStat` helper + invoke it at the terminal boundary of `createStreamProxyHandler` (success, upstream error, timeout, validation reject — all four exits write).
3. Add `/api/_stats` handler with bearer-token auth, fixed windows, enumerated group_by.
4. Update this doc with anything that shifted during build, then mark Status: v1 — shipped.

UI is a separate decision after the endpoint is in production.

## Open questions deferred until the endpoint exists

- Do we want a "compare gateway-cf vs gateway-lite" canned query, or leave that to ad-hoc SQL?
- When (or whether) to add a cost table.
- When to migrate auth from `STATS_ADMIN_TOKEN` to a real admin role.
