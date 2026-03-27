/**
 * Sectioned system prompt builder.
 *
 * Replaces monolithic string concatenation with named, composable sections
 * that can be set/appended/prepended/removed independently. Inspired by the
 * Copilot SDK's SystemMessageConfig pattern.
 *
 * Each section has a priority (lower = earlier in the final prompt) and an id.
 * `build()` sorts by priority and joins with double newlines.
 */

// ---------------------------------------------------------------------------
// Section IDs — the canonical set of prompt building blocks
// ---------------------------------------------------------------------------

export const PROMPT_SECTION_IDS = [
  'identity',           // Role identity and personality
  'voice',              // Tone, formatting, mobile constraints
  'safety',             // Infrastructure markers, output bans
  'user_context',       // User identity, approval mode
  'capabilities',       // Model-specific awareness (vision, etc.)
  'environment',        // Workspace, branch, repo context
  'tool_instructions',  // Tool protocol, routing, error handling
  'delegation',         // When/how to delegate to sub-agents
  'guidelines',         // Execution loop, workflow rules
  'project_context',    // Project instructions (AGENTS.md etc.)
  'custom',             // Agent-specific extras (scratchpad, symbols, etc.)
  'last_instructions',  // Intent hints, final overrides
] as const;

export type PromptSectionId = (typeof PROMPT_SECTION_IDS)[number];

// ---------------------------------------------------------------------------
// Default priorities — determines section ordering in the final prompt
// ---------------------------------------------------------------------------

const DEFAULT_PRIORITY: Record<PromptSectionId, number> = {
  identity: 0,
  voice: 10,
  safety: 15,
  user_context: 20,
  capabilities: 25,
  environment: 30,
  tool_instructions: 40,
  delegation: 50,
  guidelines: 60,
  project_context: 70,
  custom: 80,
  last_instructions: 99,
};

// ---------------------------------------------------------------------------
// Internal section representation
// ---------------------------------------------------------------------------

interface PromptSection {
  id: PromptSectionId;
  content: string;
  priority: number;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export class SystemPromptBuilder {
  private sections = new Map<PromptSectionId, PromptSection>();

  /** Set a section. Replaces any existing content for this id. */
  set(id: PromptSectionId, content: string | null | undefined, priority?: number): this {
    if (!content?.trim()) {
      this.sections.delete(id);
      return this;
    }
    this.sections.set(id, {
      id,
      content: content.trim(),
      priority: priority ?? DEFAULT_PRIORITY[id],
    });
    return this;
  }

  /** Append content to an existing section (creates if missing). */
  append(id: PromptSectionId, content: string | null | undefined, priority?: number): this {
    if (!content?.trim()) return this;
    const existing = this.sections.get(id);
    if (existing) {
      existing.content = existing.content + '\n\n' + content.trim();
    } else {
      this.set(id, content, priority);
    }
    return this;
  }

  /** Prepend content to an existing section (creates if missing). */
  prepend(id: PromptSectionId, content: string | null | undefined, priority?: number): this {
    if (!content?.trim()) return this;
    const existing = this.sections.get(id);
    if (existing) {
      existing.content = content.trim() + '\n\n' + existing.content;
    } else {
      this.set(id, content, priority);
    }
    return this;
  }

  /** Remove a section entirely. */
  remove(id: PromptSectionId): this {
    this.sections.delete(id);
    return this;
  }

  /** Check if a section exists and has content. */
  has(id: PromptSectionId): boolean {
    return this.sections.has(id);
  }

  /** Get raw content of a section (for testing). */
  get(id: PromptSectionId): string | undefined {
    return this.sections.get(id)?.content;
  }

  /** Compile all sections into a final prompt string, sorted by priority. */
  build(): string {
    const sorted = [...this.sections.values()].sort((a, b) => a.priority - b.priority);
    return sorted.map((s) => s.content).join('\n\n');
  }

  /** Dev-only: return section sizes for prompt-budget telemetry. */
  sizes(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [id, section] of this.sections) {
      result[id] = section.content.length;
    }
    return result;
  }
}
