# Copilot SDK Research

Research date: 2026-03-27
SDK version: Technical Preview (launched Jan 22, 2026)
Repository: github/copilot-sdk (~8k stars, MIT)
Packages: `@github/copilot-sdk` (npm), `github-copilot-sdk` (pip), Go, .NET, Java

Reviewed against current Push code: 2026-03-30

## What It Is

The GitHub Copilot SDK exposes the Copilot CLI's agent runtime as a programmable
SDK. The SDK itself contains no AI inference — it communicates with the Copilot
CLI via JSON-RPC 2.0 (stdio or TCP). The CLI runs in headless server mode and
handles planning, tool orchestration, and context management.

## Architecture

```
Your App → SDK Client → JSON-RPC 2.0 → Copilot CLI (server mode)
```

- Transport: stdio (default, SDK manages CLI lifecycle) or TCP (external server)
- Protocol version negotiation via ping with min/max compatibility
- Graceful shutdown with retry (3 attempts, exponential backoff)
- Multiple SDK clients can share one external CLI server

## Key Patterns

### 1. Custom Agents (Sub-Agent Orchestration)

Agents are lightweight definitions attached to a session. Each gets its own
system prompt, restricted tool set, and optional MCP servers:

```typescript
const session = await client.createSession({
  customAgents: [
    {
      name: "researcher",
      description: "Read-only code investigation",
      tools: ["grep", "read_file", "web_search"],
      prompt: "You are a read-only investigator...",
      infer: true  // auto-select based on intent
    },
    {
      name: "coder",
      description: "Code implementation",
      tools: null,  // all tools
      prompt: "You implement code changes...",
    },
    {
      name: "dangerous-cleanup",
      infer: false,  // explicit invocation only
      prompt: "Delete unused files..."
    }
  ]
});
```

Delegation flow:
1. Runtime analyzes prompt against agent descriptions (intent matching)
2. Selects appropriate agent automatically
3. Agent runs in isolated context (own message history)
4. Lifecycle events stream to parent: `subagent.started`, `subagent.completed`,
   `subagent.failed`, `subagent.selected`, `subagent.deselected`
5. Result integrated into parent response

Built-in CLI agents: Explore, Task, Plan, Code-review.

### 2. Tool Definition

Tools use typed schemas with handler functions:

```typescript
tools: [{
  name: "search_codebase",
  description: "Search code files",
  parameters: z.object({
    query: z.string(),
    fileGlob: z.string().optional()
  }),
  handler: async (args, invocation) => {
    return { matches: [...] };
  },
  overridesBuiltInTool: false,
  skipPermission: false
}]
```

Built-in tools: bash, edit, grep, read_file, web-fetch, web-search, Playwright,
Git operations, GitHub API operations.

### 3. Event System (Ephemeral vs Persisted)

Every event has: id, timestamp, parentId, ephemeral flag, type, data.

| Category        | Events                                          |
|-----------------|------------------------------------------------|
| Turn management | `assistant.turn_start`, `assistant.turn_end`   |
| Reasoning       | `assistant.reasoning` / `reasoning_delta`       |
| Messages        | `assistant.message` / `message_delta`           |
| Tools           | `tool.execution_start/progress/complete`        |
| Session         | `session.idle`, `session.error`, `session.compaction_start/complete` |
| Permissions     | `permission.requested/completed`                |
| Sub-agents      | `subagent.started/completed/failed/selected`    |
| Usage           | `assistant.usage` (tokens, cost multiplier)     |

Ephemeral events (deltas) drive real-time UI. Persisted events survive resume.

### 4. Steering & Queueing (Mid-Turn Injection)

- **Steering** (`mode: "immediate"`): injected into current LLM turn mid-execution
- **Queueing** (`mode: "enqueue"`): FIFO queue processed after current turn

Solves the "redirect agent without aborting" problem.

### 5. System Prompt Sections

Three modes via `SystemMessageConfig`:
- **Append**: SDK foundation + your content
- **Replace**: Full control, bypasses guardrails
- **Customize**: Section-level overrides

