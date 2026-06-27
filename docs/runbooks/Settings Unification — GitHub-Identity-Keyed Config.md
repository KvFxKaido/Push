# Settings Unification — GitHub-Identity-Keyed Config

Date: 2026-06-07
Status: **MVP + secrets tier shipped** — the non-secret preferences tier
(substrate + GET/PUT `/api/settings` + shared client store +
autonomous-reviewer fold + non-secret hooks) landed 2026-06-07; the secrets
tier (encrypted per-identity provider keys + DO dispatch injection) landed
2026-06-11 after the session gate was verified enforced. Scratchpad/todo
content is **reassigned out of scope** to chat/session continuity (see
phasing + open questions below).
Owner: Push

Make the web app's info/settings the same on every device by moving them from
per-browser `localStorage` into a server-authoritative document keyed by the
signed-in GitHub identity. The end goal that motivates this is reviewer
visibility/control from any device — but that's a *consumer* of unified state,
so the substrate comes first.

## Why now / why it's tractable

- **Single-user.** Production is gated to one GitHub account, so there's exactly
  one settings owner. No multi-tenant partitioning, no cross-user races — a
  last-write-wins document is sufficient.
- **The pattern already exists.** The autonomous PR-reviewer config already
  round-trips through the Worker: `usePrReviewConfig` ↔ `POST /api/pr-reviews/config`
  ↔ KV (`config:pr-review-*`, see `app/src/worker/pr-review-config.ts`). This is
  a working server-side settings doc behind the universal session gate. The work
  is to *generalize* it, not invent it.
- **The APK comes free.** `app/capacitor.config.ts` sets
  `server.url = https://push.ishawnd.workers.dev`, so the APK's WebView loads the
  live prod origin — it's the prod web app in a wrapper, same origin, same
  session. Unifying the web unifies the APK with zero native special-casing:
  relative `/api/*` resolves against the prod origin. A *bundled* APK (dropping
  `server.url`) is the only future case that would need `resolveApiUrl` /
  `VITE_API_BASE_URL`.

## Scope

- **In:** the prod web app (and therefore the APK).
- **Deferred:** the CLI. Its config (`~/.push/config.json`) is set-once-per-machine
  and its UI prefs are terminal-local — low divergence pain today. Pulling it in
  needs a CLI↔Worker authenticated channel (the same gap we hand-rolled as
  `PUSH_EMBED_URL` for embeddings); build that once, later, and the CLI joins
  additively *because the doc is identity-keyed* (below).
- **Out:** context-memory unification (the IndexedDB record store) — an
  order-of-magnitude larger project; do not let it ride along.

## The model

- **One document per GitHub identity** in KV: `settings:<githubUserId>` → JSON.
- **Server-authoritative, last-write-wins** with an `updatedAt`. Clients keep a
  local cache for first-paint and offline, write-through on change, and reconcile
  to the server value on load. No CRDT — unnecessary at single-user scale.
- **Behind the universal `/api/*` session gate.** This is a plain
  `GET/PUT /api/settings` endpoint following the `pr-review-config` precedent —
  **not** the session-bearer DO verbs (those authorize live daemon sessions, a
  different concern).
- **Identity-keyed from day one**, even though only the web reads it now. This is
  the one non-negotiable: keying to "this browser" (or, like `pr-review-config`
  does today, to a *global* key) makes any future reader a migration. Keying to
  the GitHub user id makes the CLI — or anything — purely additive. This mirrors
  the project's own new-feature checklist ("scope keys CLI-first; durable
  identifiers; put the scope resolver in `lib/` from day one").

## Migration map (what moves, what doesn't)

Recon of `app/src` persistence, 2026-06-07.

### Migrate now — non-secret tier (no auth dependency)

| Category | Current localStorage keys |
|---|---|
| Appearance | `push:chat-mode-appearance:v1`, `push:repo-appearance:v1`, daemon appearance |
| Toggles/prefs | `protect_main_default`, `push:workspace:show-tool-activity`, `push:chat:last-used-models` |
| In-app advisory reviewer | `push:review:selected-provider`, `REVIEW_MODEL_KEYS.*` |
| User info | `push_user_profile` |

