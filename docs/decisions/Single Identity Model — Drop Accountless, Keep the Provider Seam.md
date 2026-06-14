# Single Identity Model — Drop Accountless, Keep the Provider Seam

Date: 2026-06-13
Status: **Draft** — design-in-motion. Flip to Current in the implementation PR.
Owner: Push

## Problem

The Auth Rework (#776–#780, 2026-06-04) made a GitHub-identity **session** the
universal `/api/*` gate and wrapped the whole app in `GitHubSignInGate`
(`main.tsx`). The gate renders children **only** when the session probe
(`/api/auth-probe`) returns `authed` — no exceptions. A session is minted by
the App **auth** flows — *both* the OAuth-`code` path *and* the installation
callback (`installation_id + setup_action`), which the gate's `isCallback`
treats identically, and `handleGitHubAppToken` mints a session on
(`worker-infra.ts`). Both flows also yield the App `authToken`; only the
token-*refresh* path mints no session (no verified user identity to anchor
on). So passing the gate ⟹ you have a session ⟹ you came through a
session-minting auth flow ⟹ you have `authToken`. Identity and token are
coupled — but the coupling is "went through *an* auth flow," **not** "went
through OAuth specifically" (the cleanup must not assume the latter, or it
mis-handles the already-installed App path — Codex P2 on the doc PR).

But `App.tsx` and `OnboardingScreen` still carry the **pre-gate accountless
model**: an "or try without an account" entry (`OnboardingScreen.tsx:276`) and
screen-logic short-circuits (`App.tsx:689–708`) that render scratch / chat /
local-pc / relay workspaces *"even when the user is signed out of GitHub"*
(its own comment), with `authToken`-optional branches underneath.

That model is **dead** — the gate makes "signed out" unreachable — but it's
still live-looking scaffolding: extra branching, misleading copy, and a stated
property ("the daemon flow doesn't need GitHub creds") that the gate silently
contradicts. An inventory sweep (2026-06-13) found this is the *only*
coherent dead-auth scaffolding left; everything else the rework already cleaned
(deployment-token code gone, only provenance comments remain).

Two forces shape the fix:
- **Focus.** Removing the accountless model deletes a class of conditional
  branches and one of two auth mental-models — the legibility / single-security-
  boundary win.
- **The self-hostable future.** The owner wants Push eventually "self-hostable
  without my various accounts tied to it." Hardcoding **GitHub** sign-in
  everywhere deepens exactly the coupling that future needs to sever — and the
  daemon's "doesn't need GitHub" property is the natural seam for an
  identity-agnostic Push. So the cleanup must not nail that door shut.

## Decision

> Remove the dead **accountless** path, and in doing so commit to **"require a
> session/identity," not "require GitHub."** GitHub is today's identity
> *provider* behind the existing session-probe abstraction — swappable, not
> hardcoded through the UI. Scratch/chat/daemon become honestly *authed*
> surfaces; the provider seam keeps the self-hostable future open.

Three parts:

1. **Delete the accountless scaffolding.** The "or try without an account"
   framing in `OnboardingScreen` and the `App.tsx` signed-out short-circuits +
   `authToken`-optional branches that exist specifically to serve a
   *signed-out* user. These are unreachable behind the gate today.

2. **Keep scratch / chat / local-pc / relay — reframed as authed.** Those
   workspaces are live and valuable (scratch is the intended
   "dump-an-idea → instant-git" surface; daemon is the local-reach surface).
   Removing the *accountless premise* does not remove the *workspaces*; they
   stay, reachable through the normal post-sign-in flow.

3. **Treat identity as a provider seam.** Gate on "is there a valid session"
   via the probe, not on a hardcoded GitHub check sprinkled through `App.tsx`.
   Push already has a **non-GitHub identity primitive** — the daemon attach
   bearer (Universal Session Bearer). The self-hostable future swaps the
   identity provider (GitHub → self-hosted / bearer) *without* re-introducing
   the accountless branching this removes.

## Why requiring a session is a win (not just tidiness)

- **First-class daemon/scratch sessions.** The post-rework backend keys
  everything on identity: the server settings doc, encrypted per-user provider
  keys, memory scoping, the allowlist, provider observability. An accountless
  session is an *orphan* that can use none of it. Requiring identity makes every
  session — cloud or daemon — a first-class citizen of those features.
