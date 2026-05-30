# Universal Session Bearer

Date: 2026-05-30
Status: **Current** (Session Continuity & Stability) — shipped across three PRs:
(1) creation factory, (2+4) bootstrap grace + adopt-from-response, (3+5) drop
the bypass + explicit opt-out + retire the patch to a tripwire.
Owner: Push

Every daemon session should carry an attach token **from birth**, and every
attach should require a matching token. "Open attach" (no bearer) becomes a
deliberate opt-in, not an accident of which code path created the session.

## Problem

The attach token is the bearer a client presents to attach to a daemon
session (locally over the loopback WS, or remotely via the relay/phone). Today
it is provisioned inconsistently:

- `makeAttachToken()` lives only in `cli/pushd.ts` and is called **only** by
  `start_session` (pushd.ts:~1219).
- The TUI/engine create path (`cli/cli.ts:~1304`, `cli/tui.ts:~1306`) builds a
  fresh session **with no token**.
- `validateAttachToken(entry, provided)` (pushd.ts:~851) returns `true` when
  `!entry.attachToken` — i.e. a tokenless session is **open**: any local
  attach succeeds with no bearer.

So "does this session require a bearer?" depends on how it was born. That
inconsistency produced the remote-pairing failure of 2026-05-30
(`MISSING_ATTACH_TOKEN`): a TUI session created via `session-store` (tokenless)
was adopted by the daemon and then could not be paired to a phone, because
`mint_remote_pair_bundle` had no bearer to hand it. PR #714 patched that with
`resolveOrMintTargetAttachToken` (mint-on-demand at pair time). This decision
retires that patch by removing the tokenless class entirely.

## Decision

**Universal bearer (Option A).** Every session has a token; every attach
requires it. "Open" survives only as an explicit opt-in (`openAttach: true` on
the session, or `PUSHD_OPEN_ATTACH=1`).

**Legacy cutover: bootstrap grace.** A pre-existing tokenless session, on its
first `attach_session` where the client also presents no token, is *claimed*:
the daemon mints + persists a token, accepts that one attach, and returns the
token so the client adopts it. Every subsequent attach requires it. The grace
is logged (`legacy_claim`) and trends to zero as sessions are claimed. New
sessions never hit it (they are minted at birth).

Rationale: the token's real job is remote auth; locally the 0600 unix socket
is already the boundary, so a single unauthenticated local claim-attach per
legacy session is an acceptable migration affordance. Chosen over a hard
cutover (backfill-all at startup, no grace) to avoid forcing the operator to
restart in-flight TUIs/CLIs holding stale tokenless in-memory state.

## Current state (audit, 2026-05-30)

**Enforcement sites (11)** — all funnel through `validateAttachToken`, so
removing its `!entry.attachToken` bypass flips them together:
`send_user_message`, `attach_session`, `get_session_messages`,
`configure_role_routing`, `update_session`, `submit_task_graph`,
`cancel_delegation`, `fetch_delegation_events`, `delegate_explorer`,
`delegate_coder`, `delegate_reviewer`, `delegate_deep_reviewer`.

**Session creation points (3)** — a `createSessionState()` factory must cover
all three so no session is born tokenless:

| Point | File | Mints today? |
|---|---|---|
| `handleStartSession` | `cli/pushd.ts:~1219` | ✅ yes |
| TUI `createFreshSessionState` | `cli/tui.ts:~1306` | ❌ no |
| CLI `initSession` | `cli/cli.ts:~1304` | ❌ no |

**Clients & token source:**

| Client | Attach path | Token source | Risk |
|---|---|---|---|
| Relay web | `attach_session` over WS | pair-bundle `targetAttachToken` | none (always present) |
| Local-PC web | WS bearer header | IndexedDB device/attach token | none (always present) |
| TUI | `attach_session` / RPCs | in-memory `state.attachToken` / `daemonAttachToken` | **can be `undefined`** |
| CLI | `push attach` | disk via `readLocalAttachToken()` | **can be `undefined`** |

