# Sign in with ChatGPT — Provider OAuth Assessment

Date: 2026-07-17
Status: **Reference** — recommendation is **do not fold in**. Keep the
API-key-only provider auth model (`lib/provider-definition.ts` →
`apiKeyEnvVars`; `~/.push/config.json`). The capability is already reachable on
the **CLI** through the existing base-URL seam (`PUSH_OPENAI_URL` → a local
proxy) with zero first-party code, and it does **not** belong on the governed
web/cloud surface for ToS and durability reasons. No implementation committed.
Owner: Push.

## Context

[`EvanZhouDev/openai-OAuth`](https://github.com/EvanZhouDev/openai-OAuth)
(Apache-2.0, unofficial, not affiliated with OpenAI) lets a **ChatGPT
subscription stand in for OpenAI API credits**. It runs the same OAuth flow the
official Codex CLI uses to obtain a bearer token, then exposes an
OpenAI-compatible local proxy that forwards to the ChatGPT-account-backed
endpoints at `chatgpt.com/backend-api/codex`. In effect: "log in with ChatGPT,
get a local `/v1/*` endpoint your Plus/Pro plan pays for instead of metered API
billing."

The question this doc answers: should Push adopt "Sign in with ChatGPT" as a
first-class **provider auth path** — the first case where a model-provider
credential is obtained via an OAuth flow rather than a pasted API key? It should
not, on the governed surface; on the CLI it needs nothing built.

**What the tool actually is** (from its README + the Codex flow it clones):

- **Flow.** The Codex CLI OAuth dance: authorization-code with **PKCE (S256)**
  against `auth.openai.com` (`/oauth/token` for exchange), default client id
  `app_EMoamEEZ73f0CkXaXp7hrann`, redirect on the **loopback** callback
  `http://localhost:1455/auth/callback` (an OpenAI-approved local redirect). The
  README does not spell out PKCE, but the loopback + public-client shape it
  mirrors requires it. The resulting tokens are *functionally the Codex CLI's
  tokens*.
- **Storage.** Credentials land in `~/.codex/auth.json` (mirroring Codex CLI) or,
  in the browser SDK, in IndexedDB encrypted at rest with WebCrypto. Tokens
  "should be treated like passwords."
- **Proxy.** `openai-oauth` CLI serves an OpenAI-compatible endpoint on
  `127.0.0.1:10531` (`/v1/chat/completions`, `/v1/responses`, `/v1/models`, image
  gens), streaming + tool calls + reasoning traces, upstream
  `https://chatgpt.com/backend-api/codex`.
- **SDKs.** `@openai-oauth/{local,react,ai-sdk,openai-client,core}` — a browser
  "Sign in with ChatGPT" component (Chrome/Firefox only), a Vercel AI SDK
  adapter, an official-OpenAI-client options adapter, and a custom-transport
  core. Push uses none of these client shims — it has its own wire-shape pumps —
  so only the **proxy** and the **OAuth flow itself** are relevant here.
- **Stated constraints.** "Each person must use their own ChatGPT account. Do
  **not** pool, share, or redistribute access tokens." Comply with OpenAI's Terms
  of Use; don't bypass rate limits or safeguards. Codex-supported models only,
  tier-dependent. No warranty; OpenAI may disable it anytime.

**What Push's provider auth actually is** (verified against code, 2026-07-17):

- **API keys, everywhere, only.** The canonical registry
  `lib/provider-definition.ts` models auth as a single field — `apiKeyEnvVars`
  (OpenAI at lines 637–674). There is no token, expiry, refresh, or OAuth notion
  in `ProviderDefinition`. The CLI stores a per-provider `{ url, apiKey, model }`
  in `~/.push/config.json` (`cli/config-store.ts`, `0o600`), and resolves the key
  per request into `Authorization: Bearer` (`cli/openai-responses-stream.ts:50`,
  `cli/provider.ts` `resolveApiKey`).
- **The CLI base URL is already fully user-overridable.** `PUSH_OPENAI_URL` →
  `cli.defaultUrl`, plumbed live so the daemon picks up rotations. Requests can
  point at any endpoint, including a local proxy, today.
- **The web base URL is fixed.** `app/src/worker/worker-providers.ts`
  (`handleOpenAIChat` → `handleResponsesProxy`) uses the definition's hardcoded
  `baseUrl`; the only auth seam is `standardAuth` (`worker-middleware.ts:696`) —
  "Worker env secret, else the client `Authorization` header." BYOK via
  Cloudflare AI Gateway injects **`Authorization` only**. Server-held keys are
  static, AES-256-GCM, identity-keyed (`app/src/worker/user-secrets.ts`) — **no
  expiry/refresh anywhere**.
- **Provider auth ≠ identity auth.** GitHub App OAuth (`worker-infra.ts`) and the
  self-minted HS256 session (`worker-session.ts`) answer *who you are*. They are
  entirely disjoint from *which LLM key signs the upstream call*. Nothing today
  obtains a **provider** credential via OAuth.

## What "Sign in with ChatGPT" would buy Push

| Capability | Push status today | What this adds |
|---|---|---|
| **Use a ChatGPT plan as an OpenAI backend, no API key** | Not built as a first-party path | The headline win — cheaper access for users who have Plus/Pro but not API credits |
| **Reach the proxy from the CLI** | **Already works** — `PUSH_OPENAI_URL=http://127.0.0.1:10531/v1/responses` + any dummy `apiKey`, run `openai-oauth` alongside | Nothing. The base-URL seam already covers it; folding in native OAuth would only remove the separate proxy process |
| **Reach it from the web/cloud surface** | Not possible — base URL fixed, auth is static-key-only, and the loopback OAuth flow can't complete on a Worker | Net-new: OAuth flow + token-refresh machinery + a redirect Push doesn't own — squarely in deferred provider-seam / Settings-Unification territory |
| **Native (proxy-less) OAuth in Push itself** | Not built | Removes the external proxy dependency on CLI — but adds refresh-token handling to an API-key-only provider layer, for a capability the proxy already delivers |

The only genuine, non-duplicative win is the headline one — and on the CLI it is
**already available with zero Push code**. Everything Push would actually *build*
is either redundant (CLI) or lands on the wrong surface (web).

## Feasibility, per surface

**CLI — reachable now, nothing to fold in.** A user who wants this runs the
`openai-oauth` proxy locally and points `PUSH_OPENAI_URL` at it. This is exactly
the base-URL override the config wizard already prompts for, and it keeps the
tool's "each person uses their own ChatGPT account" constraint where it belongs:
on the user's own machine, under sole-user trust, with their own account. Push
folding in a *native* (proxy-less) OAuth mode is technically possible —
`cli/provider.ts`'s static `resolveApiKey` would grow into a token resolver with
refresh — but it duplicates what the proxy already does and adds the first
expiring-credential path to a layer that has only ever held static keys. Not
worth it absent real pull.

**Web / cloud — should not ship.** Three independent blockers, any one
sufficient:

1. **ToS / account-safety on a multi-user surface.** The tool's own rule is "do
   not pool, share, or redistribute access tokens; each person uses their own
   account." A hosted Push web surface brokering ChatGPT-OAuth backends for many
   users is the pooling case that both the tool and OpenAI's Terms forbid, and it
   puts *users'* ChatGPT accounts at ban risk for non-Codex automated use. This
   is the governed-surface hole the `CLAUDE.md` MCP note describes, in a sharper
   form: not just ungoverned reach, but reach that can get the account banned.
2. **The flow doesn't fit a Worker.** The OAuth redirect is the **loopback**
   `localhost:1455` callback, designed for a process on the user's machine. A
   cloud Worker has no loopback, and the client id / approved redirects belong to
   OpenAI/Codex, not Push — Push can't register a hosted callback.
3. **No refresh machinery exists.** `user-secrets.ts` stores static keys;
   `standardAuth` is "secret or client header." An expiring, refreshing token is
   net-new plumbing landing in the deliberately-deferred provider seam
   ([`Single Identity Model`](<Single Identity Model — Drop Accountless, Keep the Provider Seam.md>)
   Open Question #2) and the deferred Settings-Unification runbook.

## Durability risk (both surfaces)

This is an **unofficial, reverse-engineered** use of Codex's OAuth tokens
against an endpoint OpenAI never published for third-party clients. OpenAI can
revoke the client, change the flow, or fingerprint non-Codex traffic at any
time — the README says as much. The `CLAUDE.md` sourcing test warns against
owning maintenance on someone else's release schedule for *sanctioned* external
APIs; this is that risk without the sanction. Building a first-party Push surface
on it means every upstream change is a Push outage. Acceptable for a user's own
opt-in local proxy; not acceptable as a supported product surface.

## Recommendation

**Do not fold in.** Keep provider auth API-key-only.

- **CLI:** if there is real user demand, the lightest first-party step is
  **documentation** — a short recipe showing `openai-oauth` + `PUSH_OPENAI_URL`
  — not code. The capability already exists through the base-URL seam; a doc
  makes it discoverable without Push owning any OAuth flow, token store, or the
  ToS exposure. A native proxy-less OAuth mode stays a **later, CLI-only** option
  and only if the proxy proves too much friction.
- **Web / cloud:** **no.** ToS (token pooling on a multi-user surface), technical
  (loopback flow can't complete on a Worker; refresh machinery is net-new), and
  durability (unofficial, revocable) each independently rule it out.

Reconsider **only** if *all* of these become concretely true:

- OpenAI ships a **sanctioned** "use your subscription as an API backend"
  path with an official flow and terms (removing the ToS + durability blockers),
  and
- there is demonstrated CLI demand that the documented-proxy recipe doesn't
  satisfy (justifying native, proxy-less OAuth), and
- if it is ever considered for the web surface, the account-per-user /
  no-pooling constraint is squared with the multi-user governance model — which
  today it cannot be.

## Seams a first-class path would touch (for reference, if the trigger ever flips)

1. `lib/provider-definition.ts` — `ProviderDefinition` assumes `apiKeyEnvVars`;
   an OAuth backend needs a new provider id or an auth-mode field. None exists.
2. **CLI**: `cli/openai-responses-stream.ts:50` (the `Bearer` header) and
   `cli/provider.ts` `resolveApiKey` + live getters — static-key-only today; a
   refreshing token needs a resolver that isn't "read env." Base-URL swap already
   supported.
3. **Web**: `worker-providers.ts` (`handleOpenAIChat`/`handleResponsesProxy`) +
   `worker-middleware.ts` `standardAuth` — "secret or client `Authorization`" is
   the entire model; no expiry/refresh. `user-secrets.ts` holds static keys.
4. Governance docs to align:
   [`OpenAuth Library Assessment.md`](<OpenAuth Library Assessment.md>),
   [`Single Identity Model — Drop Accountless, Keep the Provider Seam.md`](<Single Identity Model — Drop Accountless, Keep the Provider Seam.md>),
   and the deferred Settings-Unification runbook.

## Non-goals

- **No web/cloud ChatGPT-OAuth backend.** The governed multi-user surface must
  not broker ChatGPT-account tokens — ToS pooling risk and users' account safety.
- **No native OAuth/refresh in the provider layer now.** Don't add the first
  expiring-credential path to an API-key-only layer for a capability the local
  proxy already delivers.
- **Not adopting the `@openai-oauth/*` SDKs.** Push has its own wire-shape pumps;
  the client shims (ai-sdk, openai-client, react) are irrelevant.
- **This doc does not endorse the tool's use** — it only records why Push should
  not build a surface on it, while noting the CLI base-URL seam already lets a
  user opt in on their own machine and their own account.
