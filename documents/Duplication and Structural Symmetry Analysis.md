# Duplication and Structural Symmetry Analysis

Analysis of repeated patterns, structural symmetry, and consolidation opportunities across the Push codebase. This document is observational — no behavior changes proposed.

**Last audit: 2026-02-19 — ~75% of identified duplication has been consolidated.**

---

## 1. Provider Axis — The Six-Way Symmetry

The codebase is organized around six AI providers (Kimi/Moonshot, Ollama, Mistral, Z.ai, MiniMax, OpenRouter). Each provider requires identical plumbing at every layer. This creates a **six-way structural symmetry** that repeats across files:

### 1a. Config Hooks (already consolidated) — DONE

Each provider has a thin config hook wrapping the shared `useApiKeyConfig` factory:

| Hook file | Factory used | Extra state |
|-----------|-------------|-------------|
| `useMoonshotKey.ts` | `useApiKeyConfig` | key only |
| `useTavilyConfig.ts` | `useApiKeyConfig` | key only |
| `useOllamaConfig.ts` | `useApiKeyWithModelConfig` | key + model |
| `useMistralConfig.ts` | `useApiKeyWithModelConfig` | key + model |
| `useZaiConfig.ts` | `useApiKeyWithModelConfig` | key + model |
| `useMiniMaxConfig.ts` | `useApiKeyWithModelConfig` | key + model |
| `useOpenRouterConfig.ts` | `useApiKeyWithModelConfig` | key + model |

**Status:** DONE. Well-factored. The `useApiKeyConfig.ts` factory eliminated the duplication. Each hook is a 12–20 line thin wrapper.

### 1b. Provider Config — `providers.ts` — PARTIAL

The `PROVIDERS` array repeats the same three-role model block (orchestrator/coder/auditor) for each of the six providers. Each entry is structurally identical:

```typescript
{
  type: '<provider>',
  name: '<Display Name>',
  models: [
    { id: DEFAULT_MODEL, name: '... (Orchestrator)', provider: '<provider>', role: 'orchestrator', context: N },
    { id: DEFAULT_MODEL, name: '... (Coder)',        provider: '<provider>', role: 'coder',        context: N },
    { id: DEFAULT_MODEL, name: '... (Auditor)',      provider: '<provider>', role: 'auditor',      context: N },
  ],
}
```

Six providers × three roles = 18 model entries that share the same shape. The `getModelForRole()` function has a chain of `if (type === 'ollama') ... if (type === 'mistral') ...` blocks that could be a lookup table.

The `createModelNameStorage` factory at the bottom already consolidates the five per-provider model-name storage getters/setters.

**Status:** PARTIAL. `createModelNameStorage` is consolidated. `PROVIDERS` array and `getModelForRole()` if-chain remain as-is — structurally repetitive but functional.

### 1c. Orchestrator Streaming — `orchestrator.ts` — DONE

~~Six `stream*Chat` functions share identical signatures (11 parameters) and the same body structure.~~

~~**Already partially consolidated:** All six delegate to the shared `streamSSEChat()` engine. What remains duplicated is the per-provider wrapper function (~300 lines total for six wrappers).~~

**Status:** DONE. Fully consolidated via factory + registry pattern:
- `PROVIDER_STREAM_CONFIGS` registry maps each provider to `{ getKey, buildConfig }`.
- `buildErrorMessages(name, connectHint?)` factory generates all error messages — only provider name varies.
- `streamProviderChat()` single entry point: looks up provider → fetches key → builds config → delegates to `streamSSEChat()`.
- Six exports (`streamMoonshotChat`, etc.) are now **one-line lambdas** for backward compatibility.
- ~300 lines of wrapper duplication reduced to ~12 lines of thin lambdas.

### 1d. Worker Proxy — `worker.ts` — DONE

~~The Cloudflare Worker repeats the same handler skeleton 15+ times across provider endpoints.~~

~~**Estimated duplicated lines: ~400–450** out of ~2164 lines (~20% of the file).~~

**Status:** DONE. Fully consolidated via shared helpers and factories:
- `runPreamble()` — handles origin validation, rate limiting, auth header building, and body reading for all handlers.
- `createStreamProxyHandler()` — factory for SSE chat endpoints (Kimi, Ollama, Mistral, Z.ai, MiniMax, OpenRouter).
- `createJsonProxyHandler()` — factory for model list and search endpoints.
- `validateOrigin()`, `standardAuth()`, `getClientIp()`, `checkRateLimit()`, `readBodyText()` — all shared.
- Each handler is now 1–5 lines instead of 40–50. ~400–450 lines of duplication eliminated.
- The Z.ai/MiniMax consistency issues (Content-Type, clearTimeout) are resolved by the shared factories.

### 1e. Settings UI — `SettingsSheet.tsx` — DONE

~~Each provider's API key section repeats the same UI block (~40 lines per provider).~~

~~The input/save/clear pattern is copied six times with only the provider name and prop names changing.~~

**Status:** DONE. Shared `ProviderKeySection` component (~170 lines) handles key saving/clearing, model selection, model refresh (with loading/error states), and locked models. All 7 providers use it — each provider section is now 5–10 lines of config. ~240 lines of duplication eliminated.

