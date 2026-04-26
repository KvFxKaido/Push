# Cloudflare AI Gateway Integration

Date: 2026-04-25
Status: v1 — OpenRouter chat + Workers AI binding only.

## Context

The provider routing layer is on the roadmap but not started. AI Gateway is a useful first brick: it sits in front of the existing provider calls without restructuring them and pays for itself in observability (logs, request/response payloads, latency, cost) plus drop-in caching and rate limiting. Crucially, **it is not a routing brain**. It does not pick provider/model — that remains owned by the chat-lock and role-context logic in `lib/`. This integration is observability and resilience infrastructure, not provider routing yet.

## What v1 does

Two upstream paths are wired through the gateway, opt-in via env vars:

- **OpenRouter chat** (`/api/openrouter/chat`) — URL is rewritten to `https://gateway.ai.cloudflare.com/v1/{account}/{slug}/openrouter/chat/completions` when the gateway is configured.
- **Workers AI** (`/api/cloudflare/chat`) — `env.AI.run()` receives `{ gateway: { id: <slug> } }` natively. The binding handles auth via account context, so no `cf-aig-authorization` header is needed on this path.

Three optional env vars on the Worker (`Env` in `worker-middleware.ts`):

- `CF_AI_GATEWAY_ACCOUNT_ID` — Cloudflare account id hosting the gateway.
- `CF_AI_GATEWAY_SLUG` — the gateway id within that account.
- `CF_AI_GATEWAY_TOKEN` — only required when the gateway has authenticated mode enabled. When set, attaches `cf-aig-authorization: Bearer <token>` to gateway-bound HTTP requests.

> **Note on tokens.** Cloudflare's "Getting started" docs walk you through creating a *Cloudflare API token* with `AI Gateway - Read`/`Edit` permissions — that token is for managing the gateway via the CF REST API and is **not** what `CF_AI_GATEWAY_TOKEN` expects. The token this var wants is the per-gateway *Authenticated Gateway token*, generated inside the gateway's own Settings → Authentication tab after flipping the "Authenticated Gateway" toggle. If that toggle is off, leave `CF_AI_GATEWAY_TOKEN` unset entirely — the gateway accepts unauthenticated traffic and the helper stays a no-op.

When `CF_AI_GATEWAY_ACCOUNT_ID` or `CF_AI_GATEWAY_SLUG` is unset, every code path is a no-op and traffic flows direct to the upstream provider exactly as before. The token is independent: it only attaches the gateway auth header when the request is actually being routed through the gateway, so an orphan token without account/slug never leaks to the direct provider.

## What v1 does NOT do

Explicitly out of scope for this pass — opening these has follow-on schema/auth work that doesn't belong in the same change:

- **Universal endpoint.** The CF universal endpoint has a different request shape (provider-per-message routing) and different failover semantics. Not mixed in here.
- **Vertex / Azure / Bedrock.** Custom auth flows (Google service accounts, region-derived URLs, client-supplied bases). These can be added later by attaching a `gateway` binding to their handlers individually.
- **Anthropic-via-bridges** (Zen Go anthropic transport, Vertex Anthropic). Routes through Anthropic's `/v1/messages`, which has a different gateway provider slug and request body. Defer.
- **Generic OpenAI-compatible providers** (Zen, Kilocode, OpenAdapter, Nvidia, Blackbox, Ollama Cloud). Several are not first-party AI Gateway providers and would need the universal endpoint.
- **Provider routing logic.** AI Gateway is a proxy, not a router. Provider/model selection still belongs to the chat-lock + role-context layer in `lib/`.

## Where the seams live

- `worker-middleware.ts` — `AiGatewayBinding`, `buildAiGatewayUrl`, `getAiGatewayAuthHeader`, plus the optional `gateway` field on `StreamProxyConfig`. Each handler opts in by adding one declarative line.
- `worker-providers.ts` — OpenRouter chat declares `gateway: { provider: 'openrouter', pathSuffix: '/chat/completions' }`; Workers AI passes `{ gateway: { id: slug } }` to `env.AI.run()` when configured.
- `worker-providers.test.ts` — covers gateway env unset (URL unchanged, header omitted), account/slug set (URL rewritten, provider auth survives), token set (gateway auth attached), token unset (gateway auth omitted), and the orphan-token leak guard.

## Operational note

Everything can be done from the Cloudflare dashboard — no `wrangler` required. Workers & Pages → `push` → Settings → Variables and Secrets:

- `CF_AI_GATEWAY_ACCOUNT_ID` and `CF_AI_GATEWAY_SLUG` as plaintext vars (account ID is in the dashboard sidebar; slug is the gateway's own id).
- `CF_AI_GATEWAY_TOKEN` as an encrypted secret, only if authenticated mode is on (see the note above).

The Worker hot-reloads on the next request, so no redeploy is needed. Until the vars are set, the gateway is dormant and direct-to-provider traffic is bit-identical to pre-gateway behavior. To roll back, delete the vars — no code change.
