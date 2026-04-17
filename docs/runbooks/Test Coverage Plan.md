# Test Coverage Plan

Status: Current (Phase 1 shipped 2026-04-17). Added 2026-04-17.

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

## Phase 2 — Worker endpoints & provider routing (next)

5 of 6 files in `app/src/worker/` are untested, and `runPreamble` was the
single bottleneck covered in Phase 1. Providers are a black box today.

Targets:

- `app/src/worker/worker-providers.ts` (~856 LOC) — per-provider request
  shape, streaming/non-streaming dispatch, upstream error translation. Focus
  on the adapter boundaries (Anthropic, OpenAI, Vertex, Ollama, OpenRouter,
  Zen, Blackbox AI, Kilo Code) rather than upstream mocks.
- `app/src/worker/worker-infra.ts` (~842 LOC) — OAuth endpoints, GitHub App
  token exchange, installation allowlist, `/api/health`. Use `@cloudflare/vitest-pool-workers`
  or `unstable_dev` to drive real requests.
- `app/src/worker/worker-github-tools.ts` (182 LOC) — tool-call proxy into
  the GitHub MCP server; covers the allowlisted-repo guard.
- `app/src/worker/worker-tracing.ts` (148 LOC) — span context propagation and
  traceparent header handling.

Acceptance: integration tests for at least two provider adapters
(streaming plus error path) plus auth/health endpoints on `worker-infra`.
Non-goal: full mock coverage of every provider.

## Phase 3 — Persistence & sandbox execution

Data-loss and destructive-operation risk; currently untested end-to-end.

Targets:

- `app/src/lib/app-db.ts` (213 LOC) — IndexedDB chat/workspace store. Use
  `fake-indexeddb` to drive real transactions.
- `app/src/lib/checkpoint-store.ts` (54 LOC) — session persistence.
- `app/src/lib/sandbox-routes.ts` (88 LOC) — sandbox API routing.
- `app/src/lib/sandbox-edit-ops.ts` — in-sandbox file edit ops (surface for
  truncation-aware edit safety).
- `app/src/lib/sandbox-verification-handlers.ts` — verification policies.
- `app/src/lib/sandbox-tool-detection.ts` — capability detection.
- `app/src/lib/github-tool-executor.ts` (251 LOC) — GitHub action executor
  (edit/delete/create PRs).
- `app/src/lib/web-search-tools.ts` (251 LOC) — web search adapter.

Acceptance: unit tests for every branch in edit-ops and verification
handlers; round-trip test on `app-db` for chat save/restore.

## Phase 4 — Components & hooks

96% of React components and 84% of custom hooks are untested.

Targets (priority):

- Components: `ChatScreen`, `SettingsSheet`, `OnboardingScreen`,
  `WorkspaceChatRoute`, `FileBrowser`, `SandboxCard`, `ChatSurfaceRoute`.
- Hooks: `useGitHubAuth`, `useGitHubAppAuth`, `useSandbox`, `useChat`,
  `useBranchManager`, `useCommitPush`, `useSnapshotManager`,
  `useAgentDelegation`, `useApiKeyConfig`, `useCIPoller`, `useProtectMain`.

Acceptance: render + interaction tests for the top 7 components; isolated
`renderHook` tests for the listed hooks covering the auth, commit-push, and
sandbox-lifecycle branches.

## Phase 5 — MCP server & CLI module unit tests

Rounds out packages that currently only have integration-style coverage.

Targets:

- `mcp/github-server/src/github-client.ts` — REST client (mock `fetch`).
- `mcp/github-server/src/index.ts` — MCP tool/resource registration.
- CLI unit tests for pure-logic extracted from `cli.ts` (2153 LOC),
  `engine.ts` (1332 LOC), `pushd.ts` (3543 LOC), and `provider.ts` (428
  LOC). Likely requires a small extraction pass so modules are unit-testable
  without spawning the daemon.

Acceptance: MCP server at 60%+ branch coverage; at least one pure-logic unit
test target per listed CLI module.

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
  Once Phase 2 lands, revisit adding a floor in the app `vitest` config.
- **Worker runtime env for tests.** Phase 2 integration tests may require
  `@cloudflare/vitest-pool-workers`; evaluate during Phase 2 kickoff.
