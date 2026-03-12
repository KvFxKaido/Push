# Duplication and Structural Symmetry Analysis

Current audit of repeated structure across Push. This is observational only. No behavior changes are proposed here.

Last audit: 2026-03-12

## Snapshot

The codebase is strongly symmetric along three axes:

1. Provider axis
2. Surface axis (web app vs CLI)
3. Role/config axis (Orchestrator/Coder/Reviewer/Auditor, plus provider-specific settings)

Most of the obvious provider duplication is already consolidated behind factories and registries. The biggest remaining repetition is in the Settings and model-catalog layer. The highest drift risk is in web/CLI mirrored modules that now implement the same concept differently.

## 1. Provider Axis — Mostly Consolidated

### 1a. Config hooks are thin wrappers

The built-in provider hooks are now intentionally tiny wrappers over shared factories:

- `app/src/hooks/useApiKeyConfig.ts`
- `app/src/hooks/useOllamaConfig.ts`
- `app/src/hooks/useOpenRouterConfig.ts`
- `app/src/hooks/useZenConfig.ts`
- `app/src/hooks/useNvidiaConfig.ts`
- `app/src/hooks/useTavilyConfig.ts`

This is good symmetry, not problematic duplication. Each provider contributes only storage keys, env vars, and defaults.

### 1b. Provider metadata is centralized

`app/src/lib/providers.ts` is now the main provider registry:

- `PROVIDER_URLS` centralizes chat and model endpoints
- `makeRoleModels()` builds the per-role model entries
- `createModelNameStorage()` centralizes runtime model-name persistence
- `MODEL_NAME_GETTERS` routes provider lookups through one table

This means the provider layer is structurally repetitive, but the repetition is data-shaped rather than code-shaped.

### 1c. Streaming configuration is registry-driven

`app/src/lib/orchestrator.ts` consolidates provider chat setup behind `PROVIDER_STREAM_CONFIGS` and `streamProviderChat()`.

That is the right kind of symmetry:

- shared stream engine
- per-provider config entries
- thin compatibility exports like `streamOllamaChat`

The remaining provider differences here are real differences: key lookup, model lookup, base URL rules, and Vertex-specific headers.

### 1d. Worker handlers are factory-backed, but route dispatch is still manual

`app/worker.ts` already removed most handler boilerplate through:

- `runPreamble()`
- `createStreamProxyHandler()`
- `createJsonProxyHandler()`

What remains repetitive is the top-level route dispatch chain in `fetch()`, where every endpoint is still wired by a separate `if (url.pathname === ...)` branch.

This is not a correctness issue. It is a remaining structural mirror:

- handler bodies are factory-generated
- route registration is still handwritten

## 2. Settings and Model Catalog — Largest Remaining Local Duplication

### 2a. `SettingsAIProps` is a repeated provider contract

`app/src/components/SettingsSheet.tsx` contains a very large `SettingsAIProps` interface that manually expands nearly the same shape for:

- Ollama
- OpenRouter
- Zen
- Nvidia
- Azure
- Bedrock
- Vertex
- Tavily

This is the strongest local repetition in the web app today. The duplication is mostly type-surface duplication rather than rendering duplication.

### 2b. `useModelCatalog()` repeats provider slices

`app/src/hooks/useModelCatalog.ts` repeats the same pattern several times for the built-in providers:

- key input state
- model list state
- loading state
- error state
- updated-at state
- refresh callback
- auto-fetch effect
- clear-on-key-removal effect

This file is already partially consolidated through `refreshModels()`, but the surrounding state still expands provider-by-provider.

The symmetry is especially visible around:

- `ollama`
- `openrouter`
- `zen`
- `nvidia`

Azure, Bedrock, and Vertex then follow the same broader settings pattern with different field sets.

### 2c. UI rendering is partially consolidated

`SettingsSheet.tsx` already extracted:

- `ProviderKeySection`
- `ExperimentalProviderSection`
- `VertexProviderSection`

That means the visual duplication is significantly lower than the data/prop duplication. The remaining repetition is mostly in prop plumbing and in the provider-specific input state assembled by `useModelCatalog()`.

## 3. Experimental Connectors — Clean Azure/Bedrock Symmetry, Intentional Vertex Fork

`app/src/hooks/useExperimentalProviderConfig.ts` cleanly consolidates Azure and Bedrock behind `createExperimentalProviderConfig()`.

This is a strong example of useful symmetry:

- same storage pattern
- same validation pattern
- same deployment-list lifecycle
- same getter + hook dual export pattern

`app/src/hooks/useVertexConfig.ts` is parallel to that abstraction, but it is intentionally separate because Vertex has extra complexity:

- native service-account mode
- legacy raw-endpoint mode
- region validation
- transport selection (`openapi` vs `anthropic`)

So this is mirrored structure, but not accidental duplication. Vertex is a sibling abstraction, not just an unrefactored copy.

