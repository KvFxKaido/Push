# Settings Unification — GitHub-Identity-Keyed Config

Date: 2026-06-07
Status: **draft** (design-in-motion; not roadmap-promoted)
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
| Content | `push-scratchpad*`, `push-todo` |

### Migrate later — secrets tier (gated on the auth enforce-flip)

~13 provider keys via the `use*Config` hooks: `{ollama,openrouter,zen,nvidia,kilocode,blackbox,openadapter,openai,anthropic,google}_api_key`, `tavily_api_key`, and Vertex (`vertex_api_key`, `vertex_service_account`, region/model).

These are the bulk by count and the **only** tier with a hard dependency:
syncing keys server-side puts them behind the session gate, which is still in
**observe mode** (`PUSH_SESSION_GATE_ENFORCE` not set). Do not sync secrets until
the gate is enforced. A defensible alternative is to *never* sync secrets and
enter them once per device — a reasonable posture for a security-minded single
user.

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

1. Generalize `pr-review-config` into `GET/PUT /api/settings` — one KV doc keyed
   by GitHub user id, LWW with `updatedAt`. Fold the existing `config:pr-review-*`
   into it (fixing the global-key → identity-key flaw).
2. Migrate the non-secret tier: each `use*Config` / appearance hook swaps its
   `safe-storage` backend for the settings doc (read-on-load, write-through,
   local cache for first-paint/offline). Put the read/write/merge resolver in a
   shared module so it isn't re-implemented per hook.
3. Reviewer config now lives in the shared doc → controlling the reviewer from
   any device is free, which unblocks the original reviewer-visibility goal.
4. Secrets tier — only after `PUSH_SESSION_GATE_ENFORCE=1` (or decide to never
   sync secrets).

## Open questions

1. **Do the two reviewer notions converge?** There's the autonomous PR reviewer
   (server config) and the in-app advisory reviewer (localStorage model picks).
   Unify into one reviewer-config block or keep distinct?
2. **Secrets posture:** sync-after-enforce vs. never-sync-enter-per-device.
3. **Per-device override layer:** schema shape for "global default + optional
   device pin" (theme is the obvious case).
4. **Conflict policy:** LWW is the proposed default; confirm it's acceptable for
   the rare two-devices-at-once edit.

## Dependencies

- Secrets tier blocks on the auth enforce-flip (`PUSH_SESSION_GATE_ENFORCE`),
  see Platform decision #1.
- Subsumes part of "Active Platform Work" item #3 (scratchpad storage substrate).

## Non-goals

- CLI settings sync (deferred; additive later via an identity-keyed read).
- Context-memory unification.
- Multi-user / per-user partitioning beyond keying the doc by identity.
