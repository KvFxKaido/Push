import { describe, it, expect } from 'vitest';
import { SystemPromptBuilder, PROMPT_SECTION_IDS, diffSnapshots, formatSnapshotDiff } from './system-prompt-builder';

describe('SystemPromptBuilder', () => {
  it('builds empty string when no sections are set', () => {
    expect(new SystemPromptBuilder().build()).toBe('');
  });

  it('builds a single section', () => {
    const result = new SystemPromptBuilder()
      .set('identity', 'You are a coding assistant.')
      .build();
    expect(result).toBe('You are a coding assistant.');
  });

  it('sorts sections by priority', () => {
    // Set sections in reverse priority order
    const result = new SystemPromptBuilder()
      .set('last_instructions', 'Final notes.')
      .set('identity', 'Identity block.')
      .set('guidelines', 'Guidelines block.')
      .build();
    // identity (0) < guidelines (60) < last_instructions (99)
    expect(result).toBe('Identity block.\n\nGuidelines block.\n\nFinal notes.');
  });

  it('allows custom priority override', () => {
    const result = new SystemPromptBuilder()
      .set('guidelines', 'Guidelines.', 5)  // override to come before identity
      .set('identity', 'Identity.', 10)
      .build();
    expect(result).toBe('Guidelines.\n\nIdentity.');
  });

  it('trims content', () => {
    const result = new SystemPromptBuilder()
      .set('identity', '  Hello  ')
      .build();
    expect(result).toBe('Hello');
  });

  it('ignores null/undefined/empty content on set', () => {
    const builder = new SystemPromptBuilder()
      .set('identity', 'Hello')
      .set('voice', null)
      .set('safety', undefined)
      .set('guidelines', '   ');
    expect(builder.has('identity')).toBe(true);
    expect(builder.has('voice')).toBe(false);
    expect(builder.has('safety')).toBe(false);
    expect(builder.has('guidelines')).toBe(false);
  });

  it('replaces existing section on set', () => {
    const result = new SystemPromptBuilder()
      .set('identity', 'First')
      .set('identity', 'Second')
      .build();
    expect(result).toBe('Second');
  });

  it('removes section when set to empty', () => {
    const builder = new SystemPromptBuilder()
      .set('identity', 'Hello')
      .set('identity', '');
    expect(builder.has('identity')).toBe(false);
  });

  it('appends to existing section', () => {
    const result = new SystemPromptBuilder()
      .set('identity', 'Part one.')
      .append('identity', 'Part two.')
      .build();
    expect(result).toBe('Part one.\n\nPart two.');
  });

  it('append creates section when missing', () => {
    const result = new SystemPromptBuilder()
      .append('identity', 'Created via append.')
      .build();
    expect(result).toBe('Created via append.');
  });

  it('append ignores null/empty', () => {
    const builder = new SystemPromptBuilder()
      .set('identity', 'Unchanged')
      .append('identity', null)
      .append('identity', '');
    expect(builder.get('identity')).toBe('Unchanged');
  });

  it('prepends to existing section', () => {
    const result = new SystemPromptBuilder()
      .set('identity', 'Original.')
      .prepend('identity', 'Prepended.')
      .build();
    expect(result).toBe('Prepended.\n\nOriginal.');
  });

  it('prepend creates section when missing', () => {
    const result = new SystemPromptBuilder()
      .prepend('voice', 'New voice section.')
      .build();
    expect(result).toBe('New voice section.');
  });

  it('removes a section', () => {
    const builder = new SystemPromptBuilder()
      .set('identity', 'Hello')
      .set('voice', 'Tone')
      .remove('voice');
    expect(builder.has('voice')).toBe(false);
    expect(builder.build()).toBe('Hello');
  });

  it('get returns content or undefined', () => {
    const builder = new SystemPromptBuilder()
      .set('identity', 'Hello');
    expect(builder.get('identity')).toBe('Hello');
    expect(builder.get('voice')).toBeUndefined();
  });

  it('sizes returns char counts per section', () => {
    const sizes = new SystemPromptBuilder()
      .set('identity', 'Hello')     // 5 chars
      .set('voice', 'Hi there')     // 8 chars
      .sizes();
    expect(sizes).toEqual({ identity: 5, voice: 8 });
  });

  it('supports method chaining', () => {
    const result = new SystemPromptBuilder()
      .set('identity', 'A')
      .set('voice', 'B')
      .append('voice', 'C')
      .prepend('identity', 'Z')
      .remove('safety')
      .build();
    expect(result).toContain('Z');
    expect(result).toContain('B');
  });

  it('exports all expected section IDs', () => {
    expect(PROMPT_SECTION_IDS).toContain('identity');
    expect(PROMPT_SECTION_IDS).toContain('voice');
    expect(PROMPT_SECTION_IDS).toContain('safety');
    expect(PROMPT_SECTION_IDS).toContain('user_context');
    expect(PROMPT_SECTION_IDS).toContain('capabilities');
    expect(PROMPT_SECTION_IDS).toContain('environment');
    expect(PROMPT_SECTION_IDS).toContain('tool_instructions');
    expect(PROMPT_SECTION_IDS).toContain('delegation');
    expect(PROMPT_SECTION_IDS).toContain('guidelines');
    expect(PROMPT_SECTION_IDS).toContain('project_context');
    expect(PROMPT_SECTION_IDS).toContain('memory');
    expect(PROMPT_SECTION_IDS).toContain('state');
    expect(PROMPT_SECTION_IDS).toContain('custom');
    expect(PROMPT_SECTION_IDS).toContain('last_instructions');
    expect(PROMPT_SECTION_IDS).toHaveLength(14);
  });

  // --- Volatility classification ---

  it('marks identity sections as stable', () => {
    const builder = new SystemPromptBuilder()
      .set('identity', 'Role identity')
      .set('voice', 'Tone')
      .set('safety', 'Safety rules')
      .set('tool_instructions', 'Tool protocol')
      .set('delegation', 'Delegation rules')
      .set('guidelines', 'Workflow');
    expect(builder.isVolatile('identity')).toBe(false);
    expect(builder.isVolatile('voice')).toBe(false);
    expect(builder.isVolatile('safety')).toBe(false);
    expect(builder.isVolatile('tool_instructions')).toBe(false);
    expect(builder.isVolatile('delegation')).toBe(false);
    expect(builder.isVolatile('guidelines')).toBe(false);
  });

  it('marks runtime sections as volatile', () => {
    const builder = new SystemPromptBuilder()
      .set('environment', 'Workspace context')
      .set('memory', 'Scratchpad content')
      .set('state', 'Working memory')
      .set('last_instructions', 'Intent hint');
    expect(builder.isVolatile('environment')).toBe(true);
    expect(builder.isVolatile('memory')).toBe(true);
    expect(builder.isVolatile('state')).toBe(true);
    expect(builder.isVolatile('last_instructions')).toBe(true);
  });

  // --- Snapshot ---

  it('snapshot returns hash, size, and volatile flag per section', () => {
    const snap = new SystemPromptBuilder()
      .set('identity', 'Hello')
      .set('memory', 'Scratchpad data')
      .snapshot();
    expect(snap.identity).toEqual({
      hash: expect.any(Number),
      size: 5,
      volatile: false,
    });
    expect(snap.memory).toEqual({
      hash: expect.any(Number),
      size: 15,
      volatile: true,
    });
  });

  it('snapshot detects changes between turns', () => {
    const builder = new SystemPromptBuilder()
      .set('identity', 'Stable role')
      .set('memory', 'Turn 1 scratchpad');
    const snap1 = builder.snapshot();

    builder.set('memory', 'Turn 2 scratchpad');
    const snap2 = builder.snapshot();

    // Stable section unchanged
    expect(snap2.identity!.hash).toBe(snap1.identity!.hash);
    // Volatile section changed
    expect(snap2.memory!.hash).not.toBe(snap1.memory!.hash);
  });

  // --- New section ordering ---

  it('orders memory and state between project_context and custom', () => {
    const result = new SystemPromptBuilder()
      .set('custom', 'Custom.')
      .set('memory', 'Memory.')
      .set('state', 'State.')
      .set('project_context', 'Project.')
      .build();
    const order = ['Project.', 'Memory.', 'State.', 'Custom.'];
    expect(result).toBe(order.join('\n\n'));
  });
});