- **One security boundary.** "Is this endpoint reachable accountless via the
  daemon path?" stops being a question. (We've been bitten by dual-path gaps —
  inline-lane parity holes, "gate one path, grep the others.") One gate is more
  legible — the honest-surfaces win.
- **Codebase focus.** Removes the `authToken`-optional / signed-out branching,
  not just the onboarding copy.

## The daemon decision (made explicit)

Pairing a local-pc / relay daemon **requires a session** (GitHub today), because
the pairing UI lives inside `<App/>`, inside the gate. This is already the
de-facto reality — the gate blocks accountless daemon use — so we are ratifying
it, not changing behavior. Accepted tradeoff: a purely-local daemon no longer
runs "without cloud identity." The provider-seam framing is what keeps this from
being permanent GitHub lock-in: when a self-hosted identity provider (or the
bearer itself) can mint a session, the daemon flow rides that.

## Non-goals

- **Not removing scratch / chat / daemon workspaces.** Only the accountless
  *premise*. The surfaces stay.
- **Not touching demo-*provider* mode** (no LLM key) — a separate axis from
  GitHub identity; left as the legitimate "configure a key" state.
- **Not opening the allowlist.** `GITHUB_ALLOWED_USER_IDS` stays as the
  "not ready to share" backstop until Push is self-hostable without the owner's
  accounts. This doc does not widen access.
- **Not building the self-hostable identity provider now.** Only *preserving the
  seam* (probe-based gating, no new hardcoded GitHub checks) so it stays cheap
  later.

## Implementation plan (one PR)

1. `OnboardingScreen`: drop the "or try without an account" divider; reframe the
   Chat / Workspace / local-pc tiles as normal authed entry points (they render
   post-sign-in regardless).
2. `App.tsx`: remove the screen-logic short-circuits + comments premised on
   "signed out of GitHub" (689–708). Where a short-circuit also encodes
   legitimate *ordering* for a signed-in user (e.g. scratch renders before the
   repo picker), keep the ordering, drop the accountless rationale.
3. **Audit every `authToken`-optional branch, not just `App.tsx`.** `authToken`
   spans at least `App.tsx`, `lib/github-auth.ts`,
   `lib/sandbox-git-release-handlers.ts`, and `types/index.ts` (grok's scope
   note). This is a per-reference judgment, not a blanket delete: a branch that
   exists because a *signed-out* user could reach a workspace is dead and goes;
   a branch that handles a *legitimately-absent token at a real moment* (e.g. an
   expired/refreshing token for a signed-in user) stays. Classify each before
   touching it.
4. Audit for hardcoded GitHub checks that should be probe/session checks; leave
   the session-provider abstraction intact (no new GitHub-specific gating).
5. Tests: pin the post-cleanup invariants in `App.test.tsx` (+ the
   `OnboardingScreen` suite) — a signed-in user reaches scratch / chat / repo /
   local-pc / relay workspaces; **no** path renders a workspace without a
   session (assert the accountless routes are unreachable); the gate stays the
   single entry point. Name the files in the PR so coverage is explicit.

## Open questions

1. **Offline / loopback local-pc — broken *now*, not "later" (grok WARNING).**
   The gate's probe (`/api/auth-probe`) is a network call, so a genuinely
   offline loopback daemon session is **blocked the moment the accountless path
   is removed** — this is immediate, not deferred, and the doc should not
   soft-pedal it. **v1 stance: pure-offline local-pc is not supported.** That is
   an explicit, accepted cost — the bearer-as-identity-provider path (a session
   minted from the daemon's attach bearer, no GitHub round-trip) is the future
   that restores it, and it's the concrete first use of the provider seam. If
   offline-loopback is a near-term requirement, this PR needs a bearer-only
   bypass *now*; otherwise we ship knowing it's gone until the seam lands.
2. **Provider-seam interface.** Defer the actual pluggable-provider interface
   until a second provider exists (YAGNI) — but the cleanup must not add checks
   that would have to be un-hardcoded then. The bar for this PR: probe-based
   gating only.
