# Per-Provider Role Routing Presets ("Push Auto")

Status: **Draft**
Reviewed: 2026-06-28
Validated: 2026-06-30 against `main` @ `5b78db0e` — see [Validation](#validation--2026-06-30). Core web-seam claims hold; the real scope is reconciling with the CLI's **already-built** `roleRouting`, not a single-function add.

A design note for a user-selectable, capability-tagged **routing preset** that
fans Push's internal roles out to the best-fit model for a primary provider,
with explicit per-role provider overrides for judge roles. Zen is the first
shared-catalog target; Zen Go can use the same shape once its Go-tier catalog is
available to both web and CLI. This is the Push-native, governed answer to the
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

For the web, a routing preset is therefore a **single-seam change in shape**:
when a preset is active for the provider, `getModelForRole` returns the
*preset's per-role model* instead of the one shared stored model. The production
caller set is broader than the first-pass shorthand: `coder-agent.ts:206`
(Coder), `explorer-agent.ts:152` (Explorer), `inline-coder-run.ts:467`
(Orchestrator, not Coder), `auditor-agent.ts:49`, `WorkspaceHubSheet.tsx` (×2,
Orchestrator), `HubReviewTab.tsx` (×2, Reviewer), and
`ensure-commit-target-branch.ts:201` (Orchestrator) all already go through the
seam or take its resolved override. Those callers should not need custom routing
logic, but the product work is not only this function because the CLI already
has a separate `roleRouting` map to reconcile.

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
  id: string;               // 'zen-auto'
  provider: RealProviderId; // default provider, e.g. 'zen'
  label: string;            // 'Zen — Auto'
  // Ordered candidate intent per role; provider defaults to preset.provider.
  roles: Record<
    AgentRole,
    {
      intent: RoleRoutingIntent;
      provider?: RealProviderId; // cross-provider judge override
      fallbackModel?: string;    // declared fallback if metadata is cold/stale
    }
  >;
}

type ResolvedRoleRoutingPreset = Record<
  AgentRole,
  { provider: RealProviderId; model: string }