---

## 2. Tool Protocol — Detection/Execution Symmetry — DONE

Each tool subsystem follows the same structural pattern:

```
detect*ToolCall(text: string): *ToolCall | null
  → calls detectToolFromText(text, validator)

execute*ToolCall(call, ...context): ToolExecutionResult
  → switch on tool name, call APIs, return { text, card? }
```

| Module | Detection | Execution | Shared infra |
|--------|-----------|-----------|--------------|
| `github-tools.ts` | `detectToolCall` | `executeToolCall` | `detectToolFromText` |
| `sandbox-tools.ts` | `detectSandboxToolCall` | `executeSandboxToolCall` | `detectToolFromText` |
| `scratchpad-tools.ts` | `detectScratchpadToolCall` | `executeScratchpadToolCall` | `detectToolFromText` |
| `web-search-tools.ts` | `detectWebSearchToolCall` | `executeWebSearch` | `detectToolFromText` |
| `tool-dispatch.ts` | `detectAnyToolCall` (aggregator) | `executeAnyToolCall` (router) | — |

**Status:** DONE. The `detectToolFromText<T>()` generic in `utils.ts` already eliminates the JSON-extraction duplication. Each tool module provides only its validator function. This layer is well-factored. All validators follow the same `(parsed: unknown) => T | null` signature.

---

## 3. Web Search Execution — ~~Triple Duplication~~ DONE

~~Three functions in `web-search-tools.ts` are near-identical.~~

~~Only three things differ: the URL, the authorization header, and the "key not configured" guard.~~

**Status:** DONE. `executeWebSearchCore(url, query, headers?)` handles fetch, error handling, result formatting, and card data construction. Three backends are now thin wrappers (3–10 lines each):
- `executeOllamaWebSearch` → calls core with Ollama URL + auth
- `executeFreeWebSearch` → calls core with DuckDuckGo URL, no auth
- `executeTavilySearch` → calls core with Tavily URL + auth

~150 lines of duplication reduced to ~50.

---

## 4. Diff Parsing — ~~Triple Duplication~~ DONE

~~Three functions across three files parse unified diffs with the same loop.~~

