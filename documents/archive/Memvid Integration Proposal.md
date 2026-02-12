# User Profile & Personalization — Sprint Spec

> **Status:** Tickets 1-3 complete. Ticket 4 (Skill Presets) deferred as stretch.
> **Date:** 2026-02-09
> **Goal:** Let the user tell the model who they are. Ship a Settings section for identity + preferences, inject it into the system prompt.

---

## Direction

Local-first, client-only personalization. No backend. No Memvid (yet).

Ship order:
1. **Profile hook + data model** (localStorage, getter function, React hook)
2. **Settings UI section** ("About You" in Settings sheet)
3. **Prompt injection** (identity block into system prompt)
4. **Skill presets** (stretch — curated behavior toggles)

Defer: server memory, Memvid, R2, embeddings, onboarding cards, telemetry. Revisit when local profile proves insufficient.

---

## Data Model

```typescript
// types/index.ts

interface UserProfile {
  /** Display name for prompt identity */
  displayName: string;
  /** GitHub login — auto-populated from auth, read-only */
  githubLogin?: string;
  /** Freeform context the user wants the model to know */
  bio: string;
}

const USER_PROFILE_DEFAULTS: UserProfile = {
  displayName: '',
  githubLogin: undefined,
  bio: '',
};
```

**localStorage key:** `push_user_profile`
**Storage format:** JSON string of `UserProfile`

---

## Prompt Block

When `displayName` is non-empty, inject this block into the system prompt (after workspace context, before tool protocols):

```
## User Identity
Name: {displayName}
GitHub: @{githubLogin}
{bio ? `Context: {bio}` : ''}
```

**Token budget:** ~30-60 tokens. Capped at 300 chars for `bio`.

When `displayName` is empty, omit the block entirely.

---

## Skill Presets (Stretch)

Each preset maps to a short prompt snippet injected after the User Identity block.

| Preset | Prompt Snippet |
|--------|---------------|
| `strict-review` | "Flag security risks and edge cases before suggesting changes. Prefer smaller, auditable diffs. Ask before large refactors." |
| `ship-fast` | "Optimize for speed of delivery. Minimal review friction. Suggest the simplest working solution first." |
| `test-first` | "Always suggest or write tests before implementation. Flag untested code paths." |
| `docs-heavy` | "Include inline comments, JSDoc, and README updates with every code change." |

**localStorage key:** `push_active_preset`
**Storage format:** string (preset name) or `null`

---

## Scratchpad Boundary

The scratchpad is **freeform per-session notes** (AI + user can write). Profile memory is **structured cross-session identity** (user-only writes). They coexist — both inject into the system prompt, in separate blocks, no overlap.

---

## Security Rules

1. All data localStorage-only — never sent to any backend except as part of the LLM prompt
2. `bio` field is escaped using the same sanitizer as scratchpad content (`lib/scratchpad-tools.ts` pattern)
3. Never store tokens, keys, or passwords in profile
4. "Clear Profile" wipes all fields atomically and removes prompt block on next message

---

## Sprint Tickets

> **Parallel safety:** Tickets 1-2 can run in parallel (different files). Ticket 3 depends on both. Ticket 4 is independent stretch work.

---

### Ticket 1: Profile Hook + Data Model

**Files to create/edit:**
- `app/src/hooks/useUserProfile.ts` — **new file**
- `app/src/types/index.ts` — add `UserProfile` type

**Scope:**
- [x] Define `UserProfile` interface and `USER_PROFILE_DEFAULTS` in `types/index.ts`
- [x] Create `useUserProfile` hook following the `useOllamaConfig.ts` pattern:
  - `getUserProfile(): UserProfile` — standalone getter (reads localStorage, returns defaults for missing fields)
  - `useUserProfile()` — React hook returning `{ profile, updateProfile, clearProfile }`
  - `updateProfile(partial: Partial<UserProfile>)` — merges into existing, saves to localStorage
  - `clearProfile()` — resets to defaults, removes localStorage key
- [x] Auto-populate `githubLogin` from auth state when available (pass as param or read from `localStorage` key used by `useGitHubAuth`)
- [x] Cap `bio` at 300 chars on save

**Reference pattern:** `app/src/hooks/useOllamaConfig.ts` (standalone getter + React hook)

**localStorage key:** `push_user_profile`

**Does NOT touch:** App.tsx, orchestrator.ts, any UI files

---

### Ticket 2: Settings UI — "About You" Section

**Files to edit:**
- `app/src/App.tsx` — add section in Settings sheet

**Scope:**
- [x] Add "About You" section in Settings sheet, placed in "You" tab (tabbed Settings redesign)
- [x] Fields:
  - `Your Name` — text input (maps to `displayName`)
  - `GitHub` — read-only display of `githubLogin` (auto-populated from auth)
  - `About You` — textarea, 300 char limit (maps to `bio`), placeholder: "Anything you want the assistant to know about you"
- [x] "Clear Profile" button with confirmation (same pattern as "Delete all chats")
- [x] Use `useUserProfile()` hook from Ticket 1
- [x] Match existing Settings styling (dark theme, `bg-[#111]` inputs, `border-[#333]`)

**Does NOT touch:** orchestrator.ts, hooks/ (except importing useUserProfile), types/

**Wireframe:**
```text
Settings
  About You
    Your Name     [ ______________ ]
    GitHub        @username (read-only)
    About You     [ _________________________ ]
                  [ _________________________ ]  (textarea, 300 char)

    [ Clear Profile ]
```

---

### Ticket 3: Prompt Injection

**Depends on:** Ticket 1

**Files to edit:**
- `app/src/lib/orchestrator.ts` — inject profile block into system prompt assembly

**Scope:**
- [x] Import `getUserProfile` from `useUserProfile.ts`
- [x] Add `buildUserIdentityBlock(profile: UserProfile): string` function
  - Returns the formatted block from the "Prompt Block" section above
  - Returns empty string if `displayName` is empty
  - Escapes `bio` using identity-block boundary sanitization (prevents `[USER IDENTITY]` tag injection)
- [x] Inject the block in `toLLMMessages()` after base system prompt, before workspace context
- [x] Also inject into Coder context in `lib/coder-agent.ts` (so delegated coding tasks know the user's name)

**Does NOT touch:** App.tsx, Settings UI, types/

**Acceptance criteria:**
- With name set: system prompt includes `## User Identity` block
- With name empty: block is completely absent (no empty section header)
- Bio with prompt-injection attempt (e.g., "Ignore previous instructions") is escaped

---

### Ticket 4: Skill Presets (Stretch)

**Files to create/edit:**
- `app/src/lib/skill-presets.ts` — **new file**
- `app/src/hooks/useUserProfile.ts` — add preset state (or separate `useSkillPreset` hook)
- `app/src/App.tsx` — add preset selector in Settings
- `app/src/lib/orchestrator.ts` — inject preset snippet

**Scope:**
- [ ] Define preset map (name → prompt snippet) in `skill-presets.ts`
- [ ] Store active preset in localStorage (`push_active_preset`)
- [ ] Add preset selector in Settings under "About You" section (radio group or segmented control)
- [ ] Inject active preset snippet after User Identity block in system prompt
- [ ] Preset is informational only — no behavior flags that change app logic

**Does NOT touch:** tool-dispatch.ts, sandbox code, GitHub tools

---

## Deferred (Not This Sprint)

- Memvid / server-side memory
- R2 storage
- Embedding / vector retrieval
- Onboarding discovery card
- Chat header quick-switch for presets
- Telemetry / evidence capture
- Scratchpad replatforming
