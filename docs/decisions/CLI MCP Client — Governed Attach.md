# CLI MCP Client — Governed Attach

**Status:** Current — v1 shipped: stdio + streamable HTTP on the CLI lead turn, which every CLI surface (headless, REPL, TUI, pushd) runs. Verified live headless against the Cloudflare docs server; the interactive surfaces share the same dispatcher gate but have not been driven by hand yet. Phase 2 (Cloudflare API server) is config-only and not yet exercised.
Reviewed: 2026-10-27

## Why now

Push is no longer only a daily-driver chat surface; it is also an agent other
agents (Claude Code's `push` skill) delegate to through headless `push run`.
That makes the CLI the surface that matters, and the CLI is the one place
CLAUDE.md already says MCP may land: *"MCP attach is therefore CLI-only and
scoped to the attached tools."* The `charmbracelet crush` research note lists
MCP as Push's known gap with zero implementation.

## What MCP is for (and not for)

The capability-sourcing rule in CLAUDE.md decides this: runtime-contract
capabilities (fs, git, shell, code, CI, GitHub) are **folded in**;
external-product integrations (Cloudflare, Notion, Linear, Slack…) are what MCP
is for.

So a **filesystem MCP server is explicitly out of scope** — it would duplicate
`read_file` / `write_file` / `edit_file` while bypassing everything that makes
them governed: hashline edits, sensitive-path redaction, the Auditor commit
gate, post-edit diagnostics, the file-mutation batch budget. Nothing in this
design stops a user from attaching one, but Push does not ship, document, or
recommend it.

The v1 target is **Cloudflare**: the documentation server
(`https://docs.mcp.cloudflare.com/mcp`, keyless, streamable HTTP) proves the
client; the API server (`https://mcp.cloudflare.com/mcp`, bearer token) is the
phase-2 target.

## Decisions

### 1. Scope: CLI only

The client lives in `cli/mcp-client.ts`. Nothing in `lib/` or the web/Worker
imports it. A deployed multi-user surface attaching user-chosen MCP servers is
ungoverned reach outside the runtime contract; the CLI is sole-user, on the
user's own machine.

### 2. Config: `mcpServers` in the `.mcp.json` shape

`~/.push/config.json` (or `PUSH_CONFIG_PATH`) gains an `mcpServers` map in the
shape Claude Code and most MCP clients already use, so a block can be copied
between them:

```json
{
  "mcpServers": {
    "cloudflare-docs": { "type": "http", "url": "https://docs.mcp.cloudflare.com/mcp" },
    "cloudflare-api": {
      "type": "http",
      "url": "https://mcp.cloudflare.com/mcp",
      "headers": { "Authorization": "Bearer ${CLOUDFLARE_API_TOKEN}" }
    },
    "local-thing": { "command": "node", "args": ["server.js"], "env": { "X": "1" } }
  },
  "mcpAllow": ["mcp__cloudflare_docs__*"]
}
```

- Transport: `command` ⇒ stdio; `url` ⇒ streamable HTTP (`type` may be `http`
  or omitted). SSE-only legacy servers are not supported in v1.
- **Secrets never live in config.** `${VAR}` in `headers`, `env`, `args`, and
  `url` expands from the process environment at connect time. A reference to an
  unset variable skips that server (`mcp_server_config_invalid`) rather than
  sending a literal `${…}` or an empty bearer.
- stdio children get the SDK's minimal default environment plus the server's
  own `env` block — not Push's whole environment (which can carry provider keys
  and the gateway token).
- `disabled: true` on a server entry skips it.

### 3. Naming: `mcp__<server>__<tool>`

Tool names are namespaced `mcp__<server>__<tool>`, each part sanitized to
`[A-Za-z0-9_]` (so `cloudflare-docs` → `cloudflare_docs`) and the whole name
capped at 64 characters, the strictest limit across Push's native-calling
providers and the text-dispatch parser's identifier rule. The server part is
capped at 24 characters (truncated + short hash), and only the tool part is
ever cut after that, so the `mcp__<server>__` prefix always survives whole and
a `mcp__<server>__*` disabledTools / allowlist entry matches every tool of the
server; `mcp_server_connected` logs the exact prefix. A collision after
sanitization drops the later tool with an `mcp_tool_name_collision` log — never
a silent overwrite.

Input schemas keep `properties` / `required` (the shared tool-schema contract)
with local `$defs` / `definitions` refs **inlined**, since provider adapters
drop a bare `$ref`; a cyclic or too-deep ref becomes an open object.

### 4. Every MCP call is side-effecting by default

MCP `annotations.readOnlyHint` is a claim made by the server, not something
Push can verify. Push therefore:

- treats every MCP call as **side-effecting** for grouping, so it rides the
  trailing side-effect chain (sequential, fail-fast, cap 3) like `exec`;
- shows `readOnlyHint` in the prompt catalog as information only;
- never uses it to skip approval or to unlock headless execution.

If parallel MCP reads earn their keep later, that is an explicit per-server
config opt-in, not a hint the server sets on itself.

### 5. Governance: the same gates as folded-in tools

An MCP call goes through `executeToolCall`, in this order, exactly like any
other CLI tool:

1. **`disabledTools`** — exact namespaced names, plus `mcp__<server>__*`
   prefix entries.
2. **Role capability** — a new `mcp:call` capability in `lib/capabilities.ts`,
   granted to Orchestrator and Coder **in `local-daemon` mode only** (it is
   never in the static/cloud grant, so web delegation briefs never list it). `getToolCapabilities` maps every
   `mcp__*` name to it, so the Explorer / Reviewer / Auditor gates fail closed
   on MCP names instead of fail-open on an unmapped tool.
3. **Pre-hooks** — unchanged.
4. **Approval / headless gate** (`guardMcpCall`, modeled on `guardExecCommand`):
   - **Headless** (no `approvalFn`): **blocked** (`MCP_DISABLED`) unless the tool
     matches the allowlist — `mcpAllow` config, `PUSH_MCP_ALLOW` env, or
     `push run --allow-mcp <pattern,…>`. Patterns are exact names or a trailing
     `*` prefix. `execMode: yolo` lifts the gate, same as for exec.
   - **Interactive**: every call prompts through the surface's existing
     `approvalFn('mcp', detail)` (REPL, TUI modal, daemon `approval_required`)
     unless the tool is allowlisted or in `alwaysAllow`. The REPL's
     "trust for session" answer trusts that one MCP tool; it never saves an exec
     prefix.
5. **Redaction** — the result passes through `redactToolResult` like every
   other tool, so workspace credential values are scrubbed from MCP output too.

### 6. Results

`CallToolResult.content` text items are concatenated; images, audio, and blob
resources become one-line placeholders; `isError: true` becomes `ok: false`
with `MCP_TOOL_ERROR`. Output is capped (with a truncation note) so one
chatty server cannot flood the context window. A transport throw becomes a
structured tool result, not a fatal run error (same contract as the GitHub
fork), and is **not retryable**: a timeout or dropped stream does not mean the
server didn't apply a side-effecting call, so the result says the outcome is
unknown rather than inviting a duplicate write.

### 7. Observability

Symmetric structured logs on stderr (CLI stdout is reserved for `--json`):
`mcp_server_connected` ↔ `mcp_server_connect_failed` ↔ `mcp_server_config_invalid`;
`mcp_tool_called` ↔ `mcp_tool_failed` ↔ `mcp_tool_blocked`.

### 8. Lifecycle

The registry is process-scoped and lazy: the first lead turn reads
`mcpServers` from the config file (base config — profiles do not layer it in
v1), connects every enabled server in parallel (bounded by a connect timeout),
and lists tools once. A session that configures nothing pays nothing. `push
run`, the REPL and inline TUI close it in `main()`'s teardown; pushd closes it
on shutdown. A server that fails to connect stays skipped for the life of the
process (restart to retry). Lead turns only — delegated
daemon Coder/Explorer nodes do not see MCP tools in v1.

### 9. Deferral: not yet

Tools are eager-loaded in v1. The Cloudflare docs server exposes two tools;
the API server's code-mode design exposes two (`search`, `execute`). Deferral
(progressive disclosure of a long MCP tool tail) is the only place CLAUDE.md
says it would earn its keep, and it waits for a server that actually needs it.
A server advertising more than a soft cap logs `mcp_server_tool_count_high`.

## Phase 2: Cloudflare API server

`https://mcp.cloudflare.com/mcp` answers 401 with an OAuth
`WWW-Authenticate` challenge, but accepts a Cloudflare API token as a bearer
header for automation. Phase 2 is a config block (above) with a **scoped,
read-mostly API token** in an env var. Its `execute` tool runs arbitrary API
code, so it is never put on the headless allowlist by default: allowlist
`mcp__cloudflare_api__search` only, and leave `execute` to interactive approval.
OAuth (the SDK's `auth.js` provider flow) is out of scope until a server
requires it.

## Out of scope (v1)

Web/Worker MCP; MCP resources and prompts (tools only); sampling and
elicitation; OAuth; legacy SSE transport; delegated-node MCP; deferral; MCP
for the fs/git/shell capabilities Push folds in.
