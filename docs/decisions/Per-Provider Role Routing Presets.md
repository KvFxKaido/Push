# Per-Provider Role Routing Presets ("Push Auto")

Status: **Draft**
Reviewed: 2026-06-28

A design note for a user-selectable, capability-tagged **routing preset** that
fans Push's internal roles out to the best-fit model *within a single provider*
in one selection — Zen Go first. This is the Push-native, governed answer to the
per-stage model-assignment workflows people hand-build on top of OpenCode Go
(Orchestrator→big model, Explore→flash, Apply→code model, etc.).

> **Framing.** This is colloquially "MoE," but it is **model-level routing**, not
> mixture-of-experts at the weights/layer level. We build it as a *routing
> profile over the existing role system*, not a new model. The "fake model in
> the provider dropdown" packaging is explicitly rejected (see §5).

## 1. Why this is mostly already built

Push's role system **is** per-stage routing. The single resolution seam is:

```
app/src/lib/providers.ts → getModelForRole(provider, role): AIModel | undefined
```

Today every role on a provider resolves through `MODEL_NAME_GETTERS[type]()` —
**one stored model name for all five roles**. So Orchestrator, Coder, Explorer,
Reviewer, and Auditor all return the same `id` for a given provider. The lock
semantics (Agent Runtime Decisions; CLAUDE.md "Provider routing") then layer on
top: the chat locks Orchestrator on first send, Coder/Explorer inherit, Reviewer
keeps a sticky pick, Auditor follows the lock.

A routing preset is therefore a **single-function change in shape**: when a
preset is active for the provider, `getModelForRole` returns the *preset's
per-role model* instead of the one shared stored model. Everything downstream
(`coder-agent.ts:206`, `explorer-agent.ts:152`, `inline-coder-run.ts:463`,
`auditor-agent.ts`) already calls `getModelForRole` / takes a model override, so
no call site changes.

## 2. Capability tags, not pinned model IDs

The trap (CLAUDE.md "fold in, don't outsource"; the OpenCode-Go Reddit table is
already stale — "V4 Flash", "Kimi K2.7", "MiniMax M2.7" churn monthly): a
hardcoded role→modelId table per provider becomes a maintenance liability on
someone else's release schedule.

So a preset maps **role → capability intent**, and intent resolves against the
*currently advertised* catalog at runtime:

```ts
// New, in lib/ (shared web+CLI) — e.g. lib/role-routing-preset.ts
type RoleRoutingIntent =
  | 'cheap-fast'      // high-volume scans, low stakes (Explorer)
  | 'strong-code'    // edits + tool use (Coder)
  | 'strong-reason'  // planning / lead turn (Orchestrator)
  | 'independent-judge'; // verification (Reviewer/Auditor)

interface RoleRoutingPreset {
  id: string;                 // 'zen-go-auto'
  provider: RealProviderId;   // 'zen'
  label: string;              // 'Zen Go — Auto'
  // Ordered candidate intents per role; first resolvable wins.
  roles: Record<AgentRole, RoleRoutingIntent>;
}
```

Resolution reuses what already exists in `model-catalog.ts`:
`getModelCapabilities(provider, id)` (reasoning/toolCall/context) +
`resolvePushCapabilityProfile`. An intent picks the best live model from the
provider's curated list (`ZEN_GO_MODELS`) matching the capability shape, with a
**declared fallback id** per intent so a cold metadata cache or a retired model
never dead-ends. When a preset can't resolve a role to a live model, it falls
back to the provider's default model and emits a structured log (see §6) — never
a silent substitution.

### Starter preset — Zen Go (illustrative, resolved at runtime)

