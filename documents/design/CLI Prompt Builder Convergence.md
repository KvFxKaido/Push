# CLI Prompt Builder Convergence

Design plan for migrating the CLI's system prompt pipeline from string
concatenation to `SystemPromptBuilder`, converging with the web app's
architecture.

## Current State

### Web App (complete)
All five agent roles use `SystemPromptBuilder` with:
- Named, priority-sorted sections (`identity`, `voice`, `safety`, etc.)
- Volatility classification (stable vs volatile per section)
- `snapshot()` / `diffSnapshots()` for turn-level debugging
- Shared sections (`SHARED_SAFETY_SECTION`, `SHARED_OPERATIONAL_CONSTRAINTS`)

### CLI (`cli/engine.ts`)
Uses string concatenation with a two-phase build:

1. **`buildSystemPromptBase(workspaceRoot)`** — sync, instant
   - Inline identity paragraph ("You are a coding assistant...")
   - Optional `[EXPLAIN_MODE]` block
   - `TOOL_PROTOCOL` constant (~600 lines from `cli/tools.ts`)
   - `NEEDS_ENRICHMENT` sentinel

2. **`buildSystemPrompt(workspaceRoot)`** — async, I/O
   - Strips sentinel, appends workspace snapshot + project instructions + memory
   - Three `+= \n\n` appends after `Promise.all`

3. **`ensureSystemPromptReady(state)`** — lazy enrichment
   - Detects sentinel, replaces system message content in-place
   - Deduped via WeakMap per SessionState

### Key differences

| Concern | Web App | CLI |
|---------|---------|-----|
| Builder | `SystemPromptBuilder` class | String concatenation |
| Sections | 14 named, priority-sorted | Implicit string order |
| Volatility | Tagged per section | No concept |
| Enrichment | Inline in `toLLMMessages()` | Two-phase (sentinel pattern) |
| Context trimming | `orchestrator-context.ts` | `context-manager.ts` (same strategy, separate impl) |
| Roles | 5 (Orchestrator, Coder, Explorer, Reviewer, Auditor) | 1 (Coder only) |
| Debugging | `sizes()`, `snapshot()`, `diffSnapshots()` | None |

## Goal

Make the CLI use `SystemPromptBuilder` for prompt composition while
preserving its two-phase enrichment pattern and CLI-specific content.

