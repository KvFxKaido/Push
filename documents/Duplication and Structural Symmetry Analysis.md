# Duplication and Structural Symmetry Analysis

Analysis of repeated patterns, structural symmetry, and consolidation opportunities across the Push codebase. This document is observational — no behavior changes proposed.

---

## 1. Provider Axis — The Six-Way Symmetry

The codebase is organized around six AI providers (Kimi/Moonshot, Ollama, Mistral, Z.ai, MiniMax, OpenRouter). Each provider requires identical plumbing at every layer. This creates a **six-way structural symmetry** that repeats across files:

### 1a. Config Hooks (already consolidated)

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

**Status:** Well-factored. The `useApiKeyConfig.ts` factory eliminated the duplication. Each hook is a 12–20 line thin wrapper.

### 1b. Provider Config — `providers.ts`

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

### 1c. Orchestrator Streaming — `orchestrator.ts`

Six `stream*Chat` functions share identical signatures (11 parameters) and the same body structure:

```
1. Get API key  →  guard on missing
2. (Optional provider-specific setup)
3. Call streamSSEChat() with a provider config object
```

The config objects differ in: `name`, `apiUrl`, `apiKey`, `model`, timeout values, `errorMessages` (string templates with provider name substituted), and optional `bodyTransform`. The function bodies are 30–50 lines each, nearly identical except for the provider name in strings.

**Already partially consolidated:** All six delegate to the shared `streamSSEChat()` engine. What remains duplicated is the per-provider wrapper function (~300 lines total for six wrappers).