> **Reassigned, NOT migrated here:** `push-scratchpad*` and `push-todo` were
> originally listed as "Content" in this table. They are **out of
> settings-unification scope** — they're content/context, not preferences. See
> the Open questions + decision §11: the UI scratchpad-notes + todo ride
> chat/session continuity; the "main as scratchpad" uncommitted code rides #5.

### Secrets tier — SHIPPED 2026-06-11 (gate verified enforced)

~11 provider keys via the `use*Config` hooks: `{ollama,openrouter,zen,nvidia,kilocode,openai,anthropic,google}_api_key`, `tavily_api_key`, and Vertex (`vertex_api_key`, `vertex_service_account`, region/model).

The gating precondition is met: prod returns 401 `SESSION_AUTH_REQUIRED` on
sessionless `/api/*` requests (verified live 2026-06-11), so server-held keys
sit behind an enforced identity gate. What forced the timing was the inline
delegation default (#887): engine-routed turns dispatch providers **server-side
in DOs**, where browser-held keys never arrive — "Add it in Settings" was a lie
for every engine turn, and `wrangler secret put` requires the dev box. The
secrets fold makes Settings the key UX that works for both loops, from the
phone.

**Implementation (this tier's shape differs from the prefs doc on purpose):**

- **Separate store, not `settings:` values.** `usersecrets:<githubUserId>` in
  the same `SNAPSHOT_INDEX` KV (`app/src/worker/user-secrets.ts`). The prefs
  doc round-trips wholesale to the client; keys must not — the secrets store is
  **write-only from the client's perspective** (list returns `last4` +
  `updatedAt` only, no read endpoint returns key material).
- **Encrypted at rest:** AES-256-GCM, key HKDF-derived from
  `PUSH_SESSION_SECRET` (salt/info pinned in the module). KV-read compromise
  alone doesn't yield plaintext. Trade: rotating `PUSH_SESSION_SECRET`
  invalidates stored keys (decrypt-fail → treated as missing, logged
  `user_secret_decrypt_failed`, user re-enters). Fail-closed: no session
  secret → writes 503, reads null — never plaintext storage.
- **Routes:** `GET/PUT/DELETE /api/settings/provider-keys` in
  `worker-settings.ts` (same origin/rate-limit/identity preamble as
  `/api/settings`).
- **Resolution order unchanged:** `standardAuth` = Worker env secret → request
  Authorization header. User-stored keys enter as the *injected* Authorization
  header on DO-synthetic provider Requests, so precedence is env secret →
  user key → none, on every path.
- **Identity plumbing (the out-of-band rule holds):** jobs and runs persist
  *identity*, never credentials. `/api/jobs/start` stamps a server-resolved
  `ownerUserId` (client value stripped — a spoof would dispatch with another
  identity's keys); the RunHost register/checkpoint routes stamp `ownerUser`
  the same way `hostOrigin` is stamped. The stream adapter
  (`coder-job-stream-adapter.ts`) resolves the key from KV per dispatch.
- **Capability probe is per-identity:** `/api/providers/engine-capabilities`
  ORs env-secret presence with the caller's stored keys, so the client's
  engine-routing eligibility and the DO's dispatch credentials can't disagree.
- **Client mirror:** `useApiKeyConfig.setKey/clearKey` mirror to the server
  store best-effort (`provider-key-sync.ts`); failure logs
  `provider_key_sync_failed` and never blocks the local save. Tavily stays
  client-only (its Worker proxy is deliberately client-key-only); Vertex's
  service-account blob is NOT folded yet (different shape — follow-up).
- **PR-review DO unchanged:** webhook path stays env-credentials-only
  (`resolveOwnerUserId` exists if it ever needs the owner's stored keys).

### Keep device-local — do not sync

- **Auth artifacts:** `github_access_token`, `github_oauth_state`,
  `github_app_token` / `_expiry`, `github_app_installation_id`, `github_app_user`,
  `github_app_commit_identity`. Each device authenticates itself.
- **Caches:** `push:models-dev:*` (×5), the symbol-persistence-ledger (IndexedDB),
  composer drafts. Derived/ephemeral.
- **Legitimately per-device:** a theme/appearance *override* is a real category —
  the doc holds the default; a device may pin its own. Design the schema to allow
  a per-device override layer rather than assuming one global value.

### Separate concerns — not this project

- **Session/workspace state** (`workspace_session`, `active_repo`,
  `diff_conversations`, `diff_active_chat`): the session-continuity track.
- **Context-memory IndexedDB store:** memory unification, its own effort.

## MVP / phasing

1. ✅ Generalize `pr-review-config` into `GET/PUT /api/settings` — one KV doc
   keyed by GitHub user id, LWW with `updatedAt`. Folded the existing
   `config:pr-review-*` into `reviewer.autonomous.*` (fixing the global-key →
   identity-key flaw); legacy flat keys are read as a fallback.
2. ✅ Migrate the non-secret tier: appearance, protect-main, show-tool-activity,
   last-used models, profile, and the in-app advisory reviewer picks now read
   through the shared `settings-store` (sync first-paint cache, write-through,
   boot reconcile) with a per-hook legacy-localStorage fallback. Scratchpad/todo
   content is **out of scope** (reassigned to session continuity — open question #4).
3. ✅ Reviewer config lives in the shared doc → controlling the reviewer from any
   device is unblocked.
4. ✅ Secrets tier (2026-06-11) — gate verified enforced in prod; encrypted
   per-identity store + DO key injection shipped (see the secrets-tier section
   above). Remaining inside this tier: Vertex service-account blob, and a
   Settings-UI presence indicator fed by `GET /api/settings/provider-keys`.

## Open questions

_Resolved for the MVP (2026-06-07):_

1. **Do the two reviewer notions converge?** **No — kept distinct, co-located.**
   The autonomous PR reviewer and the in-app advisory reviewer live in the same
   document as separate blocks (`reviewer.autonomous.*` vs `reviewer.advisory.*`);
   the features are not merged.
2. **Secrets posture:** **Resolved 2026-06-11 — sync, encrypted, write-only.**
   The enforce-flip landed and the inline-delegation default made device-local
   keys structurally insufficient (engine turns run server-side). Keys mirror
   to an encrypted identity-keyed store; localStorage remains the foreground
   loop's source. The "never sync" alternative was rejected because it forfeits
   background jobs and durable-run adoption for every BYOK provider.
3. **Per-device override layer:** **Deferred.** Shipped global-only; the
   "global default + device pin" layer (theme) is a follow-up. The doc is a flat
   canonical-key→value bag, so a `*.deviceOverrides` block can be added additively.
4. **Conflict policy:** **Last-write-wins, per key.** A `PUT` shallow-merges the
   changed keys server-side under one monotonic `updatedAt` — strictly better than
   whole-document LWW (no two-hooks-write clobber) without a CRDT. Accepted for
   the rare two-devices-at-once edit at single-user scale. LWW is fine for small,
   rarely-co-edited *preferences*; it is the wrong fit for actively-edited content
   (see #5 below).

_Reassigned (2026-06-08):_

5. **Scratchpad/todo — out of settings-unification scope.** Originally listed as
   "Content" to migrate; reassigned after concluding they're content/context, not
   preferences, and pay off only beside the conversation that produced them.
   - **UI scratchpad-notes + todo** are repo-scoped working artifacts. Syncing
     them on their own is low ROI (todo is regenerated per run; notes without the
     chat are margin notes with no book) and would pay the LWW data-loss cost on
     actively-edited content for little gain. They ride **chat/session
     continuity** — implemented there, or not at all. No interim per-device-slots
     scheme: that builds the hard part ahead of the thing that gives it meaning.
   - **"Main as scratchpad" uncommitted code** is a git/sandbox substrate
     (decision #5 / branch-on-commit), never a KV-doc concern.
   The settings doc stays **preferences-only**.

## Dependencies

- Secrets tier blocks on the auth enforce-flip (`PUSH_SESSION_GATE_ENFORCE`),
  see Platform decision #1.

## Non-goals

- CLI settings sync (deferred; additive later via an identity-keyed read).
- Context-memory unification.
- Scratchpad/todo content (reassigned to chat/session continuity — see Open
  questions #5).
- Multi-user / per-user partitioning beyond keying the doc by identity.
