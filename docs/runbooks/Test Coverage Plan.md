# Test Coverage Plan

Status: Current (Phases 1–5 shipped 2026-04-17). Added 2026-04-17.

Drives the post-audit push to close the biggest coverage gaps in Push. The
baseline audit ran against commit `2cff2bb` and found ~142 test files for
~459 source files (~31% ratio) — coverage is concentrated in agent logic but
thin on infrastructure, UI, workers, and the MCP server.

Phases are ordered by risk (security/blast radius first) rather than size.
Each phase lists the target files and the acceptance bar for "done" so the
plan stays self-auditing.

## Phase 1 — Security-critical surface (shipped 2026-04-17)

Landed in PR #309 (120 new tests) and PR #310 (regex bug surfaced by the new
tests).

- `app/src/lib/github-auth.test.ts` — token precedence (app > oauth > env)
  and header shape. Deterministic under a stubbed `VITE_GITHUB_TOKEN`.
- `app/src/lib/approval-gates.test.ts` — registry semantics and all four
  default gates across all three approval modes. Catches regex regressions
  via parameterized positive/negative cases.
- `app/src/worker/worker-middleware.test.ts` — origin allowlist, body-size
  limits, client-IP derivation, auth builders, experimental upstream URL
  validation, and the full `runPreamble` guard chain.
- `mcp/github-server/src/sensitive-data-guard.test.ts` — first tests in the
  MCP package; added the `test` / `test:mcp:github` scripts and excluded
  `*.test.ts` from the MCP tsc build.