**Non-goals:**
- Unifying web and CLI into a single build function (different runtimes)
- Adding multiple roles to CLI (that's a separate effort)
- Changing prompt content — structural refactor only

## Plan

### Phase 1: Share the builder module

The builder is a pure TypeScript class with no web dependencies. It lives
at `app/src/lib/system-prompt-builder.ts`.

**Option A: Move to shared package**
Create `packages/prompt-builder/` with the builder, section types, and
diff utilities. Both `app/` and `cli/` import from it.

**Option B: Copy to CLI**
Duplicate `system-prompt-builder.ts` into `cli/`. Simpler, no monorepo
plumbing, but creates drift risk.

**Option C: Re-export from app**
CLI imports directly from `app/src/lib/system-prompt-builder.ts` via
path alias. Works if the build tooling supports it.

**Recommendation: Option A.** The builder is stable, well-tested, and has
no framework dependencies. A shared package is the clean solution and
prevents drift. If monorepo setup is too heavy, start with Option B and
converge later.

### Phase 2: Map CLI prompt content to sections

Current CLI `buildSystemPromptBase()` content maps to:

```
"You are a coding assistant..."    → identity
"Use tools for facts..."           → guidelines
"Use coder_update_state..."        → guidelines
"Use save_memory..."               → guidelines
[EXPLAIN_MODE] block               → guidelines (conditional append)
TOOL_PROTOCOL                      → tool_instructions
NEEDS_ENRICHMENT                   → (sentinel, not a section)
```

Current CLI `buildSystemPrompt()` enrichment maps to:

```
Workspace snapshot (git, tree)     → environment
Project instructions               → project_context
Memory (structured + free-text)    → memory
```

Proposed builder setup:

```typescript
function buildCLIBaseBuilder(workspaceRoot: string): SystemPromptBuilder {
  return new SystemPromptBuilder()
    .set('identity', CLI_IDENTITY(workspaceRoot))
    .set('guidelines', CLI_GUIDELINES)
    .set('tool_instructions', TOOL_PROTOCOL);
}

async function enrichCLIBuilder(
  builder: SystemPromptBuilder,
  workspaceRoot: string,
): Promise<void> {
  const [snapshot, instructions, memoryContent] = await Promise.all([
    buildWorkspaceSnapshot(workspaceRoot).catch(() => ''),
    loadProjectInstructions(workspaceRoot).catch(() => null),
    loadMemory(workspaceRoot).catch(() => null),
  ]);

  if (snapshot) builder.set('environment', snapshot);
  if (instructions) {
    builder.set('project_context',
      `[PROJECT_INSTRUCTIONS source="${instructions.file}"]\n${instructions.content}\n[/PROJECT_INSTRUCTIONS]`);
  }
  if (memoryContent) builder.set('memory', `[MEMORY]\n${memoryContent}\n[/MEMORY]`);
}
```

### Phase 3: Preserve the sentinel pattern

The CLI's two-phase enrichment (instant base → async enrichment) is a
good pattern for CLI startup latency. Preserve it:

```typescript
export function buildSystemPromptBase(workspaceRoot: string): string {
  // Still returns a string for SessionState.messages[0].content
  const builder = buildCLIBaseBuilder(workspaceRoot);
  // Append sentinel so ensureSystemPromptReady knows to enrich
  return builder.build() + '\n' + NEEDS_ENRICHMENT;
}

export async function buildSystemPrompt(workspaceRoot: string): Promise<string> {
  const builder = buildCLIBaseBuilder(workspaceRoot);
  await enrichCLIBuilder(builder, workspaceRoot);
  return builder.build();
}
```

The sentinel stays in the string output, not in the builder sections.
`ensureSystemPromptReady` works unchanged.

### Phase 4: Add dev logging

Wire `sizes()` and `snapshot()`/`diffSnapshots()` into the CLI's
`runAssistantLoop()` behind a `PUSH_DEBUG` env var:
if (process.env.PUSH_DEBUG) {
  const sizes = builder.sizes();
  const metrics = Object.entries(sizes).map(([k,v]) => `${k}=${v}`).join(' ');
  console.error(fmt.dim(`[Prompt] ${metrics}`));
}
```typescript
if (process.env.PUSH_DEBUG) {
  const sizes = builder.sizes();
  console.error(`[Prompt] ${Object.entries(sizes).map(([k,v]) => `${k}=${v}`).join(' ')}`);
}
```

### Phase 5: Extract shared prompt constants

Some content is duplicated between web and CLI:
- Operational constraints (faithful reporting)
- Code discipline rules
- Infrastructure marker bans

These already live in `app/src/lib/system-prompt-sections.ts`. If using
Option A (shared package), move them there. If Option B, accept the
duplication for now.

## Migration order

1. **Create shared package or copy builder** (Phase 1)
2. **Extract CLI identity/guidelines constants** from inline strings (Phase 2)
3. **Refactor `buildSystemPromptBase`** to use builder internally (Phase 2-3)
4. **Refactor `buildSystemPrompt`** to use builder + enrichment (Phase 2-3)
5. **Add debug logging** (Phase 4)
6. **Extract shared sections** if using shared package (Phase 5)
7. **Verify**: run CLI tests, manual smoke test, check prompt output matches

## Risks

- **TOOL_PROTOCOL size**: The CLI's tool protocol is ~600 lines. Moving
  it into `tool_instructions` is straightforward but the section will
  dominate the prompt. This is fine — it's stable content.
- **Sentinel interaction**: The sentinel must survive `builder.build()`.
  Appending it outside the builder (after `.build()`) keeps concerns
  separate.
- **Context trimming**: `context-manager.ts` operates on the final string,
  not on sections. The builder doesn't change this — trimming still works
  on the flattened message content.
- **Working memory injection**: Coder state (`coder_update_state`) is
  injected into tool results mid-stream, not into the system prompt.
  The builder doesn't interact with this path.

## Success criteria

- CLI prompt output is byte-identical before and after migration
- `buildSystemPromptBase` and `buildSystemPrompt` use `SystemPromptBuilder`
- CLI has `sizes()` output available behind debug flag
- No new runtime dependencies introduced
- Existing CLI tests pass unchanged
