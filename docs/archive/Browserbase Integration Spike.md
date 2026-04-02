# Browserbase Integration Spike (Push)

## Status
- Last updated: 2026-02-08
- State: v1 complete — deployed and validated
- Source of truth: This document

## Completed
- Browser screenshot tool shipped end-to-end:
  - Tool: `sandbox_browser_screenshot(url, fullPage?)`
  - Worker route: `/api/sandbox/browser-screenshot`
  - Modal endpoint: `browser_screenshot`
  - UI card: `BrowserScreenshotCard` — image preview + URL/title/status
  - Mobile-first viewport: 390×844 (iPhone 14 Pro)
  - PNG default, auto-fallback to JPEG quality=60 if >1.5 MB
- Browser extract tool shipped end-to-end:
  - Tool: `sandbox_browser_extract(url, instruction?)`
  - Worker route: `/api/sandbox/browser-extract`
  - Modal endpoint: `browser_extract`
  - UI card: `BrowserExtractCard` — scrollable `<pre>` block + metadata
  - Desktop viewport: 1280×720 (better text rendering)
  - Extracts `body.innerText` by default; CSS selector via `instruction` ("selector: .foo")
  - Truncates at 20,000 chars
- Browserbase credentials plumbed through Worker to sandbox endpoints (server-side injection, never touches client).
- Modal endpoint budget issue resolved by consolidating file ops:
  - `read/write/list/delete` now map to a single `file-ops` endpoint.
- Browser guardrails implemented:
  - URL scheme allowlist (`http`/`https`)
  - localhost/private network blocking (`_is_blocked_browser_target` — covers private IPs, link-local, multicast, reserved ranges)
  - Screenshot size cap: 1.5 MB (PNG → JPEG fallback)
  - Extract text cap: 20,000 chars
- Feature flag gating (`VITE_BROWSER_TOOL_ENABLED`):
  - Guards tool validation, execution, system prompt inclusion, and intent hints
  - Default: off (explicit opt-in)
- Browser intent detection and tool-choice hinting:
  - `isBrowserIntentPrompt()` in useChat — heuristic URL + keyword detection
  - `withBrowserToolHint()` — injects hidden guidance to prefer `sandbox_browser_*` over curl/python
  - Browser keywords added to sandbox prewarm intent regex
- Chat UX stability fixes:
  - Filtered empty assistant messages before provider send
  - Removed sandbox-state chat card noise
  - Fixed duplicate screenshot card rendering
- Retry logic with exponential backoff (2s, 4s, 8s, 16s — max 4 retries) for both browser operations via `withRetry` in sandbox-client.
- Ephemeral Browserbase sessions: one session per request, always cleaned up in `finally` block.
- End-to-end validated with real Browserbase credentials on deployed Worker + Modal.
- Local dev ergonomics: `.env` setup for `VITE_BROWSER_TOOL_ENABLED`, Vite proxy config, and Worker secrets workflow.
- Error taxonomy for browser tool failures:
  - `BrowserToolError` type (`{ code, message }`) added as optional field on both card data types
  - `BROWSER_ERROR_MESSAGES` map in sandbox-tools.ts covers all Modal error codes + unknowns
  - Both card components render calm error states (AlertTriangle in muted gray, not red)
  - Backwards compatible — existing card data without `error` renders normally
- Lightweight observability for browser operations:
  - `browser-metrics.ts` module: in-memory counters for count, latency (min/max/total), errors by code, retries
  - `withRetry` extended with `onRetries` callback to surface retry count (backwards compatible)
  - `console.debug` logging: `[browser] screenshot ok 1823ms retries=0`
  - Metrics shape supports future export to `/api/metrics` endpoint
- Automated test suite (97 tests, 4 files, vitest):
  - `sandbox-tools.test.ts` (48 tests): tool validation, detection/parsing, execution for both browser tools
  - `sandbox-client.test.ts` (14 tests): HTTP client functions, result type shapes
  - `worker-routes.test.ts` (21 tests): route mapping, completeness, payload enrichment
  - `browser-card-types.test.ts` (14 tests): card data interface shapes, ChatCard union compatibility
  - Test infrastructure bootstrapped: vitest + config + `@/` path alias

## Remaining (v2 enhancements)
- Extraction quality: structured output modes (JSON extraction, table parsing), XPath support, multiple selector chaining.
- Session pooling investigation: current ephemeral-per-request model has cold-start latency; warm pool could reduce p50.

## Objective
Integrate Browserbase-powered browsing into Push without introducing a full MCP client stack in v1.

## Decision
Use Push-native tools (`sandbox_browser_*`) backed by Browserbase APIs/SDK through sandbox endpoints.

Why:
- Fastest path to value with current architecture.
- Preserves existing Orchestrator/Coder JSON tool loop.
- Avoids transport/protocol migration risk (MCP client, session multiplexing, tool/result bridging).

