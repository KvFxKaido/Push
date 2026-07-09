# Cloudflare AI Gateway v2 — Re-eval Against Current Roster

Date: 2026-07-09
Status: **Draft** — Path 1 shipped, **verified live, and active in production** 2026-07-09 (openai/anthropic/google → `push-gate`, 200s in CF logs; prod `CF_AI_GATEWAY_*` secrets confirmed set; see Open questions); Path 1.5 spiked — `ollama` + 4 custom providers verified live 2026-07-09 (`kilocode` dropped); Bucket B — `deepseek` wired (first-party `/anthropic` verified), `vertex` deferred then removed with Bucket D (#1378); Path 2 remains design (settings two-tier unlock spec'd below).

## Why re-open this

[`Cloudflare AI Gateway Integration.md`](../archive/decisions/Cloudflare%20AI%20Gateway%20Integration.md) (2026-04-25) scoped AIG narrowly: an opt-in **observability + resilience proxy** for exactly two upstream paths (OpenRouter chat, Workers AI binding), explicitly **not** a routing brain. Full adoption was deferred because Push fans out across many providers that were **not first-party AIG providers** and would have needed the universal endpoint (different request shape + failover semantics). That conclusion — "we're too unique to move wholesale" — was correct *as of April*.

Three things have changed since:

1. **CF shipped a new REST API (2026-05-21)** on `api.cloudflare.com`, with `/ai/v1/chat/completions` (`openai-compat`), `/ai/v1/responses` (`openai-responses`), `/ai/v1/messages` (`anthropic`), and `/ai/run`. That API is the clean path for **unified billing** and model-prefix routing without per-provider keys. Note Push has a **fourth** wire shape, `gemini` (`google`, `vertex`; `ProviderStreamShape` in `lib/provider-definition.ts`), which maps to none of the three compat endpoints and routes via provider-native Google AI Studio when we preserve the current body shape.
2. **Custom providers exist on the gateway surface too.** CF now documents custom providers under `gateway.ai.cloudflare.com/v1/{account}/{gateway}/custom-{slug}/...`, with a provider-specific endpoint that preserves arbitrary upstream paths and native request bodies. This means non-first-party providers do **not** require the new REST API just to get AIG observability. They still need REST API work if the goal is Cloudflare unified billing / model-prefix routing.
3. **The roster churned.** The April blocker list named OpenAdapter, Blackbox, Ollama Cloud — all since dropped. Fireworks and Sakana are new. Kilo Code, Zen, Nvidia, and Ollama remain and are still not first-party.

So the blocker is no longer "AIG can't represent our providers" — it's now a much smaller tail of hard-auth providers.

## Three AIG surfaces — don't conflate them

AIG now has three relevant integration surfaces, and the capabilities split across them:

- **Provider-native gateway proxy** — `gateway.ai.cloudflare.com/v1/{account}/{slug}/{provider}/…`. You send the provider's own request with **your own provider key**; the gateway layers on observability, caching, rate-limiting, fallback. This is what Push's **v1 seam already wires**: `buildAiGatewayUrl` (`worker-middleware.ts`) builds exactly this URL and keeps the provider auth header plus optional `cf-aig-authorization`. No Cloudflare unified billing.
- **Custom provider-specific gateway proxy** — `gateway.ai.cloudflare.com/v1/{account}/{slug}/custom-{provider-slug}/…`. This is still the gateway host, not the new REST API. It can preserve arbitrary HTTPS upstream paths and native request bodies, so it is the cheap observability path for non-first-party providers once each custom provider is configured in AIG. Still BYO upstream key / BYOK; not the same as Cloudflare unified billing.
- **REST API** — `api.cloudflare.com/…/ai/v1/{chat/completions,responses,messages}` and `/ai/run`. CF fronts the model with Cloudflare auth and **unified billing** (no per-provider keys for supported third-party models). This is a **separate integration Push has not built** — the v1 `gateway:` helper does not reach it.

| Capability | Provider-native proxy (v1, wired) | Custom provider proxy (not wired) | REST API (not wired) |
|---|---|---|---|
| Observability / caching / fallback | ✅ | ✅ | ✅ |
| Bring-your-own provider key | required / BYOK | required / BYOK | not needed for unified-billing models |
| Unified billing | provider-dependent BYOK/unified modes, not Push's current seam | provider-dependent BYOK/unified modes, not Push's current seam | ✅ |
| Custom non-first-party providers | ❌ | ✅ | maybe, only where REST schema + model routing fit |

This distinction drives the buckets: **Bucket A rides the provider-native proxy (cheap, partly wired); Bucket C has a cheaper custom-provider proxy path for observability and a larger REST API path for unified billing.** The earlier version of this doc conflated custom providers with the REST API and wrongly treated custom-provider observability as a full REST migration — it is not.

## The boundary that does NOT change

AIG is **transport + observability + caching + fallback**. It is **not** the routing brain. Provider/model selection per role stays in `lib/` (chat-lock + role-context). Even if every provider routed through AIG, `lib/` still decides *which* provider/model each role uses. Nothing below proposes moving routing out of `lib/`.

## Current roster × AIG support

Push's 15 network providers (`lib/provider-definition.ts`), mapped against AIG's current first-party list and the custom-provider proxy:

| Provider | Wire shape | AIG path | Bucket |
|---|---|---|---|
| **cloudflare** (Workers AI) | openai-compat | first-party — **already wired (v1)** | A |
| **openrouter** | openai-responses | native path — **already wired (v1)** | A |
| **openai** | openai-responses | first-party provider-native (`/openai/responses`) | **A — wired** |
| **anthropic** | anthropic | first-party provider-native (`/anthropic/v1/messages`) | **A — wired** |
| **google** (AI Studio) | gemini | first-party provider-native (`/google-ai-studio/v1/models/...`) | **A — wired** |
| **deepseek** | anthropic (`/anthropic` endpoint) | first-party, but Push uses the non-standard `/anthropic` variant | B — verify variant |
| **vertex** | gemini | first-party, but service-account auth | B — auth wrinkle |
| **fireworks** | openai-responses | custom provider-specific (`/responses`) | C — spike |
| **nvidia** | openai-compat | custom provider | C — new unlock |
| **zen** | openai-compat | custom provider | C — new unlock |
| **kilocode** | openai-compat | custom provider | C — new unlock |
| **sakana** | openai-responses | custom provider-specific (`/responses`) | C — spike |
| **ollama** (Ollama Cloud) | openai-compat | custom provider (public `ollama.com/v1` endpoint) | C — new unlock |
| **azure** | openai-compat | region-derived URLs, custom auth | D — deferred |
| **bedrock** | openai-compat | AWS SigV4 auth | D — deferred |

### Buckets

- **A — first-party, ride the provider-native proxy (5).** OpenRouter, Workers AI, OpenAI, Anthropic, and Google AI Studio are now wired through the provider-native gateway surface when `CF_AI_GATEWAY_*` is configured. This buys **observability / caching / fallback with the current provider key** — **not** the REST API migration. Google's native `gemini` request (`:streamGenerateContent` in `handleGoogleChat`) passes through the provider-native `google-ai-studio` path transparently, so it works even though it matches none of the REST compat endpoints.
- **B — verified 2026-07-09 (2, split).** `deepseek` **done** — the first-party proxy passes Push's `/anthropic` variant (200 A/B, wired as a first-party binding). `vertex` **blocked on creds** — no service account is configured to test with, and it can't use a custom provider (its region lives in the host, `{region}-aiplatform.googleapis.com`, so a fixed `base_url` can't carry it). The design is clear (first-party `google-vertex-ai`, derive pathSuffix from the direct URL, `Authorization: Bearer <OAuth>` passthrough — CF's Claude Code integration confirms Bearer works), but shipping an untested first-party binding would go live in prod immediately and risk breaking vertex; deferred until a service account exists to verify against.
- **C — non-first-party custom-provider proxy candidates (6).** `fireworks / nvidia / zen / kilocode / sakana / ollama` are all public HTTPS endpoints. For observability, each can be configured as an AIG custom provider and routed through `custom-{slug}/...`; Responses-native providers should use the provider-specific path, not the deprecated `/compat/chat/completions` surface. This is *not* "one line on v1" because Push needs custom provider slugs/config plus per-provider path bindings, but it is smaller than adopting the REST API.
- **D — auth/shape deferrals (2).** `azure` and `bedrock` are supported by AIG provider-native docs, but Push should not casually move those credentials into AIG or BYOK without an explicit security/ops decision. Treat them as deferred, not impossible.

## Recommendation — two paths, sequenced

**Path 1 — shipped 2026-07-09.** The provider-native proxy now covers Bucket A (`openrouter`, Workers AI, `openai`, `anthropic`, `google`). Same env-var gating as v1 (dormant until `CF_AI_GATEWAY_*` set; rollback = delete the vars). This buys observability / caching / fallback on the frontier roles with BYO keys. It does **not** get Push onto the REST API or remove provider keys. **Bucket B** is now resolved: `deepseek` wired first-party (the `/anthropic` variant passes — verified), `vertex` deferred until a service account exists to test the `google-vertex-ai` binding.

**Path 1.5 — spike one custom provider. `ollama` done 2026-07-09, verified live.** Configure a Bucket C provider as an AIG custom provider, then route it through `custom-{slug}/...` using the existing gateway helper — **no URL-format change needed**: `buildAiGatewayUrl` with `provider: 'custom-ollama'`, `pathSuffix: '/v1/chat/completions'` already yields `.../custom-ollama/v1/chat/completions`, and the registered provider's `base_url` (`https://ollama.com`, domain-only) + that path reconstruct the direct upstream. Confirmed live in push-gate logs: `provider: custom-ollama`, 200, tokens/cost recorded. This proves the cheap observability path for Bucket C without the REST API migration cost.

Two design outputs that generalize to the rest of Bucket C (`fireworks / nvidia / zen / kilocode / sakana`):

- **Per-slug opt-in gate (`CF_AI_GATEWAY_CUSTOM_SLUGS`).** Prod already has `CF_AI_GATEWAY_*` set, so a bare `custom-` binding would have instantly flipped prod onto an *unregistered* custom provider and 502'd it. Custom providers therefore opt in per-slug via `isCustomGatewaySlugEnabled` (`worker-middleware.ts`); an unlisted `custom-` binding falls back to direct. Each additional Bucket C provider = register it + add its slug.
- **Register before allow-listing.** Routing to `custom-{slug}` before the provider exists returns `AiGatewayError` 2006 / 502 (observed at 09:26, resolved to 200 at 09:53 once registered). The gate makes this safe by default — the slug isn't listed until the provider is live.

**Fleet wired + verified 2026-07-09 — the remaining five.** `nvidia`, `zen`, `kilocode` (openai-compat, `/…/chat/completions`) and `sakana`, `fireworks` (Responses-native, `/…/responses`) all carry `custom-{slug}` bindings; every one routes to its correct path (confirmed in push-gate logs as `provider: custom-{slug}`). Live results split into "works" and "provider-side operational issue" — none were wiring bugs:

| provider | direct | gateway | note |
|---|---|---|---|
| sakana | — | **200** | Responses-over-custom-proxy passthrough works |
| fireworks | — | **200** | Responses-over-custom-proxy passthrough works |
| nvidia | 404 | 404 | gateway **transparent**; 404 is a stale default model id, not the proxy |
| zen | 200 | 429 | zen rate-limits Cloudflare's shared egress IP (provider-side) |
| kilocode | 200 | 404 | **dropped** — kilo.ai answers Cloudflare's egress with its marketing frontend (HTML 404) on *both* base_url configs tried (domain-only and fixed-prefix `…/api/gateway`) while answering direct requests with JSON. It discriminates against the proxy IPs, so it can't ride the custom proxy. Binding removed; kilocode stays direct-to-provider |

So Bucket C via custom proxy covers **five** — `ollama`, `nvidia`, `zen`, `sakana`, `fireworks`; `kilocode` is dropped (six attempted, one unusable). Takeaway for the tail: the custom-provider path is transparent (proven by nvidia's identical direct/gateway result and the two Responses 200s), but each provider can carry its own operational wrinkle that only shows up live — per-IP throttling of Cloudflare's egress (`zen`), or an outright egress-discriminating origin that makes the proxy unusable (`kilocode`). Check each provider live before allow-listing; don't assume correct URL wiring means a working route.

**Path 2 — adopt the REST API (bigger lift, unified billing).** New wiring against `api.cloudflare.com/…/ai/v1` — this is what delivers the clean Cloudflare-auth / unified-billing model. It likely needs model-id mapping (`openai/...`, `anthropic/...`, `google-ai-studio/...`), request-schema choices per provider, and a separate rollback plan from the provider-native proxy.

### Path 2 product design — the settings key wall becomes two-tier

Most of Path 2's real design is not the wiring — it's what happens to the unlock model. Today a provider lights up when its credentials resolve server-side: a Worker env secret or a user-stored key (`worker-provider-capabilities.ts`, same resolution path dispatch uses). Key = unlock, one per provider. Paths 1/1.5 don't touch this — they're BYOK, so the per-key unlock stays correct as long as the gateway is proxy-only. Path 2 changes it from *N keys, N unlocks* to **two tiers**:

- **Tier 1 — one Cloudflare token unlocks the unified-billing subset.** No provider key needed for CF-supported models (openai, anthropic, google, deepseek, …). One key in Settings lights up that whole slice of the catalog.
- **Tier 2 — per-provider keys remain, with two jobs.** (a) The **only** path for custom providers — `fireworks / ollama / zen / nvidia / sakana` stay BYOK even on the REST API, so their unlocks are unchanged forever. (b) An **override** for CF-supported providers — a direct key skips the CF fee and one hop.

**Precedence rule: direct key wins; the CF token fills gaps.** When both a CF token and a direct provider key exist, dispatch uses the direct key. Rationale: direct is cheaper (no unified-billing fee) and fewer hops, and it keeps the CF token's role legible — "unlocks what you haven't keyed directly," never a shadow re-route of billing for a provider the user deliberately keyed. Adding the CF token is therefore strictly additive: it can light up new models but can never silently change how an existing provider bills. (The inverse rule — CF-token-wins — fails the honest-surfaces test for exactly that reason.)

Eval-safety note: unified billing does **not** reintroduce OpenRouter's routing opacity. The backend is still the named provider — CF fronts the bill, not the routing — so Tier 1 selections remain pinned-upstream and eval-safe.

Pre-Path 2, one small settings change is already warranted: a **gateway status row** ("Routing via `push-gate` · observability active" when `CF_AI_GATEWAY_*` resolves). Bucket A/C traffic currently takes an extra hop that the UI doesn't disclose anywhere.

**Bucket D — dissolved by removal (2026-07-09).** `azure` / `bedrock` (and `vertex` from Bucket B) were deleted outright in #1378 rather than migrated — they were inert/unconfigured experimental providers, and removing them took the credential-placement question with them. If any returns, it re-enters as a fresh provider through this doc's buckets.

Net: "too unique to move" is now false for the **majority** of the roster — but *what* you get depends on the surface. The provider-native proxy buys observability on first-party providers now; custom providers can extend that observability to the non-first-party tail; the REST API is a separate unified-billing migration. The routing brain stays in `lib/` regardless.

## Open questions / verification to-dos

- ~~Does AIG's first-party DeepSeek provider proxy the `/anthropic` endpoint, or only the standard `deepseek-chat` path?~~ **Answered 2026-07-09 — yes, it passes the variant.** A direct-vs-gateway A/B on `…/deepseek/anthropic/v1/messages` returned 200 byte-identically (the `x-api-key` auth and the non-standard path both pass through the first-party proxy). So `deepseek` is **Bucket A-grade** — wired as a first-party binding (`provider: 'deepseek'`, pathSuffix derived from `DEEPSEEK_ANTHROPIC_URL`), no custom registration.
- **Gateway config itself taxes every request — partly answered 2026-07-09.** The per-request cost delta is *not* just the unified-billing credit-purchase fee. `push-gate` has **Guardrails enabled in FLAG mode** (all `prompt`/`response` categories `S1`–`S13` + `P1` = `FLAG`), so every routed request fires an extra Workers-AI `@cf/meta/llama-guard-3-8b` scan (prompt + response, same `event_id` as the provider call). Observed in the live logs: a single llama-guard scan billed **1,786 tokens_in / $0.00085 — larger than the `gpt-4o-mini` call it guarded ($0.0000033)**. FLAG mode never blocks or rewrites, so this has been observe-only cost since the gateway was created (2026-04-25), applied to **prod Workers-AI traffic too** (the `user_agent: cloudflare-worker` llama-guard entries), not just newly-routed providers. On the growing main loop this tax scales with prompt size and can dominate. **Before routing cost-sensitive volume: disable the guardrails (or move them to a surface that acts on the flags), and confirm the unified-billing per-token delta separately.** **Done 2026-07-09:** guardrails disabled on `push-gate` (config `modified_at 08:50:55`; later logs show `guardrails: null` and no paired llama-guard scans). Still to confirm: the unified-billing per-token delta. Also note `push-gate`'s 50 req/60s rate limit, relevant before Bucket C lands.
- ~~Are the `CF_AI_GATEWAY_*` vars currently set in production, i.e., is v1 live or dormant today?~~ **Answered 2026-07-09 — prod is live.** The seam is dormant only until configured: `buildAiGatewayUrl` returns null unless *both* `CF_AI_GATEWAY_ACCOUNT_ID` and `CF_AI_GATEWAY_SLUG` are set (`.dev.vars` carried only an orphaned `CF_AI_GATEWAY_TOKEN`, so a bare local checkout is dormant). Path 1 was verified live end-to-end once both were set locally (account `9dcfdc35…`, slug `push-gate`): `openai`→`/openai/responses`, `anthropic`→`/anthropic/v1/messages`, and `google`→`/google-ai-studio/v1beta/models/…:streamGenerateContent` all returned 200s confirmed in CF's own gateway logs, with `authentication:true` accepted. The `#1376` fix is validated — google routes at **v1beta**, matching the direct call. **In production, all three `CF_AI_GATEWAY_*` are set as Worker secrets** (`wrangler secret list`), so `buildAiGatewayUrl` returns non-null there and Bucket A prod traffic has routed through `push-gate` since `b1669e12` merged (2026-07-09) — carrying the guardrail tax above until it was disabled.
- Cache hit-rate is low on the evolving main loop (context grows per turn); the win is on repeated sub-calls. Don't budget caching as a blanket latency fix.
