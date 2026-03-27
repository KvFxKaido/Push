# Sectioned System Prompts

Design doc for refactoring monolithic system prompt building into named,
composable sections inspired by the Copilot SDK's `SystemMessageConfig`.

## Problem

System prompts are currently built via string concatenation in each agent:

- **Orchestrator** (`orchestrator.ts`): One giant template literal
  (`ORCHESTRATOR_SYSTEM_PROMPT`) plus ~10 conditional `+=` appends for identity,
  approval mode, capabilities, workspace, tools, sandbox, scratchpad, web search,
  ask-user, and intent hints.
- **Coder** (`coder-agent.ts`): `buildCoderSystemPrompt()` returns a template
  literal, then the caller appends identity, project instructions, workspace
  context, symbol cache, and web search.
- **Reviewer** (`reviewer-agent.ts`): Static `REVIEWER_SYSTEM_PROMPT` joined
  with runtime context and file structure blocks.
- **Auditor** (`auditor-agent.ts`): Similar pattern.

This makes prompts hard to test in isolation, hard to override per-section,
and creates duplication (e.g., infrastructure marker bans appear in both
orchestrator and coder prompts).

## Design

### Section Registry

A `PromptSection` is a named block with optional metadata:

```typescript
interface PromptSection {
  id: PromptSectionId;
  content: string;
  priority: number;     // Lower = earlier in final prompt (0-99)
}

type PromptSectionId =
  | 'identity'           // Role identity and personality
  | 'voice'              // Tone, formatting, mobile constraints
  | 'safety'             // Infrastructure markers, output bans
  | 'environment'        // Workspace, branch, repo context
  | 'capabilities'       // Model-specific awareness (vision, etc.)
  | 'tool_instructions'  // Tool protocol, routing, error handling
  | 'delegation'         // When/how to delegate to sub-agents
  | 'guidelines'         // Workflow rules, execution loop
  | 'project_context'    // Project instructions (AGENTS.md etc.)
  | 'user_context'       // User identity, approval mode
  | 'custom'             // Agent-specific extras (scratchpad, etc.)
  | 'last_instructions'; // Final overrides, intent hints
```

### Builder API

```typescript
class SystemPromptBuilder {
  private sections: Map<PromptSectionId, PromptSection>;

  /** Set a section. Replaces if already set. */
  set(id: PromptSectionId, content: string, priority?: number): this;

  /** Append to an existing section (creates if missing). */
  append(id: PromptSectionId, content: string, priority?: number): this;

  /** Prepend to an existing section (creates if missing). */
  prepend(id: PromptSectionId, content: string, priority?: number): this;

  /** Remove a section entirely. */
  remove(id: PromptSectionId): this;

  /** Check if a section exists and is non-empty. */
  has(id: PromptSectionId): boolean;

  /** Get raw content of a section (for testing). */
  get(id: PromptSectionId): string | undefined;

  /** Compile all sections into a final prompt string. */
  build(): string;

  /** Dev-only: return section sizes for telemetry. */
  sizes(): Record<string, number>;
}
```

`build()` sorts sections by priority, joins with `\n\n`, and trims.

### Default Priority Map

| Priority | Section ID          | Notes                              |
|----------|--------------------|------------------------------------|
| 0        | identity           | Who you are                        |
| 10       | voice              | How you communicate                |
| 15       | safety             | Infrastructure marker bans         |
| 20       | user_context       | User identity, approval mode       |
| 25       | capabilities       | Model awareness                    |
| 30       | environment        | Workspace, branch context          |
| 40       | tool_instructions  | Tool protocol, routing, errors     |
| 50       | delegation         | Sub-agent dispatch rules           |
| 60       | guidelines         | Execution loop, workflow           |
| 70       | project_context    | AGENTS.md / repo instructions      |
| 80       | custom             | Role-specific (scratchpad, etc.)   |
| 99       | last_instructions  | Intent hints, final overrides      |

### Role-Specific Builders

Each role gets a factory function that returns a pre-configured builder:

```typescript
// Shared safety section reused across all roles
const SHARED_SAFETY_SECTION = `## Output Safety — Infrastructure Markers ...`;

function buildOrchestratorPrompt(ctx: OrchestratorPromptContext): string {
  return new SystemPromptBuilder()
    .set('identity', ORCHESTRATOR_IDENTITY)
    .set('voice', ORCHESTRATOR_VOICE)
    .set('safety', SHARED_SAFETY_SECTION)
    .set('user_context', buildUserContextBlock(ctx))
    .set('capabilities', buildCapabilityBlock(ctx))
    .set('environment', ctx.workspaceDescription)
    .set('tool_instructions', buildToolInstructions(ctx))
    .set('delegation', ORCHESTRATOR_DELEGATION)
    .set('guidelines', ORCHESTRATOR_GUIDELINES)
    .set('project_context', ctx.projectInstructions)
    .set('custom', buildCustomBlocks(ctx))  // scratchpad, web search, ask-user
    .set('last_instructions', ctx.intentHint)
    .build();
}

function buildCoderPrompt(ctx: CoderPromptContext): string {
  return new SystemPromptBuilder()
    .set('identity', CODER_IDENTITY)
    .set('safety', SHARED_SAFETY_SECTION)
    .set('user_context', buildUserContextBlock(ctx))
    .set('guidelines', CODER_EXECUTION_LOOP)
    .set('tool_instructions', ctx.sandboxProtocol)
    .set('project_context', ctx.projectInstructions)
    .set('custom', ctx.symbolCache)
    .build();
}
```

### Shared Sections

Content that currently appears in multiple prompts gets extracted once:

- `SHARED_SAFETY_SECTION` — infrastructure marker bans
- `buildUserContextBlock()` — identity + approval mode
- Tool error handling rules (currently duplicated between orchestrator and coder)

## Migration Plan

1. Create `app/src/lib/system-prompt-builder.ts` with `SystemPromptBuilder`
   class and section types.
2. Extract shared sections from `orchestrator.ts` and `coder-agent.ts`.
3. Refactor `ORCHESTRATOR_SYSTEM_PROMPT` + the `toLLMMessages()` append
   chain into `buildOrchestratorPrompt()` using the builder.
4. Refactor `buildCoderSystemPrompt()` + its caller's appends into
   `buildCoderPrompt()`.
5. Refactor reviewer and auditor similarly.
6. Update tests to verify individual sections rather than substring matching
   on the full prompt.
7. Add dev-mode telemetry via `builder.sizes()`.

## Non-Goals

- Runtime prompt customization UI (future).
- User-facing section overrides (future — but the builder supports it).
- Changing prompt content — this is a structural refactor only.