- `app/src/lib/approval-gates.ts` (PR #310) — repaired two dead
  `DESTRUCTIVE_PATTERNS` regexes and closed a shell-separator bypass for
  `git restore .;echo done` style commands.

## Phase 2 — Worker endpoints & provider routing (shipped 2026-04-17)

Landed across three slices. The acceptance bar (two streaming adapters
plus auth/health on `worker-infra`) is met, and the proxy factories
that power every adapter are covered at the source.

- **2a — PR #312** (54 tests): `worker-tracing.test.ts` (27 tests)
  covers W3C traceparent parse/serialise, span ID generation,
  `createSpanContext` / `createChildContext` / `withWorkerSpan`, and
  `formatSpanForLog`. `worker-github-tools.test.ts` (27 tests) covers
  the `/api/github/tools` preamble, payload validation, and the
  **allowed-repo security guard** (case, `.git`, `https://github.com/`
  prefix, whitespace, empty-allowlist refusal).
- **2b — PR #313** (35 tests): `worker-infra.test.ts` covers
  `handleHealthCheck` (healthy/degraded/unhealthy matrix plus
  `Cache-Control: no-store`), `handleGitHubAppOAuth` error paths and
  the full 5-call happy path, `handleGitHubAppToken` error paths and
  happy path, and `generateGitHubAppJWT` (RS256 shape, iat/exp bounds,
  `\n`-escape normalisation, truncation-error message).
- **2c — PR #314** (31 tests): factory tests for
  `createStreamProxyHandler` (12 tests) and `createJsonProxyHandler`
  (9 tests) in `worker-middleware.test.ts` — these cover every
  adapter in `worker-providers.ts` transitively. Plus adapter smoke
  tests for OpenRouter and Ollama (chat + models) in
  `worker-providers.test.ts` (10 tests).

Net delta: +120 tests, every worker source file now has direct or
factory-level coverage. `@cloudflare/vitest-pool-workers` proved
unnecessary — `vi.stubGlobal('fetch', ...)` with a sequential-response
queue was sufficient for the HTTP paths.

## Phase 3 — Persistence & sandbox execution (shipped 2026-04-17)

Landed across three slices. The acceptance bar (branch coverage on
edit-ops and verification handlers, round-trip on `app-db`) is met, and
both GitHub and web-search tool executors now have direct coverage of
their retry/backoff and backend-selection paths.

- **3a — PR #315** (27 tests): `app-db.test.ts` (16 tests) covers the
  IndexedDB store end-to-end against `fake-indexeddb` —
  open/upgrade/get/put/del/clear across every store plus the onerror
  fallbacks. `checkpoint-store.test.ts` (8 tests) covers the
  save → load → overwrite → clear round-trip and the legacy
  localStorage → IndexedDB migration.
  `checkpoint-store-errors.test.ts` (3 tests) isolates the
  IDB-failure-tolerance specs (which swap `./app-db` via `vi.doMock`)
  so they don't interfere with the real-IDB suite.
- **3b — PR #316** (113 tests): `sandbox-routes.test.ts` (12 tests)
  covers sandbox API routing; `sandbox-edit-ops.test.ts` (47 tests)
  covers every branch of the in-sandbox edit/apply-diff paths including
  truncation-aware safety; `sandbox-verification-handlers.test.ts`
  (25 tests) covers the install → typecheck → test verification policy
  matrix; `sandbox-tool-detection.test.ts` (29 tests) covers capability
  detection and readiness inference.
- **3c — PR #317** (39 tests): `github-tool-executor.test.ts` (21 tests)
  covers base64 UTF-8 decode, fetch retry/backoff on 429 (honors
  `Retry-After` + 1s buffer) and 5xx, `AbortError` timeout wrap, and
  worker-vs-local fallback for both `fetchRepoBranches` and
  `executeToolCall` (repo-mismatch denial, URL normalization,
  unknown-tool error, thrown-error wrapping).
  `web-search-tools.test.ts` (18 tests) covers protocol prompt shape,
  `detectWebSearchToolCall`, result shaping (5-result cap, 500-char
  snippet truncation), Ollama/Tavily key gating + `Bearer` header, and
  backend selection (Tavily → Ollama → DuckDuckGo).

Net delta: ~180 tests; `app/src/lib` persistence and sandbox-execution
surfaces are now covered. `vi.stubGlobal('fetch', ...)` plus the
sequential-response queue pattern from Phase 2 carried over cleanly to
the GitHub and web-search executors.

## Phase 4 — Components & hooks (shipped 2026-04-17)

Landed in PR #319 (165 tests). Covers render + interaction tests for
7 components and isolated `renderHook` tests for 11 hooks, meeting the
acceptance bar for auth flows, commit-push lifecycle, and sandbox states.

- **Components** (33 tests): `ChatScreen` (5), `SettingsSheet` (7),
  `OnboardingScreen` (5), `WorkspaceChatRoute` (4), `FileBrowser` (5),
  `SandboxCard` (5), `ChatSurfaceRoute` (3) — render, interaction, and
  conditional-branch coverage.
- **Hooks** (132 tests): `useSnapshotManager` (21),
  `useApiKeyConfig` (18), `useSandbox` (16), `useCommitPush` (15),
  `useBranchManager` (14), `useProtectMain` (11),
  `useGitHubAppAuth` (9), `useGitHubAuth` (8),
  `useAgentDelegation` (8), `useCIPoller` (7), `useChat` (4) —
  smoke-to-deep tests covering auth token presence/absence,
  stage → audit → commit → push lifecycle, and sandbox
  start/stop/ready states.

## Phase 5 — MCP server & CLI module unit tests (shipped 2026-04-17)

Landed across two workstreams (148 new tests total). MCP server at 92%
branch coverage (acceptance bar was 60%); every listed CLI module has
direct pure-logic unit tests.

- **5a — MCP server** (51 tests): `github-client.test.ts` (22 tests)
  covers `buildHeaders`, `parseNextLink`, `formatGitHubError` (all
  status branches), and `githubFetch` (retry on 429/5xx with
  `Retry-After`, no retry on 4xx, AbortError/timeout wrapping,
  options pass-through). `index.test.ts` (29 tests) covers ListTools
  (20 tools with valid schemas), `github_server_info` (env var
  reflection), `github_api_probe` (success/401/missing fields),
  unknown-tool rejection, core tool dispatch with structured content,
  invalid-args rejection for all 12 parametric tools, and sensitive
  data redaction. Uses Node 22 `mock.module()` (experimental) to
  intercept the MCP SDK without refactoring the side-effectful
  `main()` call.
- **5b — CLI pure-logic** (97 tests across 4 files): Exported 8
  previously-private pure functions from `cli.ts`, `engine.ts`, and
  `pushd.ts`, then tested them.
  - `provider.test.mjs` (55 tests): `resolveApiKey` (6 — env
    priority, trimming, throw), `getProviderList` (4 — shape,
    hasKey probing), `createReasoningTokenParser` (22 — the crown
    jewel: cross-chunk `<think>` splits, buffer holding via the -10
    slice, null callbacks, flush semantics), `streamCompletion` (23 —
    SSE parsing, retry/backoff on 429/5xx, timeout, external abort,
    OpenRouter headers/session_id, JSON fallback).
  - `pushd-helpers.test.mjs` (14 tests): `makeResponse` (5 —
    envelope shape, null sessionId), `makeErrorResponse` (4 — error
    shape, retryable flag), `normalizeProviderInput` (5 — sentinel
    rejection, trim+lowercase).
  - `engine-helpers.test.mjs` (8 tests): `shouldDistillMidSession`
    (4 — round/plan/budget thresholds), `buildParseErrorMessage` (4 —
    wrapping, guidance text, JSON structure).
  - `cli-pure.test.mjs` (20 tests): `clamp` (6 — bounds, negatives),
    `truncateText` (5 — truncation with `...`, falsy input),
    `parseBoolFlag` (9 — strict coercion of string `"false"`/`"0"`,
    throws on invalid with flag name in message).

## Phase 6 — End-to-end flows

Catches integration regressions once unit coverage has stabilised.

Targets:

- Auth → repo connect → chat → sandbox write → commit → push.
- Provider failover (server key present vs client key fallback).
- Worker rate-limit and origin-rejection paths from a real browser context.

Acceptance: one happy-path E2E and two error-path E2Es (rate limit, missing
token).

## Known follow-ups / loose ends

- **`DESTRUCTIVE_PATTERNS` in-line-scan limitation.** The current patterns
  (`\brm`, `\bgit\s+reset`, `\bfind`, etc.) match anywhere in the command
  string, so `echo rm -rf /` and peers trigger a supervised approval
  prompt. Error direction is safe (approval asked unnecessarily, never
  silently permitted), but worth a dedicated pass across every entry to
  anchor to command boundaries consistently. Raised and deferred in PR #310.
- **Coverage gates.** No automated coverage threshold is enforced in CI.
  Revisit adding a floor in the app `vitest` config now that Phases 1–5
  have landed.
- **Worker runtime env for tests.** Resolved in Phase 2 —
  `@cloudflare/vitest-pool-workers` proved unnecessary;
  `vi.stubGlobal('fetch', ...)` was sufficient.