>;
```

Resolution reuses the catalog-capability primitives from `model-catalog.ts`:
`getModelCapabilities(provider, id)` (reasoning/toolCall/context) +
`resolvePushCapabilityProfile`. The web seam file (`providers.ts`) currently
imports a different helper from `./model-capabilities`, so wiring this into
`getModelForRole` means introducing an explicit catalog-capability import/alias,
not treating the existing import as sufficient. An intent picks the best live
model from the provider's shared curated list (`ZEN_MODELS` in
`lib/provider-models.ts` for v1) matching the capability shape, with a
**declared fallback id** per intent so a cold metadata cache or a retired model
never dead-ends. If the v1 target remains Zen Go, first move the Go-tier
`ZEN_GO_MODELS` list out of `app/src/lib/zen-go.ts` into shared `lib/` so the
CLI and drift tests resolve the same catalog. When a preset can't resolve a role
to a live model, it falls back to the provider's default model and emits a
structured log (see §6) — never a silent substitution.

### Starter preset — Zen shared catalog (illustrative, resolved at runtime)

| Role | Intent | Resolves to (today's `ZEN_MODELS`) | Why |
|---|---|---|---|
| Orchestrator | `strong-reason` | `glm-5.1` / `deepseek-v4-pro` | lead turn, planning |
| Explorer | `cheap-fast` | `deepseek-v4-flash` | high-volume read-only scans |
| Coder | `strong-code` | `kimi-k2.6` | edits + native tool calling |
| Reviewer | `independent-judge` | `qwen3.6-plus` (≠ Coder) | independent attribution |
| Auditor | `independent-judge` | `glm-5.1` / `minimax-m3-free` | gate; distinct from Coder |

The IDs are *outputs of resolution*, shown for review only — the preset stores
intents, not these strings.

## 3. Interaction with the Orchestrator lock

Open contract question to settle before code (this is why it's a decision note,
not just a PR). Today the lock pins one provider+model. With a preset:

- **Decision:** the lock pins the **provider + active preset id** (not a single
  model). On first send, the chat records `{ provider: 'zen', preset: 'zen-auto' }`.
  Delegated Coder/Explorer resolve their role through the *locked preset*, so a
  mid-chat settings change can't repoint a running chat's roles — same
  stability guarantee the model lock gives today.
- Reviewer's sticky selection still overrides the preset's Reviewer entry when
  the user has set one (preset is the default, not a mandate).
- Failover (`orchestrator-provider-routing.ts:resolveFailoverCandidates`) keys
  on the *resolved* model's wire shape per role, unchanged — the preset resolves
  to a concrete id before failover runs, so provider-specific transport
  isolation still holds per role.

## 4. Keep the audit gate escapable cross-provider

A default-provider preset can fan every role into one provider — which
**weakens the one gate where model diversity matters most**. Reviewer/Auditor
exist partly so a *different* model catches the Coder's mistakes. So:

- A preset MAY set `independent-judge` roles to a different *provider* (e.g. Zen
  Coder, Anthropic Auditor) — the preset is not constrained to its own default
  provider for the judge roles. The `provider` field becomes the *default*
  provider; per-role entries may override it.
- The default Zen preset keeps Auditor on a Zen model *distinct from* the
  Coder model at minimum; a "diversity on" variant points it cross-provider when
  a second key is configured.

## 5. What we are NOT doing

- **No synthetic "model" entry in the provider dropdown.** It can't be called as
  a model, can't be used outside the role system, and lies about what the user
  is talking to. The preset is a **separate picker** ("Routing: Single model /
  Zen Auto"), not a row in the model list. This also keeps `makeRoleModels`
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
   *(Build-time, post-#1272: the `RuntimeIntervention` contract in
   `lib/runtime-intervention.ts` is the emerging idiom for runtime-generated
   events with stable `source`/`reason` codes — routing resolution isn't a loop
   intervention so these stay plain structured logs, but weigh giving the
   `intent_unmet` event a `source: 'role_routing'` shape for run-event
   consistency.)*

## 7. Build order

1. `lib/role-routing-preset.ts` — types, intent→capability resolver, Zen shared
   catalog preset, fallbacks. Pure; unit-tested in isolation. If the product
   wants Zen Go as the first named preset, this step includes moving the Go-tier
   model list into shared `lib/` before the drift test lands.
2. Reconcile the resolver output with the CLI's existing `entry.state.roleRouting`
   shape before adding a web-only path. The CLI has **no `getModelForRole` twin**:
   per-role routing already exists via `configure_role_routing` and accepts all
   `VALID_AGENT_ROLES`, while delegation currently reads Coder, Explorer, and
   Reviewer (Reviewer is shared by `delegate_reviewer` and the deep reviewer).
   The CLI step is therefore *populating that existing structure* from the
   resolved preset — at minimum Coder, Explorer, and Reviewer, with any stored
   Auditor/Orchestrator entries documented until daemon consumers exist — not
   threading a new lookup. Then teach the web to consume the same resolved map
   inside `getModelForRole`. Default off → byte-identical behavior on both
   surfaces. (See [Validation](#validation--2026-06-30); this is the crux of
   obligation §6.2.)
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

## Validation — 2026-06-30

Traced against `main` @ `5b78db0e`. The web-seam analysis holds; the headline
"single-function change / mostly already built" is accurate for the **web in
isolation** but undersells scope, because the **CLI already implements per-role
routing through a different mechanism this note never mentions**.

### Confirmed

- **`getModelForRole` is the single web seam.** `app/src/lib/providers.ts:470`
  resolves `(provider, role)`, but the getter is keyed by **provider only**
  (`MODEL_NAME_GETTERS[type]`, :447) — `resolvedId = getter()` (:478) returns one
  stored id for all five roles. Per-role resolution genuinely localizes here.
  §1/§2 are correct after folding in the call-site and resolved-map corrections
  above.
- **Capability primitives exist.** `getModelCapabilities` and
  `resolvePushCapabilityProfile` (`app/src/lib/model-catalog.ts:411 / :723`)
  return the `toolCalling`/`reasoning`/`context` shape an intent matches on — the
  resolver is buildable as described. *Caveat:* there are **two**
  `getModelCapabilities` (`model-catalog.ts` and `model-capabilities.ts`); the
  resolver must use the catalog one, and `providers.ts` currently imports the
  other one for display-model capabilities.
- **"No call-site changes" holds** — every consumer goes through the seam.

### Corrections

- **§1's call-site list is incomplete and slightly mislabeled.** Production
  callers are ~7, not 4: add `WorkspaceHubSheet.tsx` (×2, orchestrator),
  `HubReviewTab.tsx` (×2, reviewer), and `ensure-commit-target-branch.ts:201`
  (orchestrator). And `inline-coder-run.ts:467` resolves **`orchestrator`**, not
  Coder. Harmless — they'd render preset-resolved models for free — but the count
  should be right.
- **§3's lock is a thread, not a record.** `lockedProvider`/`lockedModel`
  (strings) already run through `chat-prepare-send.ts`, `CommitPushSheet`,
  `SettingsSheet`, and `settings-built-in-provider-builder`. Pinning a preset id
  touches that payload at every site.

### The load-bearing gap: the CLI already does this (differently)

`cli/pushd.ts` resolves `entry.state.roleRouting.{coder,explorer,reviewer}` as
independent `{provider, model}` per role (`:4974`, explorer block, reviewer
block), set via the **`configure_role_routing`** protocol verb (schema-pinned in
`lib/protocol-schema.ts` + `protocol-json-schema.ts`, capability
`delegation_coder_v1`, with a TUI surface). `VALID_AGENT_ROLES` accepts all five
roles, and both `delegate_reviewer` and the deep reviewer read
`roleRouting.reviewer`, so it already supports **cross-provider per role** for
the §4 "escapable judge" capability this note frames as future. The **web
consumes none of it** (`roleRouting` appears in `app/src` only inside the shared
schema validators).

So per-role routing is **not greenfield**: two mechanisms already exist (the web's
single-model `getModelForRole`, the CLI's explicit `roleRouting`), which makes
§6.2's "one source of truth, consumed by web and CLI" the *hardest* obligation,
not a checkbox — a second source is already there.

### Recommended reframe — preset as a generator, not a third system

Have `lib/role-routing-preset.ts` resolve intent →
`Record<AgentRole, {provider, model}>`, then:

- **CLI** consumes it by *populating `entry.state.roleRouting`* — the structure
  already exists and is already read on Coder, Explorer, and Reviewer delegation.
- **Web** learns to consume the same resolved map inside `getModelForRole`.

This makes "one source of truth" real: the resolver feeds the CLI's existing
structure and a mirrored web structure of identical shape, instead of standing up
a parallel preset path the CLI then duplicates. **Add a step 0 to §7:** reconcile
the resolver's output type with `entry.state.roleRouting` so the CLI consumes
presets by writing the structure it already reads.

### Verdict

The bones are *better* than the note claims — the CLI half is largely built — but
in a place the note didn't look. This moves the work from "single-function change"
to **small-but-genuine cross-surface reconciliation**. Still worth doing.
