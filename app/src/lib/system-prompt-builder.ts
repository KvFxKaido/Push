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
  memory: 75,
  state: 78,
  custom: 80,
  last_instructions: 99,
};

// ---------------------------------------------------------------------------
// Default volatility — stable sections don't change between turns
// ---------------------------------------------------------------------------

const DEFAULT_VOLATILE: Record<PromptSectionId, boolean> = {
  identity: false,
  voice: false,
  safety: false,
  user_context: true,
  capabilities: true,
  environment: true,
  tool_instructions: false,
  delegation: false,
  guidelines: false,
  project_context: true,
  memory: true,
  state: true,
  custom: true,
  last_instructions: true,
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
      priority: priority ?? DEFAULT_PRIORITY[id],
      volatile: DEFAULT_VOLATILE[id],
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
    return this.sections.get(id)?.volatile ?? DEFAULT_VOLATILE[id];
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
   * Return a snapshot of all sections for diffing between turns.
   * Each entry contains the section's content length and a simple hash.
   * Compare snapshots to see exactly which sections changed.
   */
  snapshot(): Record<string, { hash: number; size: number; volatile: boolean }> {
    const result: Record<string, { hash: number; size: number; volatile: boolean }> = {};
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
