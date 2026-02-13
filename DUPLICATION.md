# Duplication & Structural Symmetry Analysis

Audit of repeated code patterns and structural symmetry across the Push codebase.
No behavior changes proposed — this document maps what exists.

---

## 1. API Key / Config Hooks (5 files, highest duplication)

Five hooks share the same skeleton: a standalone getter (localStorage → env var fallback) and a React hook that wraps `useState` + `useCallback` for set/clear/hasKey.

| Hook | File | Extra state |
|------|------|-------------|
| `useMoonshotKey` | `hooks/useMoonshotKey.ts` | — |
| `useTavilyConfig` | `hooks/useTavilyConfig.ts` | — |
| `useOllamaConfig` | `hooks/useOllamaConfig.ts` | `model` |
| `useMistralConfig` | `hooks/useMistralConfig.ts` | `model` |
| `useZaiConfig` | `hooks/useZaiConfig.ts` | `model` |

**What is identical across all five:**

```ts
export function getXxxKey(): string | null {
  const stored = safeStorageGet(KEY_STORAGE);
  if (stored) return stored;
  return import.meta.env.VITE_XXX_API_KEY || null;
}

const setKey = useCallback((newKey: string) => {
  const trimmed = newKey.trim();
  if (!trimmed) return;
  safeStorageSet(KEY_STORAGE, trimmed);
  setKeyState(trimmed);
}, []);

const clearKey = useCallback(() => {
  safeStorageRemove(KEY_STORAGE);
  setKeyState(import.meta.env.VITE_XXX_API_KEY || null);
}, []);
```

**What varies:** storage key string, env var name, whether a `model` field exists, default model constant.

The three model-bearing hooks (`useOllamaConfig`, `useMistralConfig`, `useZaiConfig`) are character-for-character identical except for the storage keys and default model import.

---

## 2. Provider Model Getter/Setter in `providers.ts` (3 blocks)

`lib/providers.ts:181–219` contains three structurally identical blocks:

```ts
const XXX_MODEL_KEY = 'xxx_model';

export function getXxxModelName(): string {
  return safeStorageGet(XXX_MODEL_KEY) || XXX_DEFAULT_MODEL;
}

export function setXxxModelName(model: string): void {
  safeStorageSet(XXX_MODEL_KEY, model.trim());
}
```

Repeated for Ollama, Mistral, and Z.ai. The only behavioral difference is that `setMistralModelName` also calls `resetMistralAgent()`.

---

## 3. `asRecord()` — 6 copies of the same 3-line function

Defined independently in six lib files:

| File | Line |
|------|------|
| `lib/github-tools.ts` | 42 |
| `lib/sandbox-tools.ts` | 191 |
| `lib/auditor-agent.ts` | 19 |
| `lib/model-catalog.ts` | 12 |
| `lib/orchestrator.ts` | 29 |
| `lib/tool-dispatch.ts` | 29 |

All are identical:

```ts
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}
```

---

## 4. Fenced-JSON Tool Detection — 7 instances of the same regex loop

The pattern `const fenceRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g` followed by a `while ((match = fenceRegex.exec(text)))` loop appears in:

| File | Line | Detection function |
|------|------|--------------------|
| `lib/github-tools.ts` | 335 | `detectToolCall` |
| `lib/sandbox-tools.ts` | 301 | `detectSandboxToolCalls` |
| `lib/sandbox-tools.ts` | 329 | `detectSandboxToolCall` |
| `lib/scratchpad-tools.ts` | 63 | `detectScratchpadToolCall` |
| `lib/web-search-tools.ts` | 70 | `detectWebSearchToolCall` |
| `lib/coder-agent.ts` | 63 | `detectCoderToolCall` |
| `lib/tool-dispatch.ts` | 220 | `detectAnyToolCall` |

Each one: creates the regex, loops over matches, tries `JSON.parse`, validates with a tool-specific predicate, and falls back to `extractBareToolJsonObjects`. The detection shape is identical — only the validation predicate differs.

---

## 5. Agent Streaming Timeout — 3 instances of the settled-promise pattern

`auditor-agent.ts:97`, `coder-agent.ts:161`, and `coder-agent.ts:343` all use:

