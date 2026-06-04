# Auth Rework — GitHub as the Single Identity Anchor

Date: 2026-06-04
Status: **Draft** (step 1 committed + implemented behind observe mode — see `ROADMAP.md` → *Auth Rework*). Flip to `Current` when the allowlist gate is enforcing and the deployment token is retired (migration step 3). Step-1 landing: `app/src/worker/worker-session.ts` (session primitive), session mint in `handleGitHubAppOAuth` (`worker-infra.ts`), `requireSessionForGatedApi` gate (`worker-middleware.ts` + `worker.ts`), client send-path (`app/src/lib/session-auth.ts` + `deployment-auth.ts` fetch chokepoint).
Owner: Push
Related:
`app/src/lib/deployment-auth.ts` + `app/src/worker/worker-middleware.ts` (today's `X-Push-Deployment-Token` edge gate; also enforced in `github-webhook.ts`, `relay-routes.ts`),
`app/src/worker/worker-infra.ts` (`generateGitHubAppJWT` / `exchangeForInstallationToken` / `resolveRepoInstallationId` — the App installation-token path, already used by `pr-review-job-do.ts` + `worker-pr-review.ts`),
`app/src/lib/sandbox-auth-gate.ts` + `app/src/lib/github-auth.ts` (`GitHubTokenKind`, `isDurableUserToken`, the `needs_ack` user-token gate from PR #766) consumed at `app/src/hooks/useSandbox.ts:333`,
[[push-prod-deployment-gate]], [[push-git-credential-proxy-deferred]], [[push-infra-direction]],
`docs/decisions/Universal Session Bearer.md` (the device/relay bearer — the one legitimately-custom auth layer, out of scope here),
`CLAUDE.md` (delivery rules, Protect Main).

## TL;DR

Push's login feels unanchored because it is doing **three different jobs with three
mismatched mechanisms**. The fix is not to pick a vendor — it is to notice that
**GitHub already answers all three questions**, and to stop using a shared secret
to fake an answer GitHub gives for free.

> **Anchor identity *and* repo-authorization on GitHub; gate app access with a
> GitHub-identity allowlist; retire the shared deployment token.** For a
> single-user tool the allowlist has one entry. That is the *responsible* form of
> "put GitHub in front" — the naive form (open GitHub login) is an open door to
> metered compute, which is the real risk the gut flags as irresponsible.

The identity anchor (GitHub) and the repo-auth anchor (App installation tokens)
hold **regardless of audience**; only the *edge-gate shape* would change if Push
ever went multi-user. So those two can be committed now; only the gate is
single-user-specific today.

## The three jobs login is secretly doing

Naming them is the whole insight — the mess is that each is answered by a
different, mismatched mechanism:

| # | Job | The question | Today's mechanism | Problem |
|---|-----|--------------|-------------------|---------|
| 1 | **Edge gate** | "Can this request touch Push at all?" | `X-Push-Deployment-Token` — a shared bearer in `localStorage`, checked in `worker-middleware.ts` | A copyable secret with **no identity attached**. Whoever has the string is "you." Rotate-on-leak toil. |
| 2 | **Identity** | "Who are you?" | Implicitly GitHub OAuth, or a PAT, or nothing (scratch/chat) | Never made explicit, so job #1 had to invent a stand-in (the token). |
| 3 | **Repo authorization** | "What may Push do on GitHub for you?" | GitHub App installation token **or** a user PAT | The PAT branch is a long-lived secret that gets injected into sandboxes — the wart behind the `needs_ack` gate ([[push-git-credential-proxy-deferred]]). |

The deployment token (job 1) is a crude proxy for one question — *is this me?* —
that job 2 (GitHub identity) answers properly and for free.

## What is actually being protected

Not data. Repos sit behind each user's *own* GitHub auth, so an unauthorized
caller cannot read private code through Push. The real exposure is **cost and
abuse**: an open door lets anyone spin up sandboxes and hammer the Workers AI
binding on the owner's Cloudflare bill. That is precisely why "put GitHub in
front" feels irresponsible in its naive form — open GitHub login = open compute —
and precisely why an **identity allowlist** dissolves the fear: the door only
opens for a known GitHub identity.

## The decision (per layer)

### Identity → **GitHub OAuth.** Not Cloudflare, not custom.
Push *is* "code on GitHub from your phone." Every user already has a GitHub
account; it is free, it is the identity that matters, and it doubles as the
credential job #3 needs anyway. Anchoring identity on Cloudflare is a category
error (CF Access is a *gate*, not an identity you build product features on).
Custom identity (passwords, email verification, MFA, a breach surface) is pure
undifferentiated lifting when the entire user base is definitionally GitHub users.

### Edge gate → **GitHub identity + an allowlist of authorized GitHub user IDs.**
Resolve the GitHub user from the session, then check membership in a configured
allowlist (one entry today; an env/secret list). This is **strictly better** than
the deployment token on every axis:
- **No leakable bearer** — a session bound to a GitHub identity cannot be
  impersonated by copying a `localStorage` string, and it is revocable.
- **Identity-attached** — you get "who hit this," not "someone with the token."
- **No new secret** — it reuses the GitHub trust you already depend on for repo
  access; nothing extra to rotate.

The deployment token (`deployment-auth.ts` + the `worker-middleware.ts` check)
**retires** once this lands.

### Repo authorization → **GitHub App installation tokens as the default; PAT as escape hatch.**
Installation tokens (`worker-infra.ts`: `generateGitHubAppJWT` →
`exchangeForInstallationToken`) are short-lived and repo-scoped, so injecting one
into a sandbox clone is far less dangerous than a long-lived PAT. Making them the
blessed path **dissolves the `needs_ack` friction** (`sandbox-auth-gate.ts`) for
normal use — the ack survives only for the explicit, opt-in PAT escape hatch,
where a durable user token genuinely is being injected.

### Unifying principle
**GitHub is identity *and* resource-authorization (because the resource *is*
GitHub). Cloudflare is infra and, optionally, the edge gate. "Custom" is only the
device/relay bearer that already exists for remote sessions** (`Universal Session
Bearer.md`). Three mechanisms collapse to one anchor.

## Scope: gate the expensive surface, not everything equally

The cost/abuse risk lives on a few endpoints, and that is where the allowlist must
hold without exception: **AI chat, sandbox create, job start** (and any other
metered/side-effecting call). Static asset serving and read-only metadata can be
looser. Practically, for a single user, gate everything behind the session +
allowlist; the principle matters when the surface grows. (Mirrors the security
seam discipline in `CLAUDE.md` — trace one allowed and one denied path per gated
resource, and grep every path that touches the same metered resource.)

## Per-surface note (the owner is bi-surface + has a daemon)

GitHub identity is the **through-line** across web/PWA, the Android APK, and the
daemon — because it is just an identity check, it rides every surface the same
way. The gate *mechanism*, however, can stay per-surface:
- **Web / PWA / APK** → app-level allowlist check in the Worker (owner-controlled,
  universal, no edge dependency).
- **Daemon / relay** → the existing device-bearer (`Universal Session Bearer.md`),
  which is loopback/relay-scoped and is not a web login.

**Do not** force the APK webview or the daemon through Cloudflare Access — that is
the failure mode of treating CF Access as the universal answer.

## Cloudflare Access — the alternative, and why it is the runner-up here

CF Access (GitHub IdP + allowlist policy, enforced before the Worker runs) is the
*edge-level* expression of the exact same idea, with zero app code. It is the
right call for a small team that lives in the browser. It is the **runner-up for
this owner** only because it gets clunky in the APK webview and the daemon/relay
path, so those would need special-casing anyway — at which point the app-level
allowlist (which already covers them uniformly) wins. Keep CF Access in mind if
the surface ever becomes browser-only.

## Audience anchor (decided: single-user) and what generalizes

This is, and is being built as, a **single-user tool.** The load-bearing
consequence: only the *edge gate* is single-user-specific (an allowlist of one).
The other two anchors are audience-independent —
- a multi-user future widens the allowlist or dissolves it into a real
  accounts/session system, but **identity stays GitHub OAuth**;
- repo-auth **stays App installation tokens** at any scale.

So commit to GitHub identity + installation-token repo-auth now; treat the
allowlist as the single-user expression of the gate, swappable later without
touching the other two.

## Migration sequencing (rough; not a commitment until a ROADMAP entry exists)

1. **Add the identity gate in parallel.** Resolve GitHub identity + allowlist check
   on the expensive endpoints, running *alongside* the deployment token
   (dual-gate) so nothing breaks mid-cutover. Emit symmetric structured logs on
   allow/deny (per `CLAUDE.md`).
2. **Make installation tokens the default repo-auth.** Demote PAT to an explicit
   escape hatch; the `needs_ack` ack narrows to the PAT path only.
3. **Retire the deployment token** (`deployment-auth.ts` + the middleware check +
   the `#push_token` hash entry point) once the allowlist gate is proven.

## Rejected / considered

- **Cloudflare as the *identity* anchor** — category error; CF Access is a gate,
  not a product identity. Also clunky on APK/daemon.
- **Custom accounts** (passwords/email/MFA) — undifferentiated heavy lifting and a
  new breach surface, for users who are all already GitHub users.
- **Keep the deployment token long-term** — a shared, leakable, identity-less
  bearer with rotate-on-leak toil; the thing being replaced.
- **Naive "GitHub in front" (open login)** — the cost/abuse open door; this is the
  *irresponsible* form the allowlist fixes.
- **A second factor layered on GitHub** — unnecessary. For a GitHub-coding tool,
  GitHub is already the keys to the kingdom: if the owner's GitHub is compromised,
  the repos are gone regardless of what Push does. Gating on GitHub identity is
  correctly scoped, not under-protecting.

## Open questions

1. ~~**Session shape.**~~ **DECIDED (2026-06-04): Worker-minted signed session.**
   GitHub verifies a human identity exactly once, at the App-OAuth moment
   (`GET /user` → stable numeric id, now load-bearing); the Worker then mints a
   short-lived HMAC `push_session` JWT (`PUSH_SESSION_SECRET`, ~24h, claims
   `sub`/`login`/`installation_id`/`iat`/`exp`/`iss`/`aud`) and verifies *its own
   signature* per request — no per-request GitHub dependency. Carried by a
   `HttpOnly; Secure; SameSite=None` cookie (primary; `None` because the APK runs
   on `https://localhost` and calls the Worker cross-origin) plus an
   `X-Push-Session` header fallback. Rejected re-checking a stored GitHub token
   per request: it either keeps a durable user token alive or turns every gated
   call into a GitHub dependency, and the normal repo-auth path is moving to
   installation tokens (repo authorization, *not* a durable human identity).
2. **Allowlist storage.** Env/secret list vs a tiny KV entry. Single entry today,
   but decide the shape so widening it later is not a redeploy.
3. **PAT escape-hatch UX.** With installation tokens as default, when is the PAT
   path even surfaced — power users with repos the App is not installed on?
   Confirm the `needs_ack` copy points at *that* case specifically.
4. **Scratch/no-account mode.** Today "without an account" reaches Chat/Workspace
   (scratch). Does scratch survive the gate (no GitHub identity → no metered repo
   work, but does it still touch the AI binding)? Decide whether scratch is gated,
   rate-limited, or dropped.

## Next step

Needs a `ROADMAP.md` entry to become work. Cheapest proving slice: step 1 above —
the parallel GitHub-identity allowlist check on the expensive endpoints, behind
the existing deployment token, with the token retired only once the allowlist gate
has carried real traffic.
