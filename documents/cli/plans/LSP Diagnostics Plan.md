# LSP Diagnostics for Push CLI

Status: **Shipped** (2026-02-25)

Implementation: `cli/diagnostics.mjs`, integrated into `cli/tools.mjs`

## Problem

The Coder agent currently discovers type and syntax errors by running test commands (e.g. `npm test`, `tsc --noEmit`) as acceptance criteria after completing a task. This means errors are caught late — after the agent has finished editing, not while it's working. A diagnostic tool would tighten the feedback loop so the Coder can self-correct within a task rather than failing acceptance criteria and re-looping.

## Why CLI, Not Web

LSP servers are long-lived daemons that run against a real local filesystem. In the CLI, that's just the user's machine — straightforward. In the web app, the "filesystem" is inside an ephemeral Modal container, and LSP protocol (stateful JSON-RPC over stdio/TCP) doesn't map cleanly to the REST/HTTP sandbox proxy. The web Coder already uses acceptance criteria shell commands as a reasonable approximation.

## Approach Options

### A. Compiler CLI subprocess (recommended first pass)

Run a language-appropriate type-check command as a subprocess, parse output, return structured diagnostics.

**Pros:** Language-agnostic, no new dependencies, simple lifecycle, easy to extend per language.
**Cons:** Cold start per call (~1–2s for `tsc`), requires custom output parsers per language.

### B. TypeScript compiler API directly

Import `typescript` npm package, use `ts.createProgram()` to get diagnostics in-process.

**Pros:** No subprocess, structured output natively, faster.
**Cons:** TypeScript-only. Other languages still need option A.

### C. Full LSP client

Spawn the LSP server as a persistent child process, implement JSON-RPC handshake (`initialize`, `textDocument/didOpen`, `workspace/diagnostic`).

**Pros:** Richest data — hover types, cross-file inference, not just errors.
**Cons:** Significantly more complex; no good lightweight LSP client npm package for Node CLIs today. Overkill for a first pass.

**Decision:** Start with A. Validate the signal is useful before adding complexity.

## New Module: `diagnostics.mjs`

Language detection via project file existence checks at workspace root:

| File present | Checker | Command |
|---|---|---|
| `tsconfig.json` | TypeScript | `tsc --noEmit --pretty false` |
| `pyproject.toml` | Pyright | `pyright --outputjson` |
| `pyproject.toml` (alt) | Ruff | `ruff check --output-format json` |
| `Cargo.toml` | Cargo | `cargo check --message-format json` |
| `go.mod` | Go vet | `go vet ./...` |

Returns a normalized structure regardless of backend:

```js
[
  {
    file: 'src/foo.ts',
    line: 42,
    col: 7,
    severity: 'error' | 'warning',
    message: 'Type X is not assignable to type Y',
    code: 'TS2322', // optional
  }
]
```

Falls back gracefully if no supported project file is detected (returns empty array, not an error).

If the checker binary isn't installed, return a structured error consistent with Push's existing taxonomy:

```json
{ "error_type": "DIAGNOSTIC_TOOL_NOT_FOUND", "retryable": false }
```

## What This Is For

Diagnostics is **model steering**, not correctness enforcement. Correctness enforcement is the Auditor's job (pre-commit gate, binary SAFE/UNSAFE verdict). Diagnostics gives the Coder better signal *during* the editing loop so it doesn't hallucinate "it should be fine now" and burn an acceptance criteria failure. That distinction matters: if this were enforcement, it would need to be a gate. As steering, it's a signal — which shapes how it should integrate.

## Tool Integration

### `lsp_diagnostics` tool

Add to `TOOL_PROTOCOL` string in `tools.mjs`:

```
- lsp_diagnostics(path?) — run type-checker for the workspace; path filters results to a specific file
```

Add to `READ_ONLY_TOOLS` set so it can run in parallel with other reads.

Add dispatch `case 'lsp_diagnostics'` in `executeToolCall()`.

### Integration point options

**1. Explicit tool call (ship first)**
The model calls `lsp_diagnostics()` when it wants to check. Model controls timing, no noise, easy to reason about. Consistent with Push's bias toward explicit, inspectable execution — every other tool is explicit, this should be too until there's evidence otherwise.

**2. Auto-append to edit results (do not ship in v1)**
After every `write_file` or `edit_file`, diagnostics appended to the tool result. This increases round cost on every mutation, can create edit→error→fix→edit→error feedback loops, and makes performance dependent on project size. Hidden behavior that breaks the transparency pattern.

**3. `[meta]` error count (good v2 path)**
Add `diagnostics_errors=N` to the existing `[meta]` envelope alongside `round`, `context`, and `dirty`. Lightweight awareness without flooding context — consistent with how dirty state is already signaled. `[meta]` already carries workspace state; error count is the same kind of signal.

**4. `acceptanceCriteria` auto-integration (good v2 path)**
If a supported project type is detected, auto-append the appropriate type-check command to `acceptanceCriteria` when delegating to the Coder. Scopes diagnostics to *completion validation*, not every mutation. Aligned with the harness model: tools verify outcomes, not intentions.

Recommendation: ship option 1, then evaluate 3 and 4 together once signal quality is validated.

## Minimal Prototype Scope

1. `diagnostics.mjs` — language detection + `tsc --noEmit` subprocess + output parser + `DIAGNOSTIC_TOOL_NOT_FOUND` error
2. `lsp_diagnostics` added to `TOOL_PROTOCOL` string and `READ_ONLY_TOOLS`
3. Dispatch `case` in `executeToolCall()` calling `diagnostics.mjs`
4. Manual test: TypeScript project, model edits a file to introduce a type error, calls `lsp_diagnostics`, self-corrects

## Open Questions

- Does cold-start latency (~1–2s per `tsc` call) matter in practice, given that tool rounds already take seconds for LLM inference?
- For monorepos with multiple `tsconfig.json` files, how do we pick the right one?
- Should `lsp_diagnostics` be gated behind a config flag so users without a supported type-checker don't see confusing errors?