## Current State
- Push tooling is JSON prompt-tools + local dispatch (`app/src/lib/sandbox-tools.ts`).
- Worker proxies sandbox routes (`app/worker.ts`) including browser endpoints.
- Sandbox runs Modal endpoints (`sandbox/app.py`) with Browserbase-backed screenshot/extract endpoints.

## v1 Scope
Implemented browser tools:
- `sandbox_browser_screenshot(url, fullPage?)`
- `sandbox_browser_extract(url, instruction?)`

Success criteria:
- Agent can request screenshot and extraction of a public URL.
- Tool returns rendered cards with metadata and bounded payloads.
- Works on mobile clients over Wi-Fi and cellular.

Out of scope:
- Generic MCP transport support
- Multi-action sessions (click/type/observe loops)
- Arbitrary user-provided JS execution

## Architecture (implemented)
1. **Intent detection** (useChat.ts)
   - `isBrowserIntentPrompt()` checks for URL + browser keywords in user message.
   - Triggers sandbox prewarm and injects tool-choice hint into message context.
2. **Tool call** — Model emits JSON tool block:
   ```json
   { "tool": "sandbox_browser_screenshot", "args": { "url": "https://example.com", "fullPage": false } }
   ```
   ```json
   { "tool": "sandbox_browser_extract", "args": { "url": "https://example.com", "instruction": "selector: .main-content" } }
   ```
3. **Frontend dispatch** (sandbox-tools.ts)
   - Feature-flag check → URL validation → execute via sandbox-client.ts (90s timeout, exponential backoff retry).
4. **Worker proxy** (worker.ts)
   - Route map: `browser-screenshot` → Modal, `browser-extract` → Modal.
   - Injects `browserbase_api_key` + `browserbase_project_id` from Worker secrets.
5. **Modal endpoint** (sandbox/app.py)
   - Validates owner token, blocks private network targets.
   - Creates ephemeral Browserbase session via REST API.
   - Playwright connects over CDP, navigates, captures screenshot or extracts text.
   - Always cleans up session in `finally` block.
6. **UI cards** (components/cards/)
   - `BrowserScreenshotCard` — image preview + metadata.
   - `BrowserExtractCard` — scrollable text + metadata.
   - Both registered in `CardRenderer.tsx`.

## Browserbase Integration Modes
### Mode A (recommended): Direct Browserbase API from sandbox endpoint
- `sandbox/app.py` calls Browserbase using API key + project ID.
- Minimal moving parts for Push.

### Mode B: Run Browserbase MCP server and bridge it
- Push talks to MCP server, then maps MCP tools/results into Push tool loop.
- Better long-term standardization, higher integration complexity now.

For v1, use Mode A.

## Env + Secrets
### Cloudflare Worker secrets
- `BROWSERBASE_API_KEY`
- `BROWSERBASE_PROJECT_ID`

### Optional
- Region/session tuning secrets if needed by Browserbase plan.

### Data flow for secrets
- Worker receives browser tool request.
- Worker forwards only required fields to Modal endpoint.
- Modal endpoint should avoid logging sensitive values.

## API Contract (v1)
### Screenshot request (Worker → Modal)
```json
{
  "sandbox_id": "sb-...",
  "owner_token": "...",
  "url": "https://example.com",
  "full_page": false,
  "browserbase_api_key": "...",
  "browserbase_project_id": "..."
}
```

### Extract request (Worker → Modal)
```json
{
  "sandbox_id": "sb-...",
  "owner_token": "...",
  "url": "https://example.com",
  "instruction": "selector: .main-content",
  "browserbase_api_key": "...",
  "browserbase_project_id": "..."
}
```

### Screenshot response (Modal → Worker → App)
```json
{
  "ok": true,
  "title": "Example Domain",
  "final_url": "https://example.com/",
  "status_code": 200,
  "image_base64": "...",
  "mime_type": "image/png",
  "truncated": false
}
```

### Extract response (Modal → Worker → App)
```json
{
  "ok": true,
  "title": "Example Domain",
  "final_url": "https://example.com/",
  "status_code": 200,
  "content": "Example Domain ...",
  "truncated": false
}
```

### Error shape (shared)
```json
{
  "ok": false,
  "error": "NAVIGATION_TIMEOUT",
  "details": "Page did not load within timeout"
}
```

Known error codes: `NAVIGATION_TIMEOUT`, `INVALID_URL`, `IMAGE_TOO_LARGE`, `BLOCKED_TARGET`, `SESSION_CREATE_FAILED`.