Named sections (10): `identity`, `tone`, `tool_efficiency`, `environment_context`,
`code_change_rules`, `guidelines`, `safety`, `tool_instructions`,
`custom_instructions`, `last_instructions`.

Actions per section: `replace`, `remove`, `append`, `prepend`.

### 6. Pre/Post Tool Hooks

```typescript
// Pre-tool hook
{ toolName, toolArgs, cwd, timestamp }
→ { permissionDecision: "allow"|"deny"|"ask",
    modifiedArgs, additionalContext, suppressOutput }

// Post-tool hook
{ toolName, toolArgs, toolResult }
→ { modifiedResult, additionalContext, suppressOutput }
```

Additional hooks: `onUserPromptSubmitted`, `onSessionStart`, `onSessionEnd`,
`onErrorOccurred`.

### 7. MCP Server Integration

Two types: local/stdio (subprocess) and HTTP/SSE (remote).
Configured per-session or per-agent via `mcpServers`.

### 8. Session Persistence

- State persisted to `~/.copilot/session-state/{sessionId}/`
- Persists: conversation history, tool results, planning state, artifacts
- Does NOT persist: API keys, in-memory tool state
- Structured IDs recommended: `user-{userId}-{taskId}`

### 9. Skills System

Reusable prompt modules stored as `SKILL.md` files in directories.
Loaded via `skillDirectories` config, selectively disabled with `disabledSkills`.

### 10. Telemetry

OpenTelemetry integration with W3C Trace Context propagation between SDK and
CLI. Exports to OTLP HTTP or local JSON-lines files.

## Comparison with Push

| Dimension | Copilot SDK | Push | Notes |
|-----------|-------------|------|-------|
| Agent isolation | Per-agent tool sets + prompts | Allowlists + `TurnPolicy` `beforeToolExec` hooks | ✅ Shipped — positive-list via `EXPLORER_ALLOWED_TOOLS`, tool-registry `readOnly` filtering |
| Delegation | Automatic intent matching | Explicit tool calls | Push is more deterministic |
| Streaming | Event-driven with ephemeral flag | Activity-based timeout + accumulate | Copilot more composable |
| Context mgmt | CLI-internal | Multi-phase compaction | Push is more sophisticated |
| Checkpointing | Session state files | 25-min delta snapshots | Push more robust for mobile |
| Safety gate | Pre-tool hooks | Auditor + pre/post tool hooks | ✅ Shipped — `ToolHookRegistry` with `PreToolUseHook`/`PostToolUseHook` in tool-dispatch |
| Mid-turn redirect | Steering/queueing | Abort + restart | Copilot is better here |
| System prompts | 10 named sections | 12 named sections via `SystemPromptBuilder` | ✅ Shipped — all 4 agents migrated to sectioned builder |

## Patterns to Adopt

Priority order for Push:

1. ~~**Sectioned system prompts**~~ ✅ **Done** — `SystemPromptBuilder` with 12 named sections, all agents migrated. See `app/src/lib/system-prompt-builder.ts`.
2. **Steering/queueing** — Mid-turn user injection without aborting agent work.
3. **Ephemeral vs persisted events** — Reduce IndexedDB writes, simplify resume.
4. ~~**Per-agent tool scoping**~~ ✅ **Done** — Positive-list allowlists (`EXPLORER_ALLOWED_TOOLS`), `TurnPolicy` framework with `beforeToolExec` hooks, tool-registry `readOnly` filtering. See `app/src/lib/turn-policy.ts`, `app/src/lib/explorer-constants.ts`.
5. ~~**Lifecycle events**~~ ✅ **Mostly done** — run events now cover assistant turns, tool execution, and subagent state. The remaining gap is richer exec/session lifecycle detail plus a cleaner ephemeral-vs-persisted split.
6. ~~**Pre/post tool hooks**~~ ✅ **Done** — `ToolHookRegistry` with `PreToolUseHook`/`PostToolUseHook`, integrated into `tool-dispatch.ts`, turn policy bridge. See `app/src/lib/tool-hooks.ts`.
7. **Task agent** — Split test/build from Coder.
