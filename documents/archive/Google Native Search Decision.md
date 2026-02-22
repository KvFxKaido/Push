# Google Native Search Grounding — Decision Record

## Date
2026-02-22

## Decision
**Not pursuing.** Google stays on the OpenAI-compatible endpoint. Tavily remains the web search backend for all providers.

## Context

Google's Gemini API supports native Google Search grounding via `tools: [{ google_search: {} }]` on the direct Gemini endpoint (`streamGenerateContent`). This would bypass Push's Tavily/DuckDuckGo web search and use Google's own search infrastructure, potentially delivering higher-quality grounded results with citation metadata.

Push currently routes Google through their OpenAI-compatible endpoint (`/v1beta/openai/chat/completions`), which shares the same SSE parser as every other provider. Native grounding is not available through this compatibility layer.

## Why Not

### 1. Unverified premise
The assumption that Google native grounding would be "materially better" than Tavily for Push's use cases was never tested. The kinds of queries Push users make (library docs, error messages, API references) may not benefit meaningfully from Google's search vs. Tavily's LLM-optimized results.

### 2. Breaks the single-parser invariant
All six providers currently converge to one OpenAI-compatible SSE format before hitting the orchestrator's stream parser. A Gemini-native path requires a second parser for a completely different SSE shape (`candidates[0].content.parts[0].text` vs. `choices[0].delta.content`). This doubles the streaming surface area — timeouts, stall detection, think-token parsing, and chunked emission all need parallel implementations or a shared abstraction that doesn't exist.

### 3. "Phase 1 MVP" wasn't minimal
The proposed minimal implementation required: new Worker route, new streaming function, new message format transformer, new SSE parser, Settings toggle, fallback logic, and conditional schema suppression. Seven new components for a feature with unverified value.

### 4. Maintenance burden of a Settings toggle
A toggle that "defaults off" tends to live forever. Two active code paths for one provider's web search is ongoing maintenance cost.

### 5. Misaligned with current priorities
Harness reliability is the active focus. A new streaming parser is model churn, not harness improvement.

## Alternative Considered

**Worker-side translation:** The Cloudflare Worker could accept OpenAI-shaped requests, translate to Gemini native format, proxy, and translate responses back to OpenAI SSE. This would preserve the single-parser invariant on the client. Rejected as unnecessary given the unverified premise, but noted as the right approach if this is ever revisited.

## What Would Change This

- Evidence that Tavily quality is insufficient for common Push queries
- Google adding native search grounding to their OpenAI-compatible endpoint (eliminating the need for a second parser)
- A broader move to Gemini-native function calling (which would justify the parser investment for more than just search)