## Guardrails (implemented)
- URL scheme allowlist: `http`, `https` only.
- Private network blocking via `_is_blocked_browser_target`: localhost, private IPs (10.x, 172.16-31.x, 192.168.x), link-local, multicast, reserved ranges.
- Navigation timeout: `domcontentloaded` event + 5s `networkidle` wait (with timeout fallback).
- Screenshot size cap: 1.5 MB PNG → auto-JPEG-fallback at quality=60.
- Extract text cap: 20,000 chars with `truncated` flag.
- Owner token validation on every browser request.
- Ephemeral Browserbase sessions — created per request, destroyed in `finally`.

## Mobile + Cellular Considerations
- Default viewport optimized for mobile preview.
- Non-full-page screenshot default.
- Retry/backoff in sandbox client for transient failures.
- Surface progress states to reduce perceived hanging.
- Keep response sizes conservative.

## Testing Plan
### Unit
- Tool parsing/validation for `sandbox_browser_screenshot`.
- Tool parsing/validation for `sandbox_browser_extract`.
- Worker route map includes browser endpoint.
- URL validation blocks disallowed targets.

### Integration
- Valid public URL returns image + metadata.
- Valid public URL returns extracted text + metadata.
- Timeout path returns `NAVIGATION_TIMEOUT`.
- Invalid URL returns `INVALID_URL`.
- Oversized image returns `IMAGE_TOO_LARGE`.

### Manual mobile smoke
- iOS Safari + Android Chrome on LTE/5G:
  - tool invocation
  - progress indication
  - image card rendering
  - retry behavior under flaky connection

## Risks and Mitigations
- **Vendor lock-in**: abstract browser provider behind one sandbox endpoint.
- **Cost drift**: add simple metrics and usage counters per screenshot.
- **Latency spikes**: cap timeout and expose “retry” UX.
- **Abuse potential**: keep strict URL and output limits.

## Delivery Plan
1. ~~Add feature flag: `browserToolEnabled`.~~ Done
2. ~~Implement screenshot endpoint + worker route + client + tool plumbing.~~ Done
3. ~~Implement extract endpoint + worker route + client + tool plumbing.~~ Done
4. ~~Add card rendering for both tools.~~ Done
5. ~~Add intent detection and tool-choice hinting.~~ Done
6. ~~Deploy Modal with `browser_extract` endpoint and configure Browserbase secrets on Worker.~~ Done
7. ~~End-to-end validation on deployed infra with real URLs.~~ Done
8. ~~Add automated tests (tool validation, URL blocking, route mapping).~~ Done — 97 tests across 4 files
9. ~~Add error taxonomy for browser tool failures.~~ Done — structured error states in cards
10. ~~Add observability hooks for browser operations.~~ Done — in-memory metrics + console.debug
11. Validate on real mobile cellular (iOS Safari + Android Chrome on LTE/5G).
12. Enable `VITE_BROWSER_TOOL_ENABLED` progressively after latency/error checks.

## File Manifest
All files touched by the Browserbase integration:

| File | Role |
|------|------|
| `app/src/lib/sandbox-tools.ts` | Tool definitions, validation, execution, error mapping, metrics recording |
| `app/src/lib/sandbox-client.ts` | HTTP client functions + result types + `onRetries` callback |
| `app/src/lib/browser-metrics.ts` | In-memory observability (latency, errors, retries) |
| `app/src/lib/feature-flags.ts` | `browserToolEnabled` flag |
| `app/src/hooks/useChat.ts` | Intent detection, tool-choice hinting, prewarm |
| `app/src/types/index.ts` | `BrowserScreenshotCardData`, `BrowserExtractCardData`, `BrowserToolError`, card union |
| `app/src/components/cards/BrowserScreenshotCard.tsx` | Screenshot card UI + error state |
| `app/src/components/cards/BrowserExtractCard.tsx` | Extract card UI + error state |
| `app/src/components/cards/CardRenderer.tsx` | Card type dispatch |
| `app/worker.ts` | Route mapping + Browserbase secret injection |
| `sandbox/app.py` | Modal endpoints + Browserbase session lifecycle + security |
| `app/vitest.config.ts` | Test runner config |
| `app/src/lib/sandbox-tools.test.ts` | Tool validation + execution tests (48) |
| `app/src/lib/sandbox-client.test.ts` | Client function + type shape tests (14) |
| `app/src/lib/worker-routes.test.ts` | Route mapping + payload enrichment tests (21) |
| `app/src/types/browser-card-types.test.ts` | Card data interface shape tests (14) |

## Notes
- If we later want broad MCP interoperability, we can add an MCP bridge as v2 without rewriting v1 tool UX.
- CSS selector extraction is the simplest structured mode. XPath, multi-selector, and JSON extraction are natural v2 extensions.
- Session pooling (warm Browserbase sessions) could reduce p50 latency but adds session management complexity — worth measuring cold-start impact first.
- The `instruction` parameter on extract is intentionally loose — it can evolve to support richer directives without schema changes.
