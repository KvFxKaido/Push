# Sign in with ChatGPT — Provider OAuth Assessment

Date: 2026-07-17 (original) · revised 2026-10-01
Status: **Draft** — the July reconsider-trigger ("OpenAI ships a sanctioned
path with an official flow and terms") **has fired**. Revised recommendation:
**fold in, CLI-first** (plus, possibly, the Electron shell), as a first-party
OAuth provider-auth path against the sanctioned Sign in with ChatGPT (SIWC)
token-sharing flow. Web/cloud stays **no** pending a read of the separate
"On your website" flow. Not yet owner-committed; no implementation.
Owner: Push.

## 2026-10-01 revision — the sanctioned path exists

OpenAI now documents **SIWC token sharing for open-source, locally run apps**
(`developers.openai.com/siwc/token-sharing-open-source`, pages: Overview,
Registration and sign-in, Codex app-server; not yet read: Refreshing tokens /
profiles-and-sessions, Errors and recovery, On your website, UI/UX
guidelines). This removes two of the three July blockers for the CLI. The
July assessment is kept below as provenance; where the two disagree, this
section wins.

### What the official flow is (from the docs, 2026-10-01)

- **Same endpoint Push already calls.** The plan-backed OAuth access token is
  a plain `Authorization: Bearer` on `https://api.openai.com/v1/responses`
  (authorization `resource=https://api.openai.com/v1`). Not
  `chatgpt.com/backend-api/codex`, not a proxy. Push's OpenAI definition
  already targets that URL (`lib/provider-definition.ts`, `baseUrl`) and the
  CLI already sends `Bearer` (`cli/openai-responses-stream.ts`). On the wire,
  a plan token is an API key that expires.
- **Self-serve, per-account dynamic client registration.** First sign-in uses
  the shared entry point `client_id=dynamic_agent_client` plus
  `agent_name_hint` (the app's real name, consistent across installs) and a
  required per-host `ext_agent_host_id`. The user names/authorizes the agent;
  the callback returns an **issued `client_id` (`oaiapp_...`)** bound to that
  ChatGPT account + workspace, reused for later sign-ins. **No client secret,
  no partner API key** — nothing Push-the-project has to apply for or hide in a
  public repo. `dynamic_agent_client` is never saved or used for token exchange.
- **Authorization code + PKCE (S256), loopback only.** Authorize at
  `https://auth.openai.com/api/accounts/authorize`; exchange at
  `https://auth.openai.com/api/accounts/oauth/token` (form-encoded, issued
  `client_id`, `code_verifier`, same `redirect_uri` and `resource`, no secret).
  Redirect must be `http://127.0.0.1:<port>/auth/callback` — **`127.0.0.1`,
  never `localhost`**; exact path; only the port may vary between sign-ins, and
  must match within one attempt. Fresh `state` + OIDC `nonce` + PKCE verifier
  per attempt.
- **Scopes.** Identity `openid profile email`; plan usage
  `offline_access resource.invoke chatgpt.tokens.use.direct`. A valid ID token
  alone does **not** authorize plan usage — gate on the *granted* scopes
  containing `chatgpt.tokens.use.direct`. `error=access_denied` is ambiguous:
  the docs route it to a "ChatGPT plan use isn't enabled" recovery path, but
  it is also the standard OAuth result when the user simply declines consent.
- **ID-token validation is required.** Signature against OpenAI's JWKS; `iss`,
  `aud` == the **issued** client id, `exp`, `nonce`. Identity is the validated
  `sub` (email and `sub` are not workspace identifiers — key records by issued
  client id + `sub`). On re-auth, reject a callback whose `client_id` differs
  from the pending request's, and confirm the new `sub` matches the selected
  account before replacing credentials.
- **Returning sign-in.** Reuse the issued `client_id`; send the retained (maybe
  expired) `id_token` as `id_token_hint` (skips the account selector) and/or a
  saved `login_hint`. Omit `agent_name_hint` on re-auth.
- **Storage.** One record per (issued client id, verified identity): identity,
  `id_token`, `access_token`, `refresh_token`, `expires_in`, granted scopes,
  `saved_at`, `ext_agent_host_id`. Atomic writes, `0600`, never logged.
  **Refresh tokens rotate**: access token, expiry, scopes and refresh token are
  replaced together after a successful refresh.
- **Branding.** The entry point is labeled **Continue with ChatGPT** per
  OpenAI's UI/UX guidelines (unread; matters for the web/Electron UI, mostly
  text in the TUI). Multiple saved accounts/workspaces are expected.
- **Model list is a catalog, not an entitlement check** (app-server page): only
  a completed inference turn proves the plan can use a model.
- **Codex app-server is optional.** It is one integration recipe (spawn
  `codex app-server` with the token in `ACCESS_TOKEN`, restart it on refresh,
  `thread/resume`). Push should **not** take it: it is the T3-Code "wrap an
  external agent" fork (`docs/research/T3 Code — Lessons for Push.md`), and
  Push's governance (Auditor gate, capability gating, side-effect budget)
  requires owning the loop. Push talks to `/v1/responses` directly with its own
  pump.

### July blockers, re-scored

| July blocker | Now |
|---|---|
| **Durability** — reverse-engineered, borrowed Codex client id, unpublished endpoint | **Cleared.** Documented flow, per-user issued client id, public `api.openai.com` endpoint |
| **ToS** — token pooling | **Cleared for the CLI** (one user, their own account, their own machine — the case the program is written for). **Not cleared for web** (see below) |
| **Web can't do loopback / no refresh machinery** | Loopback: still true for a Worker; **not** true for the Electron shell, which is a locally run app. Refresh machinery: still net-new, now the main cost |

### Revised shape (CLI-first)

1. **Login command** (`push auth chatgpt` / a `config init` branch): bind a free
   `127.0.0.1` port, open the system browser, PKCE + state + nonce, handle the
   callback, exchange, validate the ID token, check granted scopes, save.
   `agent_name_hint="Push"`.
2. **Host id.** One stable `ext_agent_host_id` (`urn:uuid:...`) per machine,
   minted once and persisted under `~/.push/`; shared by the CLI and pushd on
   that host.
3. **Credential store.** New, separate from `~/.push/config.json` (whose
   per-provider `{ url, apiKey, model }` can't hold a rotating multi-field
   credential): e.g. `~/.push/chatgpt/<issued_client_id>.json`, `0600`, atomic
   write (temp + rename), plus an active-account pointer. Multi-account from day
   one — the docs assume it.
4. **Token-aware key resolution.** See the seam correction below — the
   interactive CLI captures the key once, which a 1-hour token breaks.
5. **Locked refresh** (cross-process). See below — the main correctness risk.
6. **Error mapping.** A token response whose granted scopes lack
   `chatgpt.tokens.use.direct` (a confirmed restriction — likely an
   admin-disabled workspace) → an actionable "plan use isn't enabled" message
   at sign-in, not a 401 on the first turn. A bare `error=access_denied` callback
   does **not** prove that — the user may just have declined — so it gets a
   neutral "sign-in was cancelled or not authorized; try again" message that
   also links the plan-enablement recovery, rather than asserting a plan
   restriction. A per-model entitlement
   failure → "your plan doesn't include this model," not the generic 4xx bucket
   (CLAUDE.md HTTP-status checklist; `lib/quota-errors.ts` for plan-quota
   exhaustion). `invalid_grant` on exchange → discard code, restart auth.
   Structured logs on each branch (sign-in ok / denied / scope-missing /
   refresh ok / refresh failed / identity mismatch), to `console.error` per the
   CLI stream rule.
7. **Model picker** treats the catalog as advisory for this provider.

### The main risk: concurrent refresh of a rotating refresh token

**What is established vs. assumed.** The Registration and sign-in page says
the refresh token **rotates** ("replace the access token, expiry, granted
scopes, and rotating refresh token together after a successful refresh"). It
does **not** say whether the previous refresh token is invalidated immediately
(single-use), tolerated for a grace window, or triggers reuse detection and
family revocation — that contract lives on the unread Refreshing tokens page
(open question 1). The analysis below therefore designs for the **worst case**
(strict single-use with reuse detection) and should be re-scored once that
page is read; if rotation turns out to be lenient, the lock is still correct,
just less critical.

Under the worst case: Push routinely runs several processes against one
account — pushd, a TUI, a headless `push run`. If two see an expired access
token and both refresh, one presents an already-rotated refresh token: at best
a failed request, at worst the token family is revoked and the user is
silently signed out. This is the CLAUDE.md "**an `await` that breaks a
reservation**" class: expiry-check → `await fetch(refresh)` → write, with
another process landing in between.

Required shape (holds under any rotation semantics, since concurrent refreshes
at minimum waste a rotation and race the atomic file write): a **cross-process** lock around read → (re-check expiry after
acquiring) → refresh → atomic write. Re-reading after acquiring is what makes
the loser pick up the winner's fresh token instead of refreshing again.

Correction to the 2026-10-01 chat analysis: `lib/git/repo-lock.ts` is **not**
the precedent — it is an **in-process** keyed lane (`Map<string, Lane>`), which
does nothing across pushd/TUI/`push run`. The cross-process precedent is
`cli/task-ledger-store.ts` `acquireTaskLedgerLock` — **as fixed in #1643**,
not as it stood when this revision was first written.

The original helper (`fs.open(lockFile, 'wx')` + stale-lock reclaim) read the
owner PID, decided the owner was dead, then unlinked the lock **by path**. Two
contenders could both judge the same stale lock dead; one unlinked it and
acquired a fresh lock, then the other unlinked *that* fresh lock — both inside
the critical section. A multiprocess test reproduced it on the ledger itself
(2–3 writers with the same `expectedRevision` succeeding per round). A first
fix put the reclaim behind a guard file, but reaping a crashed reclaimer's
guard was the same check-then-unlink, just moved; the guard's 30s staleness
also exceeded the 10s acquire timeout. Rename-to-tombstone variants have the
same shape: any "check, then remove by path" step can be raced.

What landed instead is an **epoch sequence** in `<ledger>.lockdir/`: the holder
owns the highest `<n>.owner` with no `<n>.released` marker and a live PID;
acquiring — including taking over from a dead owner — creates `<n+1>.owner`
via `link()` of a fully written temp file (atomic, no-replace). No step
unlinks a name another live process could hold. Release writes the marker
and garbage-collects lower epochs; a dead owner is taken over on the next
15ms poll (`task_ledger_lock_owner_dead`).

Requirements for the credential lock:

- **Reuse the epoch lock; don't reinvent it.** Its helpers are module-private
  to `cli/task-ledger-store.ts` today. When the credential store lands, extract
  them into a shared helper parameterized by lock directory (promote to `lib/`
  only if a second surface needs it, per the CLAUDE.md rule) rather than
  writing a credential-only copy. Never add a stale-reclaim path that unlinks
  by name.
- **Re-check inside the lock.** After acquiring, re-read the credential record
  and refresh only if it is still expired, so the loser picks up the winner's
  token instead of spending another rotation.
- **A multiprocess contention test.** Mirror
  `cli/tests/task-ledger.test.mjs` (real processes via
  `cli/tests/task-ledger-lock-contender.mjs`, a shared start signal, a planted
  dead owner): assert exactly one refresh call is made and every process ends
  with the same token. Mutation-check it — making epoch creation overwrite, or
  restoring unlink-then-retake, must turn it red.
- **Liveness, not safety, on PID reuse.** A dead owner's recycled PID makes it
  look alive until the acquire timeout; that delays a refresh but never admits
  two refreshers.

### Seam correction: the interactive CLI captures the key once

The daemon path already resolves lazily per invocation
(`cli/daemon-provider-stream.ts` calls `resolveApiKey(config)` inside the
stream). The **interactive CLI does not**: `resolveApiKey` reads env only
(`cli/provider.ts`), and `cli/cli.ts` stores the result on `ctx.apiKey` at
startup / provider switch, threading the string into `runLeadKernelTurn` and
`createProviderStream(config, apiKey, ...)`. A session longer than the access
token's lifetime (`expires_in: 3600` in the docs' example) would keep sending a
dead token. The fix is a resolver at the stream boundary (key-or-getter,
awaited per request) rather than a captured string — which also matches the
"live getters, not spawn-time snapshots" contract `cli/provider.ts` already
documents for `url`/`defaultModel`.

### Other sharp edges

- **Port.** The docs' example port is 1455 — the same one the Codex CLI uses.
  Bind any free port; whether the *initial* registration must use a specific
  port is ambiguous in the docs ("from initial registration onward ... later
  sign-ins may use another available port") — verify.
- **No device-code flow** is documented. SSH to a remote host needs a manual
  port-forward. The WSL-hosted daemon
  ([`Windows Desktop — WSL-Hosted Daemon.md`](<Windows Desktop — WSL-Hosted Daemon.md>))
  puts the browser on Windows and the listener in WSL2 — localhost forwarding
  usually covers `127.0.0.1`, but test it per WSL networking mode, don't assume.
- **JWT verification** against a remote JWKS is new to Push (the worker's
  HS256 session tokens are self-minted and symmetric — no reuse). Use a
  maintained library; don't hand-roll.
- **Attribution.** The app-server path sends `clientInfo.name` as the request
  originator / User-Agent and says it should match `agent_name_hint`. Whether a
  **direct** `/v1/responses` caller is expected to send an equivalent
  originator header is unknown — check the unread pages.

### Web / cloud and Electron

- **Electron desktop** runs locally and can host a loopback listener, so it fits
  the OSS flow the same way the CLI does, despite rendering the web UI. Worth
  doing after the CLI, sharing the flow through `lib/`.
- **Hosted web (Worker): still no** — on policy *and* on implementation scope.
  Policy: the OSS program is scoped to "locally run apps." Implementation: a
  client-supplied plan token would **not** reach OpenAI through today's routing
  in either documented Worker configuration. `handleOpenAIChat` authenticates
  via `standardAuth('OPENAI_API_KEY')`, which prefers a configured Worker
  secret over the request's `Authorization` header
  (`app/src/worker/worker-middleware.ts` `standardAuth`), and the AI Gateway
  BYOK path omits `Authorization` entirely so the gateway can inject its stored
  key (`app/src/worker/worker-providers.ts`, `...(byok ? {} : { Authorization:
  authHeader })`). Only a deployment with neither a secret nor BYOK would pass
  the client header through. A web path therefore needs a distinct auth mode or
  route (or a precedence change scoped to SIWC tokens) on top of the policy
  answer — it is not a policy-only gap. The docs
  reference a **separate "On your website" flow** (the OSS flow "remains a
  public client without a secret," implying a confidential-client website
  variant). That page decides whether a hosted surface using *each user's own*
  plan token for *that user* is sanctioned or is the pooling case. Until it is
  read, the July non-goal stands.

### Open questions (read these pages next, in order)

1. **Refreshing tokens** (profiles-and-sessions) — rotation on every refresh?
   reuse detection / family revocation? refresh-token lifetime?
2. **On your website** — reopens or confirms the web answer.
3. **Errors and recovery** — exact error shapes for plan-not-enabled,
   model-not-entitled, rate limit vs. quota.
4. **A client vs. an agent host** — confirms one `ext_agent_host_id` per
   machine (vs. per pushd instance / per install).
5. Is "open-source" a condition on the app, or just the flow's name? (Push is
   public either way.)
6. Rate limits / model availability relative to Codex itself.

Reconsider-trigger #2 from July ("demonstrated CLI demand") is an owner call;
this revision only establishes that the cost is now mostly the auth layer
(login, store, locked refresh, error mapping) — the network half is built.

---

## Original assessment (2026-07-17) — provenance

Kept as written. Its recommendation ("do not fold in") is superseded by the
revision above for the CLI; its web non-goal still stands pending the open
questions. Its description of `openai-oauth` (an unofficial proxy against
`chatgpt.com/backend-api/codex`) is **not** the sanctioned flow.

### Context

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

### What "Sign in with ChatGPT" would buy Push

| Capability | Push status today | What this adds |
|---|---|---|
| **Use a ChatGPT plan as an OpenAI backend, no API key** | Not built as a first-party path | The headline win — cheaper access for users who have Plus/Pro but not API credits |
| **Reach the proxy from the CLI** | **Already works** — `PUSH_OPENAI_URL=http://127.0.0.1:10531/v1/responses` + any dummy `apiKey`, run `openai-oauth` alongside | Nothing. The base-URL seam already covers it; folding in native OAuth would only remove the separate proxy process |
| **Reach it from the web/cloud surface** | Not possible — base URL fixed, auth is static-key-only, and the loopback OAuth flow can't complete on a Worker | Net-new: OAuth flow + token-refresh machinery + a redirect Push doesn't own — squarely in deferred provider-seam / Settings-Unification territory |
| **Native (proxy-less) OAuth in Push itself** | Not built | Removes the external proxy dependency on CLI — but adds refresh-token handling to an API-key-only provider layer, for a capability the proxy already delivers |

The only genuine, non-duplicative win is the headline one — and on the CLI it is
**already available with zero Push code**. Everything Push would actually *build*
is either redundant (CLI) or lands on the wrong surface (web).

### Feasibility, per surface

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

### Durability risk (both surfaces)

This is an **unofficial, reverse-engineered** use of Codex's OAuth tokens
against an endpoint OpenAI never published for third-party clients. OpenAI can
revoke the client, change the flow, or fingerprint non-Codex traffic at any
time — the README says as much. The `CLAUDE.md` sourcing test warns against
owning maintenance on someone else's release schedule for *sanctioned* external
APIs; this is that risk without the sanction. Building a first-party Push surface
on it means every upstream change is a Push outage. Acceptable for a user's own
opt-in local proxy; not acceptable as a supported product surface.

### Recommendation

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

### Seams a first-class path would touch (for reference, if the trigger ever flips)

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

### Non-goals

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