**Structural symmetry:** Each error message set follows the same shape:
```typescript
errorMessages: {
  keyMissing: '<Name> API key not configured',
  connect: (s) => `<Name> API didn't respond within ${s}s ...`,
  idle: (s) => `<Name> API stream stalled — no data for ${s}s.`,
  stall: (s) => `<Name> API stream stalled — receiving data but no content for ${s}s. ...`,
  total: (s) => `<Name> API response exceeded ${s}s total time limit.`,
  network: 'Cannot reach <Name> — network error. Check your connection.',
}
```

Only the provider name varies. A factory function taking just the provider name and timeout overrides could eliminate all six copies.

### 1d. Worker Proxy — `worker.ts`

The Cloudflare Worker repeats the same handler skeleton 15+ times across provider endpoints. Every handler function has:

```
1. Origin validation    (~3 lines, 16 occurrences)
2. Rate limiting        (~6 lines, 15 occurrences)
3. Auth header build    (~8 lines, 12 occurrences)
4. Body reading         (~3 lines, 13 occurrences)
5. Timeout + fetch      (~10 lines, 15 occurrences)
6. Upstream error       (~4 lines, 15 occurrences)
7. SSE response headers (~5 lines, 7 occurrences)
8. Exception catch      (~6 lines, 13 occurrences)
```

**Estimated duplicated lines: ~400–450** out of ~2164 lines (~20% of the file).

**Specific inconsistencies found:**
- Z.ai and MiniMax SSE responses preserve upstream `Content-Type` and add `X-Accel-Buffering`; other providers hardcode `text/event-stream`. No documented reason for the difference.
- Z.ai and MiniMax handle `clearTimeout` in catch blocks; others use finally. Subtle behavioral inconsistency.

### 1e. Settings UI — `SettingsSheet.tsx`

Each provider's API key section repeats the same UI block (~40 lines per provider):

```
1. Label
2. If key saved: "Key Saved" badge + trash icon + (optional model selector + refresh)
3. If no key: password input + Enter handler + Save button + hint text
```

The input/save/clear pattern is copied six times with only the provider name and prop names changing. Providers with model selection (Ollama, Mistral, Z.ai, MiniMax, OpenRouter) additionally duplicate a model-select dropdown + refresh button block.

---

## 2. Tool Protocol — Detection/Execution Symmetry

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

**Status:** The `detectToolFromText<T>()` generic in `utils.ts` already eliminates the JSON-extraction duplication. Each tool module provides only its validator function. This layer is well-factored.

The validation functions themselves (e.g., `isScratchpadTool`, `isWebSearchTool`, `validateSandboxToolCall`, `validateToolCall`) use slightly different validation styles — some use type guards, some use `asRecord()`. Harmonizing these would be a minor consistency improvement.

---

## 3. Web Search Execution — Triple Duplication

Three functions in `web-search-tools.ts` are near-identical:

| Function | URL | Auth | Lines |
|----------|-----|------|-------|
| `executeOllamaWebSearch` | `OLLAMA_SEARCH_URL` | Bearer (Ollama key) | 105–153 |
| `executeFreeWebSearch` | `FREE_SEARCH_URL` | None | 167–206 |
| `executeTavilySearch` | `TAVILY_SEARCH_URL` | Bearer (Tavily key) | 222–269 |

Shared code (copied three times):
- `fetch()` with POST + JSON body
- `!response.ok` error handling with `errBody.slice(0, 200)`
- Response parsing as `{ results?: WebSearchResult[] }`
- Empty-results check
- Result formatting (map with title/url/snippet)
- Card data construction
- Error catch with `err instanceof Error ? err.message : String(err)`

Only three things differ: the URL, the authorization header, and the "key not configured" guard.

A shared `executeWebSearchCore(url, query, headers?)` would reduce ~150 lines to ~50.

---

## 4. Diff Parsing — Triple Duplication

Three functions across three files parse unified diffs with the same loop:

| Function | File | Returns |
|----------|------|---------|
| `parseDiffStats()` | `sandbox-tools.ts:350–367` | `{ filesChanged, additions, deletions }` |
| `parseDiffFileCount()` | `auditor-agent.ts:45–54` | `number` (file count only) |
| inline in `fetchSandboxStateSummary()` | `coder-agent.ts:184–193` | builds summary string |

All three iterate `diff.split('\n')` looking for:
- `diff --git` lines → extract file name via `/b\/(.+)$/`
- `+` lines (not `+++`) → count additions
- `-` lines (not `---`) → count deletions

A shared `parseDiffStats(diff)` in `diff-utils.ts` (which already exists but doesn't contain this) would serve all three callers.

---

## 5. Agent Module Symmetry — Coder vs Auditor

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

The `streamWithTimeout` utility (in `utils.ts`) already consolidated what was previously duplicated. The remaining setup boilerplate (provider check → streamFn → model lookup) is ~10 lines per agent and not worth abstracting further.

---

## 6. Card Components — Structural Patterns

27 card components share significant structural repetition:

### 6a. Shell + Header (100% of cards)

Every card wraps in `CARD_SHELL_CLASS` and uses a header with:
```tsx
<div className="px-3.5 py-3 flex items-center gap-2.5">
  <Icon className="h-4 w-4 shrink-0 text-push-fg-secondary" />
  <span className="text-[13px] font-medium">...</span>
</div>
```

### 6b. Expandable Pattern (5 cards)

PRCard, SandboxCard, DiffPreviewCard, FileCard, and EditorCard all repeat:
```tsx
const { expanded, toggleExpanded } = useExpandable(defaultValue);
// Header with ExpandChevron + onClick={toggleExpanded}
// ExpandableCardPanel with expanded={expanded}
```

The `expandable.tsx` helper provides `ExpandChevron` and `ExpandableCardPanel`, but each card still wires the pattern manually.

### 6c. Status Badge (6 cards)

PRCard, AuditVerdictCard, SandboxCard, TestResultsCard, TypeCheckCard, and CIStatusCard each define independent status-to-color config objects:
```typescript
const statusConfig = {
  state1: { label: '...', color: 'bg-[#22c55e]/15 text-[#22c55e]' },
  state2: { label: '...', color: 'bg-[#ef4444]/15 text-[#ef4444]' },
};
```

The color values (`#22c55e` for success, `#ef4444` for error, `#f59e0b` for warning) are hardcoded identically across cards with no shared palette constant.

