# GitHub Token Storage — localStorage vs httpOnly Cookies

Date: 2026-05-02
Status: **Current** — deferred; defenses listed below are the operating posture
Owner: Push
Related: `docs/decisions/Cloudflare Sandbox Provider Design.md` (sibling owner-token model),
`app/src/hooks/useGitHubAppAuth.ts`, `app/src/hooks/useGitHubAuth.ts`,
`app/src/worker/worker-infra.ts` (`handleGitHubAppOAuth`, `handleGitHubAppLogout`),
`app/src/worker/sandbox-token-store.ts`,
2026-05-01 vibe-coded-app security audit (PR #464, PR #465)

## Context

The 2026-05-01 audit (item #5) flagged that Push stores the GitHub App installation token and provider API keys in `window.localStorage` rather than in `httpOnly; Secure; SameSite` cookies. localStorage is readable by any script running on the origin, so a successful XSS turns into immediate token exfiltration. httpOnly cookies aren't readable from JavaScript, so the same XSS can still abuse the user's session through the page but can't carry the token off-origin.

The cheap audit wins shipped (#464, #465):

- per-IP rate limiting on `/api/github/app-oauth`, `/api/github/app-token`, `/api/github/app-logout`
- sanitized OAuth/logout error responses (no upstream message leakage)
- `/api/github/app-logout` calls `DELETE /installation/token` so logout actually invalidates the token server-side
- `npm audit fix` cleared the production-dep advisories in `app/`

What remains from #5 is the architectural question: do we move the token to httpOnly cookies?

## Decision

**Defer the migration.** Keep tokens in localStorage for now. Treat the question as live (revisit on the triggers below), not closed.

The rest of this doc captures *why* deferring is the right call given Push's current shape, *what defenses we rely on instead*, and *what would flip the answer*. The goal is to prevent the next reader from re-litigating the same ground from zero — and to make sure the day we *do* migrate, the trigger is explicit rather than accidental.

## Why defer

The honest read is that httpOnly cookies are the textbook win, but the textbook scenario isn't quite Push's. Three things make the gap narrower than it looks:

1. **Push is single-user-per-browser, not a hosted multi-tenant SaaS.** localStorage is theft-via-XSS, not theft-via-other-user. There is no "stolen token reaches another user's session" path in Push's model — every browser owns one user, and the Worker treats requests as anonymous-by-token (no server-side login session anyway).

2. **Migrating means *adding* server-side session state.** httpOnly cookies don't replace localStorage in place — they require:
   - a Worker-side session store (probably KV-backed) keyed by an opaque session id
   - a CSRF strategy (SameSite=Lax + custom-header double-submit, or full CSRF tokens)
   - a session-establishment endpoint that wraps `/api/github/app-oauth`'s token return
   - a session-destruction endpoint (extending `/api/github/app-logout`)
   - changes to every client call site that currently reads the token from localStorage and sends `Authorization: Bearer <token>` to GitHub directly — those calls have to either route through the Worker (paying a hop) or get the token via a session-bound endpoint
   - a token-refresh path that still works under cookie auth (the existing 5-min-before-expiry refresh logic in `useGitHubAppAuth.ts`)

   That's a structural change to an architecture that's currently "Worker is mostly stateless; client is the auth boundary." The estimate is ~1 sprint of work, and the rest of the threat model gets better in much smaller increments first.

3. **GitHub App tokens auto-expire in 1 hour.** The blast radius of a stolen token isn't permanent — it's bounded by the natural TTL plus whatever's left of the refresh window. With the new `/api/github/app-logout` endpoint (#465), even an active session can be cut server-side. Compare to a user-OAuth token that never expires until manually revoked: that's the case where localStorage is genuinely scary.

In short: the migration is real defense, but it's defense against XSS — and we'd rather close the XSS hole at the source than build a session layer on top of an XSS-prone front end.

## What we rely on instead

The current operating posture, ordered roughly by leverage:

- **CSP defenses against script injection.** Every served HTML response in the Worker carries a CSP that disallows inline event handlers, restricts `script-src` to first-party origins, and emits `upgrade-insecure-requests` (`worker-middleware.ts:150–155`). XSS that can't run script can't read localStorage either.
- **Input handling discipline.** React escapes by default; we don't use `dangerouslySetInnerHTML` on user-generated content. Markdown rendering passes through controlled renderers, not direct HTML insertion.
- **Origin allowlist on every API route.** `validateOrigin` (`worker-middleware.ts:343–363`) rejects cross-origin calls before any handler runs, so a token leaked client-side still can't be used to drive *Push's* APIs from an attacker's page in a victim's browser.
- **Short-lived tokens.** GitHub App installation tokens carry a 1-hour TTL; provider API keys are user-scoped and the user can rotate them at any time. `/api/github/app-logout` shortens that further to "until the next logout."
- **Server-side revocation on logout.** `useGitHubAppAuth.disconnect()` posts the token to `/api/github/app-logout` (with `keepalive: true`) before clearing local state. Local clear happens regardless of fetch outcome.
- **HSTS on every Worker response.** `Strict-Transport-Security: max-age=31536000; includeSubDomains` (`worker-middleware.ts:155`) takes plain-HTTP token interception off the table after first contact.

These are not a substitute for httpOnly cookies. They are the bar we hold while the migration sits in the queue.

## What would flip the answer

Migrate when *any* of these become true. Don't wait for the audit to flag it twice:

1. **Push grows multi-user-per-browser semantics.** Shared workstations, kiosk mode, or any flow where a browser hosts more than one Push identity changes the threat model materially.
2. **A real XSS lands.** A confirmed XSS report, even if patched at the source, is the trigger: it means the CSP layer leaked once, and we should not assume it won't again.
3. **GitHub App installation tokens grow a longer TTL.** If GitHub or our app config moves the token TTL substantially (say, >12h), the auto-expiry defense weakens enough that XSS-window exfiltration becomes durable.
4. **We add password auth or any other long-lived credential** that lands client-side. Provider API keys today are user-paste-then-stored; if the SaaS surface ever issues durable Push-owned credentials, those need cookie-class storage out of the gate.
5. **The audit cycle revisits #5 and the threat-modeling team disagrees with the deferral.** This doc is meant to make that conversation cheaper, not to foreclose it.

## Migration sketch (for when we do flip)

Keeping this thin so it doesn't masquerade as a design doc; expand into a real one when the trigger fires.

- New Worker-managed session: `POST /api/session` after the OAuth code exchange returns a `session_id` cookie (`HttpOnly; Secure; SameSite=Lax; Path=/`). The session record in KV holds the installation token + expiry + user metadata.
- Replace direct GitHub calls from the client with Worker-proxied calls that read the token from the cookie-keyed session. The Worker becomes the only place the raw token ever lives in a user-attributable way.
- CSRF: rely on SameSite=Lax for top-level navigations + require a `X-Push-Session` custom header on state-changing requests (cookies-only requests fail with 403). Custom headers force a CORS preflight, which the origin allowlist already blocks for non-allowed origins.
- Logout extends `/api/github/app-logout` to also delete the session record before issuing GitHub revocation.
- Refresh runs server-side in the Worker; client never holds the token at all.
- Migration path: ship cookie-based auth alongside localStorage-based, gate per-installation, drain over a release cycle, then remove the localStorage path.

This is a sketch, not a commitment. The trigger conditions above decide when this gets pulled out.

## Out of scope for this decision

- **Sandbox owner tokens** (`SANDBOX_TOKENS` KV, 24h TTL, keyed by `sandboxId` not user). These travel client-side too, but their threat model is different — they only authorize calls to a specific ephemeral container, not the user's GitHub identity. Per-user keying for sandbox tokens is independently tracked (see comment header in `app/src/worker/sandbox-token-store.ts`).
- **Provider API keys.** Same storage layer (`safeStorageSet` → localStorage), same threat profile, but the user owns the key and can rotate at any time at the provider. The cookie migration would likely cover these too; calling that out here so the future reader knows it isn't a separate decision.
- **CLI session storage.** The CLI keeps tokens in `~/.push/` config files, not localStorage. Different threat model, separate decision when it comes up.
