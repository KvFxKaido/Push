# OpenAuth Library Assessment

Date: 2026-06-26
Status: **Reference** — recommendation is **do not adopt OpenAuth now**.
Keep the home-grown GitHub-anchored session (`app/src/worker/worker-session.ts`)
as the identity primitive. Reconsider only at a *specific* future seam — a
genuine multi-provider / multi-tenant identity model — and even then evaluate
"add a provider behind the existing session seam" before "stand up an external
issuer." No implementation committed. Owner: Push.

## Context

The "hand-roll before outsourcing" convention in `CLAUDE.md` ("Capability
sourcing: fold in, don't outsource") was flagged as having a possible exception
here: [OpenAuth](https://github.com/anomalyco/openauth) — a "universal,
standards-based auth provider" by the SST maintainers. This doc records whether
that exception holds. It does not.

**What OpenAuth is.** A *centralized auth server you self-host*: you deploy it as
a standalone OAuth 2.0 / OIDC **issuer**, and your apps, SPAs, mobile clients,
and third-party clients delegate login to it. It deliberately **avoids user
management** — on successful identification it calls back into your code for
user lookup/creation, and keeps only a minimal KV store of refresh tokens and
password hashes. Its value is concentrated in the issuer machinery: the OAuth
authorization-code + PKCE flows, a themeable hosted login UI, built-in
password/email-verification and social providers, and refresh-token rotation —
the stuff you need when **many, partially-untrusted clients** must obtain tokens
from **one** login authority. MIT licensed, TypeScript, runs on Node/Bun/Lambda/
**Cloudflare Workers** with a Cloudflare **KV** adapter — i.e. technically a
clean fit for Push's stack.

**What Push's auth actually is** (verified against code, 2026-06-26):

- **One identity provider, one verification, self-minted session.** GitHub
  verifies a human *once* at the App-OAuth moment (`handleGitHubAppOAuth` in
  `app/src/worker/worker-infra.ts`, `GET /user` → stable numeric id). The Worker
  then mints a short-lived **HS256 HMAC JWT** and verifies *its own signature*
  on every `/api/*` request — `mintSessionToken` / `verifySessionToken` in
  `app/src/worker/worker-session.ts` (~260 lines, pure WebCrypto, zero external
  deps). The gate is `requireSessionForGatedApi` in `worker-middleware.ts`.
- **Single-user by allowlist.** `parseAllowedUserIds(GITHUB_ALLOWED_USER_IDS)`
  — one entry in production; the `Set` shape widens without a code change. The
  decision docs are explicit that the allowlist stays closed "until Push is
  self-hostable without the owner's accounts"
  ([`Single Identity Model — Drop Accountless, Keep the Provider Seam.md`](<Single Identity Model — Drop Accountless, Keep the Provider Seam.md>)).
- **All clients are first-party.** Web, the Capacitor APK, and the CLI/daemon
  are Push's own surfaces. The daemon/relay use a *separate* primitive (the
  Universal Session Bearer), and the CLI authenticates to model providers with
  user-supplied API keys in `~/.push/config.json`. There is **no third-party
  client** that needs Push to issue it tokens.
- **GitHub OAuth is already built.** App JWT generation, the OAuth-code
  exchange, and installation-token refresh all live in `worker-infra.ts`. Push
  does not need an OAuth *flow* abstraction; it needs identity *verification*,
  which it has.

## What OpenAuth would actually buy Push

Mapped honestly against the four things an issuer library provides:

| Capability | Push status today | What OpenAuth adds |
|---|---|---|
| **OAuth-code + PKCE issuance to clients** | Not needed — clients are first-party; the session is minted server-side and rides a `HttpOnly` cookie / `X-Push-Session` header | The full issuer/PKCE dance — value only if untrusted/third-party clients appear |
| **Session mint/verify** | Owned, ~260 lines, pure WebCrypto HS256, no deps (`worker-session.ts`) | Replaces owned cheap code with a vendored issuer + its own Worker/DO + KV. Net **more** infra |
| **Multiple identity providers** (email+password, Google, etc.) | One provider (GitHub), by design; provider seam is **deferred YAGNI** until a 2nd exists | **Real value** — built-in password hashing, email verification, social providers, themeable UI. This is the only genuine win, and it's speculative today |
| **Refresh-token rotation / revocation** | Session TTL (24h) is the only expiry; no revocation list yet | OpenAuth manages refresh rotation — but for *its* issued tokens, not for the GitHub App installation tokens Push actually refreshes |

So the one place OpenAuth would earn its keep is a **multi-provider future**:
if Push ever wants email+password or social logins *beyond* GitHub, OpenAuth's
password provider + email-verification + reset flows + hosted UI are real,
non-trivial work to hand-roll. Everything else it offers, Push either already
owns more cheaply or doesn't need.

## Why "not now"

1. **Wrong shape, not wrong stack.** OpenAuth solves "many clients delegate to
   one login authority." Push is one first-party app, one identity provider, one
   allowlisted user. Adopting OpenAuth means standing up a *second* deployable
   (an issuer Worker + KV for refresh tokens + a hosted UI) and **still** wiring
   the GitHub provider and the subject-resolution callback — to replace a
   pure-crypto function that already works. That's more moving parts and a new
   vendor dependency at the **identity-verification layer**, for negative
   immediate value.

2. **It contradicts Push's own sourcing test.** `CLAUDE.md`: fold in
   *runtime-contract capabilities* (git, shell, fs, CI, AI, GitHub-as-backend);
   outsource only *external-product integrations* (Notion, Linear, Slack). The
   session that gates `/api/*` **is** the runtime contract — it's the boundary
   the whole collapsed stack sits behind, keyed to the same identity that scopes
   settings, provider keys, and memory. That is squarely the "fold in" side. The
   user's instinct that this might be the exception is reasonable to check, but
   identity here is core, not an integration — and it's already folded in.

3. **Beta maturity is a real adoption risk.** OpenAuth is **pre-1.0** (the npm/
   mirror line is `0.3.x`), [announced as beta](https://sst.dev/blog/openauth-beta/)
   in Dec 2024 with an explicit "details may change" posture, and the project has
   **fragmented across forks** — the canonical home moved from
   [`sst/openauth`](https://github.com/openauthjs/openauth) to
   [`anomalyco/openauth`](https://github.com/anomalyco/openauth), with
   independent forks like [`taxilian/openauthjs`](https://github.com/taxilian/openauthjs)
   "to add additional features." Putting the front-door auth gate on a beta
   library with an unsettled maintenance story is the opposite of what an auth
   dependency should be.

4. **The provider seam is the right future home — and it's deliberately
   deferred.** The [`Single Identity Model`](<Single Identity Model — Drop Accountless, Keep the Provider Seam.md>)
   decision already commits to "require a *session*, not GitHub specifically,"
   gating on a session **probe** rather than a hardcoded GitHub check, precisely
   so a future provider plugs in without re-introducing branching. That doc's
   own Open Question #2 says: defer the pluggable-provider *interface* until a
   second provider exists (YAGNI). OpenAuth is a candidate **implementation** of
   that future seam — not a reason to build the seam now.

## Recommendation

**Hold.** Keep `worker-session.ts` + the GitHub-anchored allowlist as the
identity system of record. Do **not** add OpenAuth as a dependency today.

Reconsider OpenAuth **only** when *both* of these are concretely true — not
speculatively:

- **A second identity provider is actually needed** — email+password and/or
  social login beyond GitHub — such that hand-rolling password hashing, email
  verification, reset flows, and the login UI becomes the real cost. (This is
  the trigger that flips the table above from "negative value" to "saves real
  work.")
- **Push is going genuinely multi-user / self-hostable** — the allowlist opens
  and identity stops being "the owner's one GitHub account."

When (and only when) that trigger arrives, the evaluation order is:

1. **First** ask whether a single new provider can ride the existing
   session-probe seam (one provider module → mint the same HS256 session). If
   one extra provider is all that's needed, that is cheaper than an external
   issuer and keeps the verification layer owned.
2. **Only if** Push needs to be a real OAuth issuer for *untrusted or
   third-party clients* (the case OpenAuth is actually built for) does standing
   up OpenAuth as the issuer become the right call — scoped to the **web/Worker
   surface**, never the CLI, with refresh tokens in the existing Cloudflare KV.
3. Pin the maturity bar at decision time: require a 1.0 (or a clearly canonical,
   actively-maintained fork) before the front-door gate depends on it.

## Non-goals

- **No re-platforming the session onto OpenAuth.** The home-grown HS256 session
  is the right default for a single-app, single-provider, single-user
  deployment; swapping it for a vendored issuer trades cheap owned code for
  infra and a beta dependency to solve a problem Push doesn't have yet.
- **No CLI usage.** The CLI/daemon identity primitive is the Universal Session
  Bearer; OpenAuth is a web/Worker issuer and must not pull into the terminal
  surface.
- **Not building the multi-provider interface now.** Only preserving the seam
  (probe-based gating, no new hardcoded GitHub checks) so OpenAuth — or a
  lighter single-provider addition — stays a cheap option later.
- **Not opening the allowlist.** This doc does not widen access; it only records
  why an external auth issuer is premature.