### 6d. List/Divider Pattern (8 cards)

CommitListCard, FileListCard, BranchListCard, CommitFilesCard, TypeCheckCard, CIStatusCard, FileSearchCard, and WebSearchCard all use:
```tsx
<div className="divide-y divide-push-edge">
  {items.map((item) => (
    <div className="px-3 py-1.5 flex items-center gap-2">
      <Icon className="h-3.5 w-3.5" />
      <span className="text-[13px] text-[#e4e4e7] truncate">...</span>
    </div>
  ))}
</div>
```

### 6e. Code Block Pattern (4 cards)

FileCard, SandboxCard, TestResultsCard, and CommitReviewCard duplicate:
```tsx
<pre className="px-3 py-2 overflow-x-auto ...">
  <code className="font-mono text-[12px] text-push-fg-secondary leading-relaxed whitespace-pre-wrap break-all">
    {content}
  </code>
</pre>
```

### 6f. Utility Duplication

`FileListCard` defines `formatSize(bytes)` and `SandboxDownloadCard` defines `formatBytes(bytes)` — nearly identical functions.

---

## 7. Standalone Getter + React Hook Pattern

Two hooks follow a "standalone getter for non-React code + React hook for UI" dual-export pattern:

| Hook | Getter | React hook |
|------|--------|------------|
| `useUserProfile.ts` | `getUserProfile()` | `useUserProfile()` |
| `useProtectMain.ts` | `getIsMainProtected()` | `useProtectMain()` |

This is a deliberate design pattern (documented in CLAUDE.md) for hooks whose state needs to be read from library code (like orchestrator.ts) that can't call React hooks. The config hooks use `createApiKeyGetter()` for the same purpose.

**Status:** Consistent and intentional. No consolidation needed.

---

## 8. `getActiveProvider()` — Linear Scan

`orchestrator.ts:1603–1628` checks each provider in sequence:

```typescript
if (preferred === 'ollama' && hasOllama) return 'ollama';
if (preferred === 'moonshot' && hasKimi) return 'moonshot';
if (preferred === 'mistral' && hasMistral) return 'mistral';
if (preferred === 'zai' && hasZai) return 'zai';
if (preferred === 'minimax' && hasMiniMax) return 'minimax';
if (preferred === 'openrouter' && hasOpenRouter) return 'openrouter';
```

Each new provider requires adding a line here, in `getProviderStreamFn()`, in the `PROVIDERS` array, and in `getModelForRole()`. A registry/map pattern would make adding providers a single-point change.

---

## Summary — Consolidation Opportunity Map

| Area | Severity | Lines Affected | Status |
|------|----------|----------------|--------|
| Config hooks (useApiKeyConfig) | — | ~120 | **Already consolidated** |
| Model name storage (createModelNameStorage) | — | ~30 | **Already consolidated** |
| Tool detection (detectToolFromText) | — | ~100 | **Already consolidated** |
| Stream timeout (streamWithTimeout) | — | ~60 | **Already consolidated** |
| Web search execution (3 functions) | High | ~150 | Duplicated |
| Diff parsing (3 locations) | Medium | ~50 | Duplicated |
| Worker handler boilerplate | High | ~400–450 | Duplicated |
| Orchestrator stream wrappers | Medium | ~300 | Partially consolidated (config objects vary) |
| Settings UI key sections | Medium | ~240 | Duplicated |
| Card status badge colors | Low | ~60 | Duplicated (no shared palette) |
| Card list/divider pattern | Low | ~100 | Repeated structural pattern |
| Card code block pattern | Low | ~40 | Repeated structural pattern |
| `formatSize`/`formatBytes` | Low | ~20 | Duplicated utility |
| Provider registration (multi-point) | Low | ~30 | Linear chains in 4 places |
