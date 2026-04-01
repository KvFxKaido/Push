/**
 * Sectioned system prompt builder.
 *
 * Replaces monolithic string concatenation with named, composable sections
 * that can be set/appended/prepended/removed independently. Inspired by the
 * Copilot SDK's SystemMessageConfig pattern.
 *
 * Each section has a priority (lower = earlier in the final prompt), an id,
 * and a volatility classification:
 *
 *   - **stable** sections (identity, voice, safety, tool_instructions, etc.)
 *     remain constant for the lifetime of a session. They define *who* the
 *     agent is and *how* it operates.
 *   - **volatile** sections (environment, memory, state, last_instructions, etc.)
 *     change between turns. They carry workspace snapshots, working memory,
 *     scratchpad content, and per-turn overrides.
 *
 * The `snapshot()` method returns content hashes per section so callers can
 * diff prompts between turns and see exactly which sections changed.
 *
 * `build()` sorts by priority and joins with double newlines.
 */

// ---------------------------------------------------------------------------
// Section IDs — the canonical set of prompt building blocks
// ---------------------------------------------------------------------------

export const PROMPT_SECTION_IDS = [
  'identity',           // Role identity and personality                [stable]
  'voice',              // Tone, formatting, mobile constraints         [stable]
  'safety',             // Infrastructure markers, output bans          [stable]
  'user_context',       // User identity, approval mode                 [volatile]
  'capabilities',       // Model-specific awareness (vision, etc.)      [volatile]
  'environment',        // Workspace, branch, repo context              [volatile]
  'tool_instructions',  // Tool protocol, routing, error handling       [stable]
  'delegation',         // When/how to delegate to sub-agents           [stable]
  'guidelines',         // Execution loop, workflow rules               [stable]
  'project_context',    // Project instructions (AGENTS.md etc.)        [volatile]
  'memory',             // Scratchpad content, symbol cache             [volatile]
  'state',              // Working memory, coder state, task tracking   [volatile]
  'custom',             // Agent-specific extras                        [volatile]
  'last_instructions',  // Intent hints, final overrides                [volatile]
] as const;

export type PromptSectionId = (typeof PROMPT_SECTION_IDS)[number];

// ---------------------------------------------------------------------------
// Default priorities — determines section ordering in the final prompt
// ---------------------------------------------------------------------------

const SECTION_CONFIG: Record<PromptSectionId, { priority: number; volatile: boolean }> = {
  identity:          { priority: 0,  volatile: false },
  voice:             { priority: 10, volatile: false },
  safety:            { priority: 15, volatile: false },
  user_context:      { priority: 20, volatile: true },
  capabilities:      { priority: 25, volatile: true },
  environment:       { priority: 30, volatile: true },
  tool_instructions: { priority: 40, volatile: false },
  delegation:        { priority: 50, volatile: false },
  guidelines:        { priority: 60, volatile: false },
  project_context:   { priority: 70, volatile: true },
  memory:            { priority: 75, volatile: true },
  state:             { priority: 78, volatile: true },
  custom:            { priority: 80, volatile: true },
  last_instructions: { priority: 99, volatile: true },
};

// ---------------------------------------------------------------------------
// Internal section representation
// ---------------------------------------------------------------------------

interface PromptSection {
  id: PromptSectionId;
  content: string;
  priority: number;
  volatile: boolean;
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
      priority: priority ?? SECTION_CONFIG[id].priority,
      volatile: SECTION_CONFIG[id].volatile,
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

  /** Check if a section is volatile (changes between turns). */
  isVolatile(id: PromptSectionId): boolean {
    return this.sections.get(id)?.volatile ?? SECTION_CONFIG[id].volatile;
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

  /**
   * Return a snapshot of all set sections for diffing between turns;
   * unset sections are omitted. Each entry contains the section's content
   * length, a simple hash, and its volatility flag.
   * Compare snapshots to see exactly which sections changed.
   */
  snapshot(): Partial<Record<PromptSectionId, { hash: number; size: number; volatile: boolean }>> {
    const result: Partial<Record<PromptSectionId, { hash: number; size: number; volatile: boolean }>> = {};
    for (const [id, section] of this.sections) {
      result[id] = {
        hash: simpleHash(section.content),
        size: section.content.length,
        volatile: section.volatile,
      };
    }
    return result;
  }
}

/**
 * Fast non-cryptographic hash for snapshot diffing.
 * DJB2 variant — deterministic, collision-resistant enough for prompt debugging.
 */
function simpleHash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}
