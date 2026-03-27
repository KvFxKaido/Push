import { describe, it, expect } from 'vitest';
import { SystemPromptBuilder, PROMPT_SECTION_IDS } from './system-prompt-builder';

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
    expect(PROMPT_SECTION_IDS).toContain('custom');
    expect(PROMPT_SECTION_IDS).toContain('last_instructions');
    expect(PROMPT_SECTION_IDS).toHaveLength(12);
  });
});