**The lockout risk (the reason the audit mattered):** a TUI loads a tokenless
session into memory at startup; the daemon backfills a token later; the TUI
reconnects with stale `undefined` and is rejected — locked out of its own
session until restart. This is the wholesale version of the
`mint_remote_pair_bundle` staleness we already handled in PR #714.

## Design

1. **Creation factory.** Promote `makeAttachToken` into `cli/session-store.ts`
   (or a shared util) and add `createSessionState(opts)` that mints the token
   and builds the base state. Route all three creation points through it. New
   sessions are never tokenless, and the creator holds the token in the same
   state object — no staleness for new sessions.

2. **Adopt-from-response.** `attach_session` and `start_session` return the
   token; the TUI and CLI adopt it into in-memory `state.attachToken` /
   `daemonAttachToken`. This is the same mechanism PR #714 added for the pair
   bundle — generalize it. Closes the staleness loop for legacy claims.

3. **Drop the bypass + explicit opt-out.** Remove `!entry.attachToken → true`
   from `validateAttachToken`. Add an explicit `openAttach` escape hatch
   (per-session flag and/or `PUSHD_OPEN_ATTACH=1`) so "open" is a deliberate
   dev choice, logged when used.

4. **Bootstrap grace.** In the `attach_session` handler: if the on-disk session
   has no token **and** the client provided none, mint + persist + accept +
   return the token, and log `legacy_claim`. Any other combination enforces
   normally (token on disk → client must match). Once claimed, the session is
   tokened forever.

5. **Retire the patch.** `resolveOrMintTargetAttachToken` collapses to a plain
   resolve (token always present). Keep a defensive mint **with a structured
   log if it ever fires** — if it does, a creation path slipped past the
   factory. The patch becomes a tripwire.

## Symmetric logs

- `legacy_claim` (info) on a bootstrap-grace claim ↔ a future `legacy_claim`
  count of zero is the signal the migration is complete.
- `open_attach_used` (warn) whenever the explicit opt-out is exercised.
- `attach_token_minted_unexpectedly` (warn) if the retired patch's defensive
  mint ever fires (= a missed creation path).

## Risks

- **Locked-out client** if any attach path fails to supply the token. Mitigated
  by the factory (new sessions) + adopt-from-response + bootstrap grace
  (legacy). The audit table above is the checklist; each path must be
  re-verified against the implementation.
- **Cross-process mint race** on a legacy session loaded concurrently by daemon
  and TUI. Mitigated by mint-if-absent + atomic (tmp+rename) persist; the
  daemon's claim is authoritative via the returned token the client adopts.
- **Test masking** — PR #715 shipped a parse bug because a test mocked the
  wrong envelope shape. Tests here must assert against the *real* on-disk and
  wire shapes, not assumed ones.

## Relation to addressable sessions

This is also the **auth prerequisite** for the session-verb / addressable-session
direction in [`opencode SDK Review.md`](opencode%20SDK%20Review.md) (suggested-
priority #2). opencode-style addressable sessions (`abort`/`revert`/`summarize`/
`children`, or any exposed session API) are only safe once every session has
auth *by construction* — which is exactly the invariant this doc establishes.
The sequence is: **bearer (this doc) → addressable session verbs → optional
session API**, not three unrelated efforts. Pinning the bearer first is what
makes the later layers cheap and safe.

## Out of scope

- Rotating/expiring attach tokens (separate concern from "always present").
- The remote relay shared-secret model (`PUSH_RELAY_TOKEN`) — that is the
  separate "enroll / no copy-paste drift" track (direction ② from the
  2026-05-30 brainstorm).
- Exposing an addressable session API (the layer *above* this — see above).

## Graduation

ROADMAP-tracked under **Session Continuity & Stability** (the first-priority
item, 2026-05-30). Suggested implementation sequence: factory (1) →
adopt-from-response (2) → bootstrap grace (4) → drop bypass + opt-out (3) →
retire patch (5), each with the audit table re-verified and the drift/lockout
tests in the same PR.
