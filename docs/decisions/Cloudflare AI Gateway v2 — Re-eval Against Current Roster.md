# Cloudflare AI Gateway v2 — Re-eval Against Current Roster

Date: 2026-07-09
Status: Draft

## Why re-open this

[`Cloudflare AI Gateway Integration.md`](../archive/decisions/Cloudflare%20AI%20Gateway%20Integration.md) (2026-04-25) scoped AIG narrowly: an opt-in **observability + resilience proxy** for exactly two upstream paths (OpenRouter chat, Workers AI binding), explicitly **not** a routing brain. Full adoption was deferred because Push fans out across many providers that were **not first-party AIG providers** and would have needed the universal endpoint (different request shape + failover semantics). That conclusion — "we're too unique to move wholesale" — was correct *as of April*.

Two things have changed since:

1. **CF shipped a new unified REST API (2026-05-21)** on `api.cloudflare.com` (see next section), with three compat endpoints — `/ai/v1/chat/completions` (`openai-compat`), `/ai/v1/responses` (`openai-responses`), `/ai/v1/messages` (`anthropic`) — plus **custom providers** (any OpenAI-compat base URL) and **unified billing** (no per-provider keys). Note Push has a **fourth** wire shape, `gemini` (`google`, `vertex`; `ProviderStreamShape` in `lib/provider-definition.ts`), which maps to none of these three and routes via the google-ai-studio provider path instead.
2. **The roster churned.** The April blocker list named OpenAdapter, Blackbox, Ollama Cloud — all since dropped. Fireworks and Sakana are new. Kilo Code, Zen, Nvidia, and Ollama remain and are still not first-party.

So the blocker is no longer "AIG can't represent our providers" — it's now a much smaller tail of hard-auth providers.

## Two AIG surfaces — don't conflate them

AIG is now two distinct products, and the capabilities split across them:

- **Legacy gateway proxy** — `gateway.ai.cloudflare.com/v1/{account}/{slug}/{provider}/…`. You send the provider's own request with **your own provider key**; the gateway layers on observability, caching, rate-limiting, fallback. This is what Push's **v1 seam already wires**: `buildAiGatewayUrl` (`worker-middleware.ts`) builds exactly this URL and keeps the provider `Authorization` header plus optional `cf-aig-authorization`. No unified billing, no custom providers.
- **Unified REST API** — `api.cloudflare.com/…/ai/v1/{chat/completions,responses,messages}`. CF fronts the model with **unified billing** (no per-provider keys) and **custom providers** (arbitrary OpenAI-compat base URLs). This is a **separate integration Push has not built** — the v1 `gateway:` helper does not reach it.

| Capability | Legacy proxy (v1, wired) | Unified REST API (not wired) |
|---|---|---|
| Observability / caching / fallback | ✅ | ✅ |
| Bring-your-own provider key | required | not needed |
| Unified billing | ❌ | ✅ |
| Custom (non-first-party) providers | ❌ | ✅ |

This distinction drives the buckets: **Bucket A rides the legacy proxy (cheap, wired); Bucket C's custom-provider unlock exists only on the REST API (new wiring).** The earlier version of this doc conflated the two and wrongly credited the one-line v1 extension with unified billing — it does not.

## The boundary that does NOT change

AIG is **transport + observability + caching + fallback**. It is **not** the routing brain. Provider/model selection per role stays in `lib/` (chat-lock + role-context). Even if every provider routed through AIG, `lib/` still decides *which* provider/model each role uses. Nothing below proposes moving routing out of `lib/`.

## Current roster × AIG support

Push's 15 network providers (`lib/provider-definition.ts`), mapped against AIG's current first-party list (Anthropic, OpenAI, Groq, Mistral, Cohere, Perplexity, Workers AI, Google-AI-Studio, Vertex, xAI, DeepSeek, Cerebras, Baseten, Parallel) and the custom-provider unlock:

