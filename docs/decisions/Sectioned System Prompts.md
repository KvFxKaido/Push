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

A `PromptSection` is a named block with priority and volatility metadata:

```typescript
interface PromptSection {
  id: PromptSectionId;
  content: string;
  priority: number;     // Lower = earlier in final prompt (0-99)
  volatile: boolean;    // true = changes between turns, false = session-stable
}

type PromptSectionId =
  | 'identity'           // Role identity and personality          [stable]
  | 'voice'              // Tone, formatting, mobile constraints   [stable]
  | 'safety'             // Infrastructure markers, output bans    [stable]
  | 'user_context'       // User identity, approval mode           [volatile]
  | 'capabilities'       // Model-specific awareness (vision)      [volatile]
  | 'environment'        // Workspace, branch, repo context        [volatile]
  | 'tool_instructions'  // Tool protocol, routing, error handling [stable]
  | 'delegation'         // When/how to delegate to sub-agents     [stable]
  | 'guidelines'         // Workflow rules, execution loop         [stable]
  | 'project_context'    // Project instructions (AGENTS.md etc.)  [volatile]
  | 'memory'             // Scratchpad content, symbol cache       [volatile]
  | 'state'              // Working memory, coder state            [volatile]
  | 'custom'             // Agent-specific extras                  [volatile]
  | 'last_instructions'; // Final overrides, intent hints          [volatile]
```

### Volatility Classification

Sections are classified as **stable** or **volatile**:

- **Stable** sections (`identity`, `voice`, `safety`, `tool_instructions`,
  `delegation`, `guidelines`) define the agent's identity and operational rules.
  They remain constant for the lifetime of a session.
- **Volatile** sections (`user_context`, `capabilities`, `environment`,
  `project_context`, `memory`, `state`, `custom`, `last_instructions`) carry
  runtime context that changes between turns.

The `snapshot()` method returns content hashes per section, enabling callers to
diff prompts between turns and see exactly which sections changed — useful for
debugging behavioral drift.

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

  /** Check if a section is volatile (changes between turns). */
  isVolatile(id: PromptSectionId): boolean;

  /** Dev-only: return section sizes for telemetry. */
  sizes(): Record<string, number>;

  /** Return snapshot of all set sections (hash + size + volatile) for diffing; unset sections are omitted. */
  snapshot(): Record<string, { hash: number; size: number; volatile: boolean }>;
}
```

`build()` sorts sections by priority, joins with `\n\n`, and trims.

### Default Priority Map

| Priority | Section ID          | Volatile | Notes                              |
|----------|--------------------|---------|------------------------------------|
| 0        | identity           | no      | Who you are                        |
| 10       | voice              | no      | How you communicate                |
| 15       | safety             | no      | Infrastructure marker bans         |
| 20       | user_context       | yes     | User identity, approval mode       |
| 25       | capabilities       | yes     | Model awareness                    |
| 30       | environment        | yes     | Workspace, branch context          |
| 40       | tool_instructions  | no      | Tool protocol, routing, errors     |
| 50       | delegation         | no      | Sub-agent dispatch rules           |
| 60       | guidelines         | no      | Execution loop, workflow           |
| 70       | project_context    | yes     | AGENTS.md / repo instructions      |
| 75       | memory             | yes     | Scratchpad content, symbol cache   |
| 78       | state              | yes     | Working memory, coder state        |
| 80       | custom             | yes     | Role-specific extras               |
| 99       | last_instructions  | yes     | Intent hints, final overrides      |

### Role-Specific Builders

Each role gets a factory function that returns a pre-configured builder:

```typescript
// Shared safety section reused across all roles
const SHARED_SAFETY_SECTION = `## Output Safety — Infrastructure Markers ...`;

function buildOrchestratorPrompt(ctx: OrchestratorPromptContext): string {
  return new SystemPromptBuilder()
    .set('identity', ORCHESTRATOR_IDENTITY)              // stable
    .set('voice', ORCHESTRATOR_VOICE)                    // stable
    .set('safety', SHARED_SAFETY_SECTION)                // stable
    .set('user_context', buildUserContextBlock(ctx))      // volatile
    .set('capabilities', buildCapabilityBlock(ctx))       // volatile
    .set('environment', ctx.workspaceDescription)         // volatile
    .set('tool_instructions', buildToolInstructions(ctx)) // stable
    .set('delegation', ORCHESTRATOR_DELEGATION)           // stable
    .set('guidelines', ORCHESTRATOR_GUIDELINES)           // stable
    .set('project_context', ctx.projectInstructions)      // volatile
    .set('memory', buildScratchpadContext(ctx.scratchpad)) // volatile — scratchpad content
    .set('last_instructions', ctx.intentHint)             // volatile
    .build();
}

function buildCoderPrompt(ctx: CoderPromptContext): string {
  return new SystemPromptBuilder()
    .set('identity', CODER_IDENTITY)                     // stable
    .set('safety', SHARED_SAFETY_SECTION)                // stable
    .set('user_context', buildUserContextBlock(ctx))      // volatile
    .set('guidelines', CODER_EXECUTION_LOOP)              // stable
    .set('tool_instructions', ctx.sandboxProtocol)        // stable
    .set('project_context', ctx.projectInstructions)      // volatile
    .set('memory', ctx.symbolCache)                       // volatile — symbol cache
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
