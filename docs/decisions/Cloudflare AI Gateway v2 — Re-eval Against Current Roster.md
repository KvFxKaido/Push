# Cloudflare AI Gateway v2 — Re-eval Against Current Roster

Date: 2026-07-09
Status: Draft

## Why re-open this

[`Cloudflare AI Gateway Integration.md`](../archive/decisions/Cloudflare%20AI%20Gateway%20Integration.md) (2026-04-25) scoped AIG narrowly: an opt-in **observability + resilience proxy** for exactly two upstream paths (OpenRouter chat, Workers AI binding), explicitly **not** a routing brain. Full adoption was deferred because Push fans out across many providers that were **not first-party AIG providers** and would have needed the universal endpoint (different request shape + failover semantics). That conclusion — "we're too unique to move wholesale" — was correct *as of April*.

Two things have changed since:

1. **CF shipped a new unified REST API (2026-05-21)** on `api.cloudflare.com`, with three compat endpoints that happen to match Push's three wire shapes:
   - `/ai/v1/chat/completions` → `openai-compat`
   - `/ai/v1/responses` → `openai-responses`
   - `/ai/v1/messages` → `anthropic`
   Plus **custom providers** (any OpenAI-compat base URL becomes a routable provider) and **unified billing** (no per-provider keys).
2. **The roster churned.** The April blocker list named OpenAdapter, Blackbox, Ollama Cloud — all since dropped. Fireworks and Sakana are new. Kilo Code, Zen, Nvidia, and Ollama remain and are still not first-party.

So the blocker is no longer "AIG can't represent our providers" — it's now a much smaller tail of hard-auth and local-only providers.

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

- **A — route now, low risk (5).** Two already wired; **openai / anthropic / google** are each first-party but hit *different* AIG paths matching their wire shapes — `openai` via `/ai/v1/responses`, `anthropic` via `/ai/v1/messages`, `google` via the google-ai-studio (gemini) path — not one shared compat endpoint. Each still adds via one declarative `gateway:` line per handler (the v1 seam exists: `AiGatewayBinding` / `buildAiGatewayUrl` / `getAiGatewayAuthHeader` in `worker-middleware.ts`, `gateway:` opt-ins in `worker-providers.ts`). Immediate caching / observability / fallback / unified-billing, zero routing change.
- **B — feasible, verify first (2).** `deepseek` is first-party but Push calls its **`/anthropic` endpoint**, not the standard DeepSeek path AIG proxies — confirm AIG passes that variant (or fall back to DeepSeek's OpenAI-compat path). `vertex` is first-party but its service-account auth is the same wrinkle April flagged.
- **C — now possible via custom providers (6).** `fireworks / nvidia / zen / kilocode / sakana / ollama` are all OpenAI-compat or -responses over public endpoints, so each can be a **custom provider** (unified `/compat` for the compat ones, provider-specific endpoint for the `responses` ones). This is precisely the gap that "needed the universal endpoint" in April. Per-provider config; do opportunistically, not urgently. **Kilo Code and Ollama specifically** move from "unsupported" to "supported via custom provider" — note Push uses **Ollama Cloud** (`ollama.com/v1`, API-key auth), not local Ollama, so the old "gateway can't reach `localhost`" objection does not apply.
- **D — stays out (2).** `azure` (region-derived URLs) and `bedrock` (AWS SigV4 auth) remain custom-auth deferrals — the only genuinely stuck providers.

## Recommendation

1. **Extend v1 to Bucket A** — add the `gateway:` opt-in to the `openai` / `anthropic` / `google` handlers. Same env-var gating as v1 (dormant until `CF_AI_GATEWAY_*` set); rollback is deleting the vars. This is the high-value, low-risk step and covers the roles most likely to run frontier models.
2. **Spike Bucket B** — one test request each for `deepseek` (`/anthropic` variant through AIG) and `vertex` (service-account auth through the gateway) to confirm the wrinkles before committing.
3. **Leave Bucket C opportunistic** — model as custom providers when a given provider actually needs gateway caching/observability, not as a batch.
4. **Bucket D stays direct-to-provider**, as today.

Net: "too unique to move" is now false for the **majority** of the roster. What remains genuinely stuck is a 2-provider tail (Bedrock SigV4, Azure region-auth), and the routing brain stays in `lib/` regardless.

## Open questions / verification to-dos

- Does AIG's first-party DeepSeek provider proxy the `/anthropic` endpoint, or only the standard `deepseek-chat` path? (Determines whether `deepseek` is Bucket A or C.)
- Unified-billing margin on open-weight models vs. calling the provider direct — confirm the per-token delta before routing cost-sensitive volume through it.
- Are the `CF_AI_GATEWAY_*` vars currently set in production, i.e., is v1 live or dormant today?
- Cache hit-rate is low on the evolving main loop (context grows per turn); the win is on repeated sub-calls. Don't budget caching as a blanket latency fix.
