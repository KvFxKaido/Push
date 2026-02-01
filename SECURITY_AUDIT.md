# Security Audit Report

Date: February 1, 2026
Scope: `app/worker.ts`, `app/src/hooks/useGitHubAuth.ts`, `app/src/hooks/useChat.ts`, `app/src/lib/orchestrator.ts`, `app/src/lib/github-tools.ts`, `app/src/lib/ollama.ts`, `app/src/components/chat/MessageBubble.tsx`, `app/src/sections/OnboardingScreen.tsx`, `app/src/App.tsx`, `app/src/hooks/useRepos.ts`, `app/src/hooks/useActiveRepo.ts`, `.env` (not present), `.gitignore`.

## Findings

### 1) Unauthenticated Ollama proxy enables open, unmetered use
- Severity: HIGH
- File and line: `app/worker.ts:17`, `app/worker.ts:28`, `app/worker.ts:46`
- Description: The Cloudflare Worker accepts any POST to `/api/chat` and forwards the request body directly to `https://ollama.com/api/chat` with the server-side API key. There is no authentication, origin check, or user identity verification. Any client (including non-browser clients) can use this endpoint to consume your Ollama Cloud quota using your key.
- Recommendation: Require authentication (e.g., signed session/JWT), restrict allowed origins, and enforce per-user rate limits/quotas at the Worker. Consider a strict allowlist of models and request fields.

### 2) No request-size/shape limits on `/api/chat`
- Severity: MEDIUM
- File and line: `app/worker.ts:37`, `app/worker.ts:54`
- Description: The Worker parses and forwards the entire JSON body with no size limit, schema validation, or timeout. This allows large payloads or abusive parameters to increase costs or trigger resource exhaustion.
- Recommendation: Enforce a maximum request size, validate the request schema, and set upstream timeouts. Reject unknown fields and overly long message arrays.

### 3) Client-side secret exposure via `VITE_*` env variables
- Severity: MEDIUM
- File and line: `app/src/lib/orchestrator.ts:4`, `app/src/lib/orchestrator.ts:100`, `app/src/lib/ollama.ts:4`, `app/src/lib/ollama.ts:29`, `app/src/hooks/useGitHubAuth.ts:9`, `app/src/hooks/useRepos.ts:4`, `app/src/lib/github-tools.ts:10`
- Description: The code reads `VITE_OLLAMA_CLOUD_API_KEY` and `VITE_GITHUB_TOKEN` directly in client bundles. Any `VITE_*` variable is embedded into the built JavaScript and is visible to end users. If these are set in production, the secrets are exposed.
- Recommendation: Remove secret usage from client code. Store secrets only server-side (Worker) and proxy requests; if needed for dev, use non-`VITE_` vars and inject only in local dev tooling, never in production builds.

### 4) Tool calls execute without user confirmation or repo scoping
- Severity: HIGH
- File and line: `app/src/lib/github-tools.ts:41`, `app/src/lib/github-tools.ts:86`, `app/src/hooks/useChat.ts:348`, `app/src/hooks/useChat.ts:394`
- Description: Any JSON tool block in the assistant response triggers `executeToolCall`, and the tool args can target any `owner/repo`. There is no enforcement that the repo matches the active repo or that the user explicitly approved the action. A prompt-injected response can therefore read PR data from any repo accessible by the user’s token.
- Recommendation: Require explicit user confirmation before executing tools; enforce a strict allowlist (active repo only) and validate tool calls against UI-selected context. Prefer structured tool-call channels rather than regex scraping.

### 5) Untrusted tool results are injected as `user` messages
- Severity: MEDIUM
- File and line: `app/src/hooks/useChat.ts:401`, `app/src/hooks/useChat.ts:420`
- Description: GitHub tool results (including PR bodies and diffs) are inserted into the conversation as `role: 'user'`. This lets untrusted repo content act as “user instructions,” increasing prompt-injection risk and potentially chaining additional tool calls.
- Recommendation: Use a dedicated tool/result role (or metadata) and wrap tool output in a clearly delimited, non-executable format. Add system instructions to ignore tool output as instructions.

### 6) GitHub PAT stored in `localStorage`
- Severity: MEDIUM
- File and line: `app/src/hooks/useGitHubAuth.ts:4`, `app/src/hooks/useGitHubAuth.ts:40`, `app/src/hooks/useGitHubAuth.ts:75`, `app/src/hooks/useGitHubAuth.ts:108`, `app/src/lib/github-tools.ts:20`, `app/src/hooks/useRepos.ts:9`
- Description: The GitHub token is persisted in `localStorage`, which is accessible to any JavaScript running on the origin. Any XSS or malicious browser extension can exfiltrate the PAT.
- Recommendation: Prefer OAuth with a backend session and HttpOnly cookies. If client-only is required, keep tokens in memory or `sessionStorage`, and offer a “clear on close” option.

### 7) Sensitive chat history persists after disconnect
- Severity: LOW
- File and line: `app/src/hooks/useChat.ts:23`, `app/src/hooks/useChat.ts:32`, `app/src/App.tsx:92`
- Description: Chat transcripts (including tool results that may contain PR diffs) are stored in `localStorage` and are not cleared on disconnect. If a user signs out and another user uses the same device, the previous chat history remains accessible.
- Recommendation: Clear chat storage on logout, or provide an explicit “clear chats on disconnect” option.

### 8) Partial token is displayed in Settings
- Severity: LOW
- File and line: `app/src/App.tsx:262`
- Description: The UI reveals the first 8 characters of the GitHub token. This can leak sensitive data during screen sharing or shoulder surfing.
- Recommendation: Remove token display entirely or hide it behind a user action (e.g., “reveal” with confirmation).

## Notes
- `.env` was not present in the repo root. `.gitignore` correctly ignores `.env` and `.env.*` files (`.gitignore:8`).