| Provider | Wire shape | AIG path | Bucket |
|---|---|---|---|
| **cloudflare** (Workers AI) | openai-compat | first-party — **already wired (v1)** | A |
| **openrouter** | openai-responses | native path — **already wired (v1)** | A |
| **openai** | openai-responses | first-party (`/ai/v1/responses`) | **A — add now** |
| **anthropic** | anthropic | first-party (`/ai/v1/messages`) | **A — add now** |
| **google** (AI Studio) | gemini | first-party (google-ai-studio path) | **A — add now** |
| **deepseek** | anthropic (`/anthropic` endpoint) | first-party, but Push uses the non-standard `/anthropic` variant | B — verify variant |
| **vertex** | gemini | first-party, but service-account auth | B — auth wrinkle |
| **fireworks** | openai-responses | custom provider (`/responses`) | C — new unlock |
| **nvidia** | openai-compat | custom provider | C — new unlock |
| **zen** | openai-compat | custom provider | C — new unlock |
| **kilocode** | openai-compat | custom provider | C — new unlock |
| **sakana** | openai-responses | custom provider | C — new unlock |
| **ollama** (Ollama Cloud) | openai-compat | custom provider (public `ollama.com/v1` endpoint) | C — new unlock |
| **azure** | openai-compat | region-derived URLs, custom auth | D — deferred |
| **bedrock** | openai-compat | AWS SigV4 auth | D — deferred |

### Buckets

- **A — first-party, ride the legacy proxy (5).** Two already wired; **openai / anthropic / google** are first-party and add via one declarative `gateway:` line per handler on the **existing v1 legacy-proxy seam** (`AiGatewayBinding` / `buildAiGatewayUrl` / `getAiGatewayAuthHeader` in `worker-middleware.ts`). This buys **observability / caching / fallback with your own provider key** — **not** unified billing (that's the REST API, not the legacy proxy). Google's native `gemini` request (`:streamGenerateContent` in `handleGoogleChat`) passes through the legacy proxy transparently, so it works here even though it matches none of the REST compat endpoints.
- **B — feasible, verify first (2).** `deepseek` is first-party but Push calls its **`/anthropic` endpoint**, not the standard DeepSeek path AIG proxies — confirm AIG passes that variant (or fall back to DeepSeek's OpenAI-compat path). `vertex` is first-party but its service-account auth is the same wrinkle April flagged.
- **C — non-first-party, needs the REST API (6).** `fireworks / nvidia / zen / kilocode / sakana / ollama` are all OpenAI-compat/-responses over public endpoints, so each can be a **custom provider** — but custom providers exist **only on the unified REST API**, which Push has **not** wired. So Bucket C is *not* "one line on v1"; it requires the Path 2 integration below. Once that exists, these unlock — **Kilo Code and Ollama Cloud** move from "unsupported" to "supported via custom provider" (Push uses Ollama Cloud `ollama.com/v1`, not local, so the localhost objection never applied).
- **D — stays out (2).** `azure` (region-derived URLs) and `bedrock` (AWS SigV4 auth) remain custom-auth deferrals — the only genuinely stuck providers.

## Recommendation — two paths, sequenced

**Path 1 — extend the legacy proxy to Bucket A (cheap, already wired).** Add the `gateway:` opt-in to the `openai` / `anthropic` / `google` handlers. Same env-var gating as v1 (dormant until `CF_AI_GATEWAY_*` set; rollback = delete the vars). Buys observability / caching / fallback on the frontier roles with BYO keys. Does **not** get unified billing or any non-first-party provider. Also spike **Bucket B** here (`deepseek` `/anthropic` variant, `vertex` SA auth) before committing those.

**Path 2 — adopt the unified REST API (bigger lift, unlocks the rest).** New wiring against `api.cloudflare.com/…/ai/v1` — this, *not* Path 1, is what delivers **unified billing** and the **custom-provider unlock** for Bucket C (`fireworks / ollama / kilocode / …`). It's what the "Why re-open" excitement was actually about; scope it as its own change, not a one-liner on the v1 seam.

**Bucket D** stays direct-to-provider, as today.

Net: "too unique to move" is now false for the **majority** of the roster — but *what* you get depends on the surface. The legacy proxy (wired) buys observability on first-party providers now; unified billing and the non-first-party providers need the separate REST API integration. The genuinely stuck tail is 2 providers (Bedrock SigV4, Azure region-auth), and the routing brain stays in `lib/` regardless.

## Open questions / verification to-dos

- Does AIG's first-party DeepSeek provider proxy the `/anthropic` endpoint, or only the standard `deepseek-chat` path? (Determines whether `deepseek` is Bucket A or C.)
- Unified-billing margin on open-weight models vs. calling the provider direct — confirm the per-token delta before routing cost-sensitive volume through it.
- Are the `CF_AI_GATEWAY_*` vars currently set in production, i.e., is v1 live or dormant today?
- Cache hit-rate is low on the evolving main loop (context grows per turn); the win is on repeated sub-calls. Don't budget caching as a blanket latency fix.