```ts
let accumulated = '';
const streamError = await new Promise<Error | null>((resolve) => {
  let settled = false;
  const settle = (v: Error | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(v);
  };
  const timer = setTimeout(() => settle(new Error('...')), TIMEOUT_MS);
  streamFn(messages, (token) => { accumulated += token; }, () => settle(null), (err) => settle(err));
});
```

Differences: timeout duration (60s auditor, 180s coder), error message text, extra arguments to `streamFn`.

---

## 6. `timeAgo()` — 7 copies across components

| File | Line | Input type |
|------|------|------------|
| `components/cards/PRListCard.tsx` | 4 | `string` |
| `components/cards/CommitListCard.tsx` | 4 | `string` |
| `components/cards/CommitFilesCard.tsx` | 4 | `string` |
| `components/cards/WorkflowRunsCard.tsx` | 58 | `string` |
| `sections/RepoPicker.tsx` | 34 | `string` |
| `components/chat/RepoChatDrawer.tsx` | 61 | `number` |
| `components/chat/hub-tabs/HubChatsTab.tsx` | 19 | `number` |

Five accept `string` (ISO date), two accept `number` (epoch ms). The body is the same seconds→minutes→hours→days cascade.

---

## 7. `isNetworkFetchError()` — 2 copies in auth hooks

Identical function in `hooks/useGitHubAuth.ts:25` and `hooks/useGitHubAppAuth.ts:41`:

```ts
function isNetworkFetchError(err: unknown): boolean {
  return err instanceof TypeError && /failed to fetch|networkerror|load failed/i.test(err.message);
}
```

---

## 8. `validateToken()` — 2 copies in auth hooks

Identical `async function validateToken` in `hooks/useGitHubAuth.ts:29` and `hooks/useGitHubAppAuth.ts:166`. Both call `GET /user` with a Bearer token and return `{ login, avatar_url } | null`.

---

## 9. Card Shell — 21 of 23 cards share the same outer div

```tsx
<div className="my-2.5 max-w-full overflow-hidden rounded-xl border border-push-edge bg-push-grad-card shadow-push-card">
```

This class string is repeated verbatim in 21 card files under `components/cards/`.

---

## 10. Expandable Card Pattern — 8 cards

Eight cards independently implement the same expand/collapse UI:

```tsx
const [expanded, setExpanded] = useState(false);

<button onClick={() => setExpanded(e => !e)} className="w-full ...">
  <ChevronRight className={`... ${expanded ? 'rotate-90' : ''}`} />
</button>
{expanded && <div className="border-t border-push-edge expand-in">...</div>}
```

Files: `FileCard`, `SandboxCard`, `DiffPreviewCard`, `PRCard`, `EditorCard`, `WorkflowLogsCard`, `CIStatusCard`, `FileSearchCard`.

---

## 11. CI/Workflow Status Helpers — 3 cards

`CIStatusCard`, `WorkflowRunsCard`, and `WorkflowLogsCard` each define their own `checkIcon(status, conclusion)` and `headerBg(status)` / `headerColor(status)` mappers with the same success/failure/pending/cancelled logic.

---

## Summary

| Pattern | Instances | Spread across |
|---------|-----------|---------------|
| API key hook skeleton | 5 | `hooks/use*Config.ts`, `hooks/useMoonshotKey.ts` |
| Provider model get/set | 3 | `lib/providers.ts` |
| `asRecord()` | 6 | `lib/*.ts` |
| Fenced-JSON detection loop | 7 | `lib/*-tools.ts`, `lib/coder-agent.ts`, `lib/tool-dispatch.ts` |
| Streaming timeout promise | 3 | `lib/auditor-agent.ts`, `lib/coder-agent.ts` |
| `timeAgo()` | 7 | `components/cards/*.tsx`, `sections/`, `components/chat/` |
| `isNetworkFetchError()` | 2 | `hooks/useGitHub*.ts` |
| `validateToken()` | 2 | `hooks/useGitHub*.ts` |
| Card shell class string | 21 | `components/cards/*.tsx` |
| Expand/collapse UI | 8 | `components/cards/*.tsx` |
| CI status icon/color mappers | 3 | `components/cards/CI*.tsx`, `Workflow*.tsx` |