// ---------------------------------------------------------------------------
// diffSnapshots / formatSnapshotDiff
// ---------------------------------------------------------------------------

describe('diffSnapshots', () => {
  it('detects added sections', () => {
    const prev = new SystemPromptBuilder().set('identity', 'A').snapshot();
    const next = new SystemPromptBuilder().set('identity', 'A').set('memory', 'B').snapshot();
    const diff = diffSnapshots(prev, next);
    expect(diff.added).toEqual(['memory']);
    expect(diff.unchanged).toContain('identity');
  });

  it('detects removed sections', () => {
    const prev = new SystemPromptBuilder().set('identity', 'A').set('memory', 'B').snapshot();
    const next = new SystemPromptBuilder().set('identity', 'A').snapshot();
    const diff = diffSnapshots(prev, next);
    expect(diff.removed).toEqual(['memory']);
  });

  it('detects changed sections', () => {
    const prev = new SystemPromptBuilder().set('identity', 'A').set('memory', 'Turn 1').snapshot();
    const next = new SystemPromptBuilder().set('identity', 'A').set('memory', 'Turn 2').snapshot();
    const diff = diffSnapshots(prev, next);
    expect(diff.changed).toEqual(['memory']);
    expect(diff.unchanged).toContain('identity');
  });

  it('returns all unchanged when nothing differs', () => {
    const builder = new SystemPromptBuilder().set('identity', 'A').set('voice', 'B');
    const snap = builder.snapshot();
    const diff = diffSnapshots(snap, snap);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toHaveLength(2);
  });
});

describe('formatSnapshotDiff', () => {
  it('returns null when nothing changed', () => {
    expect(formatSnapshotDiff({ added: [], removed: [], changed: [], unchanged: ['identity'] })).toBeNull();
  });

  it('formats added/changed/removed compactly', () => {
    const result = formatSnapshotDiff({
      added: ['memory'],
      removed: ['custom'],
      changed: ['environment'],
      unchanged: ['identity', 'voice'],
    });
    expect(result).toBe('[Prompt Diff] +[memory] -[custom] Δ[environment] (2 unchanged)');
  });
});