| Role | Intent | Resolves to (today's `ZEN_GO_MODELS`) | Why |
|---|---|---|---|
| Orchestrator | `strong-reason` | `glm-5.2` / `minimax-m3` | lead turn, planning |
| Explorer | `cheap-fast` | `deepseek-v4-flash` | high-volume read-only scans |
| Coder | `strong-code` | `kimi-k2.7-code` | edits + native tool calling |
| Reviewer | `independent-judge` | `qwen3.7-max` (≠ Coder) | independent attribution |
| Auditor | `independent-judge` | `glm-5.2` | gate; distinct from Coder |

The IDs are *outputs of resolution*, shown for review only — the preset stores
intents, not these strings.

## 3. Interaction with the Orchestrator lock

Open contract question to settle before code (this is why it's a decision note,
not just a PR). Today the lock pins one provider+model. With a preset:

- **Decision:** the lock pins the **provider + active preset id** (not a single
  model). On first send, the chat records `{ provider: 'zen', preset: 'zen-go-auto' }`.
  Delegated Coder/Explorer resolve their role through the *locked preset*, so a
  mid-chat settings change can't repoint a running chat's roles — same
  stability guarantee the model lock gives today.
- Reviewer's sticky selection still overrides the preset's Reviewer entry when
  the user has set one (preset is the default, not a mandate).
- Failover (`orchestrator-provider-routing.ts:resolveFailoverCandidates`) keys
  on the *resolved* model's wire shape per role, unchanged — the preset resolves
  to a concrete id before failover runs, so the Anthropic-transport isolation
  (Zen Go MiniMax/Qwen) still holds per role.

## 4. Keep the audit gate escapable cross-provider

A single-provider preset fans every role into one provider — which **weakens the
one gate where model diversity matters most**. Reviewer/Auditor exist partly so a
*different* model catches the Coder's mistakes. So:

- A preset MAY set `independent-judge` roles to a different *provider* (e.g. Zen
  Go Coder, Anthropic Auditor) — the preset is not constrained to its own
  provider for the judge roles. The `provider` field becomes the *default*
  provider; per-role entries may override it.
- The default Zen Go preset keeps Auditor on a Zen model *distinct from* the
  Coder model at minimum; a "diversity on" variant points it cross-provider when
  a second key is configured.

## 5. What we are NOT doing

- **No synthetic "model" entry in the provider dropdown.** It can't be called as
  a model, can't be used outside the role system, and lies about what the user
  is talking to. The preset is a **separate picker** ("Routing: Single model /
  Zen Go Auto"), not a row in the model list. This also keeps `makeRoleModels`
  (which already emits one entry per role) untouched.
- **No new provider.** Zen is already wired (`zenStream`, `zen-go.ts`,
  `useZenConfig`). This rides existing transport.
- **No prompt-level routing.** Behavior lives in `getModelForRole`, governed by
  the same capability/role machinery — not in a prompt the model could ignore
  (CLAUDE.md "Behavior lives in code, not prompts").

## 6. Cross-surface + observability obligations (new-feature checklist)

1. **Storage scope CLI-first.** Preset selection is keyed durable
   (`repoFullName + branch`), with the resolver in `lib/` from day one — not a
   web `chatId`-shaped key. CLI reads the same preset.
2. **One source of truth + drift test.** Preset definitions + the
   intent→capability resolver live in `lib/role-routing-preset.ts`, consumed by
   web and CLI. A drift test pins the intent vocabulary and asserts every
   preset's roles resolve to a non-empty model for the curated catalog
   (extend `cli/tests/protocol-drift.test.mjs` shape).
3. **Symmetric structured logs.** Every resolution branch logs:
   `role_routing_resolved` ↔ `role_routing_intent_unmet` (fell back to provider
   default) ↔ `role_routing_preset_missing`. `console.log` on web/worker;
   `console.error` in the shared `lib/` module so CLI stdout stays clean.

## 7. Build order

1. `lib/role-routing-preset.ts` — types, intent→capability resolver, Zen Go
   preset, fallbacks. Pure; unit-tested in isolation.
2. Thread an optional active-preset lookup into `getModelForRole` (web) and the
   CLI equivalent; default off → byte-identical behavior to today.
3. Persist preset selection (durable key) + lock it alongside the Orchestrator
   provider on first send.
4. Settings UI: a "Routing" selector next to the provider/model picker.
5. Drift test + structured logs land in the same PR as the resolver.
6. Flip this note to **Current** when steps 1–5 ship (decision-doc discipline).

## Open questions for review

- Do we want `independent-judge` to default cross-provider when a second key
  exists, or stay in-provider until the user opts in? (Leaning: in-provider
  default, one-tap "add diversity".)
- Should presets be **user-authorable** (CLI `.push/` file) in v1, or
  curated-only with user authoring as a follow-up? (Leaning: curated-only v1.)
- Intent vocabulary size — is 4 intents enough, or do we need a `long-context`
  intent distinct from `strong-reason` for big-repo Explorer scans?