~~A shared `parseDiffStats(diff)` in `diff-utils.ts` (which already exists but doesn't contain this) would serve all three callers.~~

**Status:** DONE. `diff-utils.ts` now exports:
- `parseDiffStats()` — counts files/additions/deletions
- `parseDiffIntoFiles()` — splits diff into per-file sections
- `formatSize()` — human-friendly byte labels

All three callers (`sandbox-tools.ts`, `auditor-agent.ts`, `coder-agent.ts`) import from `diff-utils.ts`. No inline diff parsing remains.

---

## 5. Agent Module Symmetry — Coder vs Auditor — DONE

Both agent modules follow the same lifecycle:

```
1. Get active provider → guard on 'demo'
2. Get streamFn and model via getProviderStreamFn() / getModelForRole()
3. Build system prompt
4. Build messages array
5. streamWithTimeout(timeoutMs, message, (onToken, onDone, onError) => streamFn(...))
6. Check for stream error
7. Parse accumulated text
8. Return structured result
```

| Aspect | `coder-agent.ts` | `auditor-agent.ts` |
|--------|---------------------|---------------------|
| Provider/model setup | lines 247–253 | lines 63–78 |
| `streamWithTimeout` call | lines 308–326 | lines 91–107 |
| Stream error check | lines 327–332 | lines 108–122 |
| `truncateContent()` | defined locally (line 36) | not needed |

**Status:** DONE. The `streamWithTimeout` utility (in `utils.ts`) already consolidated what was previously duplicated. The remaining setup boilerplate (provider check → streamFn → model lookup) is ~10–12 lines per agent and not worth abstracting further.

---

## 6. Card Components — Structural Patterns

27 card components share significant structural repetition:

### 6a. Shell + Header (100% of cards) — PARTIAL

Every card wraps in `CARD_SHELL_CLASS` (shared constant) and uses a header. Shell is consolidated; headers are manually implemented per card (no shared `CardHeader` component extracted yet).

**Remaining:** A shared `CardHeader` component taking icon + title could reduce boilerplate across 27 cards.

### 6b. Expandable Pattern (5 cards) — DONE

PRCard, SandboxCard, DiffPreviewCard, FileCard, and EditorCard all use the expandable pattern.

**Status:** DONE. `expandable.tsx` exports `useExpandable`, `ExpandChevron`, and `ExpandableCardPanel` — all cards use these shared components. Wiring is minimal (~3 lines per card).

### 6c. Status Badge (6 cards) — NOT DONE

PRCard, AuditVerdictCard, SandboxCard, TestResultsCard, TypeCheckCard, and CIStatusCard each define independent status-to-color config objects:
```typescript
const statusConfig = {
  state1: { label: '...', color: 'bg-[#22c55e]/15 text-[#22c55e]' },
  state2: { label: '...', color: 'bg-[#ef4444]/15 text-[#ef4444]' },
};
```

**Status:** NOT DONE. The color values (`#22c55e` for success, `#ef4444` for error, `#f59e0b` for warning) are still hardcoded independently across cards. No shared palette constant exists.

### 6d. List/Divider Pattern (8 cards) — NOT DONE

CommitListCard, FileListCard, BranchListCard, CommitFilesCard, TypeCheckCard, CIStatusCard, FileSearchCard, and WebSearchCard all repeat the same `divide-y divide-push-edge` list markup.

**Status:** NOT DONE. No shared `CardList` or `CardListItem` component extracted. Each card still implements the pattern independently (~100 lines total across 8 cards).

### 6e. Code Block Pattern (4 cards) — NOT DONE

FileCard, SandboxCard, TestResultsCard, and CommitReviewCard duplicate the same `<pre><code>` block styling.

**Status:** NOT DONE. No shared `CardCodeBlock` component exists. `<pre>` styling is duplicated across cards (~40 lines total).

### 6f. Utility Duplication — DONE

~~`FileListCard` defines `formatSize(bytes)` and `SandboxDownloadCard` defines `formatBytes(bytes)` — nearly identical functions.~~

**Status:** DONE. Single `formatSize()` in `diff-utils.ts`, imported by both `FileListCard` and `SandboxDownloadCard`.

---

## 7. Standalone Getter + React Hook Pattern — N/A (Intentional)

Two hooks follow a "standalone getter for non-React code + React hook for UI" dual-export pattern:

| Hook | Getter | React hook |
|------|--------|------------|
| `useUserProfile.ts` | `getUserProfile()` | `useUserProfile()` |
| `useProtectMain.ts` | `getIsMainProtected()` | `useProtectMain()` |

This is a deliberate design pattern (documented in CLAUDE.md) for hooks whose state needs to be read from library code (like orchestrator.ts) that can't call React hooks. The config hooks use `createApiKeyGetter()` for the same purpose.

**Status:** DONE (N/A). Consistent and intentional. No consolidation needed.

---

## 8. `getActiveProvider()` — Linear Scan — NOT DONE

`getActiveProvider()` still checks each provider in a linear if-chain. `getProviderStreamFn()` is still a switch statement.

```typescript
if (preferred === 'ollama' && hasOllama) return 'ollama';
if (preferred === 'moonshot' && hasKimi) return 'moonshot';
if (preferred === 'mistral' && hasMistral) return 'mistral';
if (preferred === 'zai' && hasZai) return 'zai';
if (preferred === 'minimax' && hasMiniMax) return 'minimax';
if (preferred === 'openrouter' && hasOpenRouter) return 'openrouter';
```

**Status:** NOT DONE. Each new provider still requires adding a line in `getActiveProvider()`, `getProviderStreamFn()`, the `PROVIDERS` array, and `getModelForRole()`. A registry/map pattern would make adding providers a single-point change.

---

## Summary — Consolidation Opportunity Map

**Audit date: 2026-02-19 — 10 of 14 areas fully consolidated (~75%).**

| Area | Severity | Lines Affected | Status |
|------|----------|----------------|--------|
| Config hooks (useApiKeyConfig) | — | ~120 | **DONE** |
| Model name storage (createModelNameStorage) | — | ~30 | **DONE** |
| Tool detection (detectToolFromText) | — | ~100 | **DONE** |
| Stream timeout (streamWithTimeout) | — | ~60 | **DONE** |
| Web search execution (3 functions) | ~~High~~ | ~150 | **DONE** — `executeWebSearchCore()` |
| Diff parsing (3 locations) | ~~Medium~~ | ~50 | **DONE** — `diff-utils.ts` |
| Worker handler boilerplate | ~~High~~ | ~400–450 | **DONE** — `runPreamble()` + `createStreamProxyHandler()` + `createJsonProxyHandler()` |
| Orchestrator stream wrappers | ~~Medium~~ | ~300 | **DONE** — `PROVIDER_STREAM_CONFIGS` registry + `buildErrorMessages()` factory |
| Settings UI key sections | ~~Medium~~ | ~240 | **DONE** — shared `ProviderKeySection` component |
| `formatSize`/`formatBytes` | ~~Low~~ | ~20 | **DONE** — single `formatSize()` in `diff-utils.ts` |
| Card status badge colors | Low | ~60 | NOT DONE — no shared palette |
| Card list/divider pattern | Low | ~100 | NOT DONE — repeated structural pattern |
| Card code block pattern | Low | ~40 | NOT DONE — repeated structural pattern |
| Provider registration (multi-point) | Low | ~30 | NOT DONE — linear chains in 4 places |

### Remaining duplication (~230 lines, all low-severity)

1. **Card status badge colors** (~60 lines) — 6 cards hardcode `#22c55e`/`#ef4444`/`#f59e0b` independently
2. **Card list/divider pattern** (~100 lines) — 8 cards repeat `divide-y divide-push-edge` + item markup
3. **Card code block pattern** (~40 lines) — 4 cards duplicate `<pre><code>` styling
4. **Provider registration** (~30 lines) — `getActiveProvider()` + `getProviderStreamFn()` + `getModelForRole()` are linear chains
