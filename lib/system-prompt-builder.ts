/**
 * Sectioned system prompt builder.
 *
 * Replaces monolithic string concatenation with named, composable sections
 * that can be set/appended/prepended/removed independently.
 *
 * Stable sections define who the agent is and how it operates; volatile
 * sections carry workspace snapshots, memory, and turn-specific state.
 */

export const PROMPT_SECTION_IDS = [
  'identity',
  'voice',
  'safety',
  'user_context',
  'capabilities',
  'environment',
  'tool_instructions',
  'delegation',
  'guidelines',
  'project_context',
  'memory',
  'state',
  'custom',
  'last_instructions',
] as const;

export type PromptSectionId = (typeof PROMPT_SECTION_IDS)[number];

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

interface PromptSection {
  id: PromptSectionId;
  content: string;
  priority: number;
  volatile: boolean;
}

export class SystemPromptBuilder {
  private sections = new Map<PromptSectionId, PromptSection>();

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

  append(id: PromptSectionId, content: string | null | undefined, priority?: number): this {
    if (!content?.trim()) return this;
    const existing = this.sections.get(id);
    if (existing) {
      existing.content = `${existing.content}\n\n${content.trim()}`;
    } else {
      this.set(id, content, priority);
    }
    return this;
  }

  prepend(id: PromptSectionId, content: string | null | undefined, priority?: number): this {
    if (!content?.trim()) return this;
    const existing = this.sections.get(id);
    if (existing) {
      existing.content = `${content.trim()}\n\n${existing.content}`;
    } else {
      this.set(id, content, priority);
    }
    return this;
  }

  remove(id: PromptSectionId): this {
    this.sections.delete(id);
    return this;
  }

  has(id: PromptSectionId): boolean {
    return this.sections.has(id);
  }

  get(id: PromptSectionId): string | undefined {
    return this.sections.get(id)?.content;
  }

  isVolatile(id: PromptSectionId): boolean {
    return this.sections.get(id)?.volatile ?? SECTION_CONFIG[id].volatile;
  }

  build(): string {
    const sorted = [...this.sections.values()].sort((a, b) => a.priority - b.priority);
    return sorted.map((section) => section.content).join('\n\n');
  }

  sizes(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [id, section] of this.sections) {
      result[id] = section.content.length;
    }
    return result;
  }

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

export interface SnapshotEntry {
  hash: number;
  size: number;
  volatile: boolean;
}

export type PromptSnapshot = Partial<Record<PromptSectionId, SnapshotEntry>>;

export interface SnapshotDiff {
  added: PromptSectionId[];
  removed: PromptSectionId[];
  changed: PromptSectionId[];
  unchanged: PromptSectionId[];
}

export function diffSnapshots(prev: PromptSnapshot, next: PromptSnapshot): SnapshotDiff {
  const added: PromptSectionId[] = [];
  const removed: PromptSectionId[] = [];
  const changed: PromptSectionId[] = [];
  const unchanged: PromptSectionId[] = [];

  const allIdSet = new Set([
    ...Object.keys(prev) as PromptSectionId[],
    ...Object.keys(next) as PromptSectionId[],
  ]);
  const sectionOrder = new Map(PROMPT_SECTION_IDS.map((id, index) => [id, index]));
  const allIds = Array.from(allIdSet).sort((a, b) =>
    (sectionOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (sectionOrder.get(b) ?? Number.MAX_SAFE_INTEGER),
  );

  for (const id of allIds) {
    const previous = prev[id];
    const current = next[id];
    if (!previous && current) added.push(id);
    else if (previous && !current) removed.push(id);
    else if (previous && current && (previous.hash !== current.hash || previous.size !== current.size)) changed.push(id);
    else unchanged.push(id);
  }

  return { added, removed, changed, unchanged };
}

export function formatSnapshotDiff(diff: SnapshotDiff): string | null {
  const parts: string[] = [];
  if (diff.added.length) parts.push(`+[${diff.added.join(',')}]`);
  if (diff.removed.length) parts.push(`-[${diff.removed.join(',')}]`);
  if (diff.changed.length) parts.push(`Δ[${diff.changed.join(',')}]`);
  if (parts.length === 0) return null;
  return `[Prompt Diff] ${parts.join(' ')} (${diff.unchanged.length} unchanged)`;
}

function simpleHash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}