## 4. Web/CLI Mirrors — The Main Drift Hotspot

The repo now has several conceptually paired modules across web and CLI. These are the highest-risk symmetry points because they look related but no longer behave identically.

### 4a. `hashline` exists twice and has materially diverged

Files:

- `app/src/lib/hashline.ts`
- `cli/hashline.mjs`

Both implement hash-anchored editing, but the implementations are no longer equivalent.

Web version characteristics:

- async SHA-256 hashing
- 7 to 12 character ref support
- two-phase batch resolution
- ambiguity diagnostics
- structured `{ content, applied, failed, errors }` result

CLI version characteristics:

- sync SHA-1 hashing
- refs normalized down to 7 chars
- inline sequential resolution
- different ambiguity/staleness behavior
- structured `{ content, applied }` result with a different shape

This is the clearest example of duplicated concept with behavioral drift.

### 4b. Model catalog logic exists on both surfaces

Files:

- `app/src/lib/model-catalog.ts`
- `cli/model-catalog.mjs`
- `app/src/lib/providers.ts`

Both surfaces maintain curated defaults, model lists, and live `/models` fetching logic, but they do so differently:

- different curated catalogs
- different default model strings
- different normalization breadth
- different fallback behavior
- different placement of provider metadata

This is not just symmetry. It is split source-of-truth risk.

### 4c. Tool-call metrics are parallel, but not parity-aligned

Files:

- `app/src/lib/tool-call-metrics.ts`
- `cli/tool-call-metrics.mjs`

The web app records rich metrics by provider, model, reason, and tool. The CLI records only a count by reason.

That may be acceptable, but it is another mirrored module where one side has evolved and the other has remained minimal.

### 4d. Workspace-context naming is symmetric, semantics are different

Files:

- `app/src/lib/workspace-context.ts`
- `cli/workspace-context.mjs`

These two files share a name but solve different problems:

- web: summarize GitHub repo context for prompt injection
- CLI: inspect the local filesystem, manifests, git state, memory, and instruction files

This is structural symmetry at the product level, not code duplication. The shared naming is useful, but they should not be treated as interchangeable implementations.

## 5. Project Instructions Loading — Partial Symmetry With a Narrower Sandbox Path

Project-instruction loading now exists in multiple layers:

- `app/src/lib/github-tools.ts` fetches `AGENTS.md`, then `CLAUDE.md`, then `GEMINI.md`
- `app/src/lib/project-instructions-utils.ts` supports syncing those three files from sandbox paths
- `cli/workspace-context.mjs` looks for `.push/instructions.md`, then `AGENTS.md`, then `CLAUDE.md`, then `GEMINI.md`

Inside the web hook, there is a local asymmetry:

- `refreshProjectInstructionsFromSandbox()` uses the shared sandbox sync helper
- the Phase B sandbox-upgrade effect in `app/src/hooks/useProjectInstructions.ts` directly reads only `/workspace/AGENTS.md`

That means the same feature area has both:

- a generalized helper path
- a narrower one-off path

This is a small duplication seam and a small symmetry break. It is not necessarily wrong, but it is easy to miss during future edits.

## 6. Structural Symmetry That Looks Healthy

Not all symmetry here is a problem. Some of it is exactly what we want.

Healthy symmetry examples:

- provider hooks built from shared factories
- provider metadata stored as registries instead of conditionals
- orchestrator stream setup routed through a provider table
- Azure and Bedrock sharing one experimental-provider config factory
- worker handler bodies generated from stream/JSON proxy factories

These areas are repetitive in shape, but the repetition has been pushed into configuration instead of copied implementation.

## 7. Summary Map

### Already centralized

- Provider config hooks
- Provider endpoint registry
- Per-role model generation
- Runtime model getter registry
- Stream proxy handler factories
- Experimental provider config factory

### Biggest remaining repetition

- `SettingsAIProps` in `app/src/components/SettingsSheet.tsx`
- provider-sliced state assembly in `app/src/hooks/useModelCatalog.ts`
- manual route registration in `app/worker.ts`

### Highest drift risk

- `app/src/lib/hashline.ts` vs `cli/hashline.mjs`
- `app/src/lib/model-catalog.ts` plus `app/src/lib/providers.ts` vs `cli/model-catalog.mjs`
- project-instruction loading paths across web, sandbox, and CLI
- `app/src/lib/tool-call-metrics.ts` vs `cli/tool-call-metrics.mjs`

## Bottom Line

The codebase is no longer suffering from broad copy-paste duplication. Most of the large provider-axis duplication has already been converted into registries and factories.

The remaining work is narrower:

- large prop/state surfaces in Settings
- route-registration boilerplate
- web/CLI concept pairs that have drifted into separate implementations

If this area gets revisited later, the highest-value lens is not "remove all repetition." It is "decide which mirrored modules should truly share behavior and which ones should stay intentionally forked."
