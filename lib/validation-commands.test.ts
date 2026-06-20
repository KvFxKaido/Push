import { describe, expect, it } from 'vitest';
import {
  parseValidationCommandOverride,
  resolveValidationCommandOverride,
} from './validation-commands';

describe('parseValidationCommandOverride', () => {
  it('extracts a `# test:` command from a fenced bash block', () => {
    const text = [
      'Some prose.',
      '',
      '```bash',
      '# test:',
      'TMPDIR=/tmp npm run test:cli && npm run test:mcp:github',
      '# typecheck:',
      'npm run typecheck:tsgo',
      '```',
    ].join('\n');
    expect(parseValidationCommandOverride(text, 'test')).toBe(
      'TMPDIR=/tmp npm run test:cli && npm run test:mcp:github',
    );
    expect(parseValidationCommandOverride(text, 'typecheck')).toBe('npm run typecheck:tsgo');
  });

  it('supports an inline `# test: <command>` directive', () => {
    const text = ['```sh', '# test: pnpm test', '```'].join('\n');
    expect(parseValidationCommandOverride(text, 'test')).toBe('pnpm test');
  });

  it('terminates the command at a blank line', () => {
    const text = ['```shell', '# test:', 'go test ./...', '', 'unrelated line', '```'].join('\n');
    expect(parseValidationCommandOverride(text, 'test')).toBe('go test ./...');
  });

  it('ignores `# test:` directives outside a fenced block', () => {
    const text = ['# test:', 'npm run test:cli'].join('\n');
    expect(parseValidationCommandOverride(text, 'test')).toBeNull();
  });

  it('ignores fenced blocks that are not bash/sh/shell', () => {
    const text = ['```json', '# test:', 'npm run test:cli', '```'].join('\n');
    expect(parseValidationCommandOverride(text, 'test')).toBeNull();
  });

  it('returns null when the requested kind is absent', () => {
    const text = ['```bash', '# lint:', 'eslint .', '```'].join('\n');
    expect(parseValidationCommandOverride(text, 'test')).toBeNull();
  });

  it('does not treat prose comments with spaces as directives', () => {
    const text = ['```bash', '# run the tests now:', 'echo hi', '```'].join('\n');
    expect(parseValidationCommandOverride(text, 'test')).toBeNull();
  });

  it('returns the first match across multiple fenced blocks', () => {
    const text = [
      '```bash',
      '# lint:',
      'eslint .',
      '```',
      'prose',
      '```bash',
      '# test:',
      'vitest run',
      '```',
    ].join('\n');
    expect(parseValidationCommandOverride(text, 'test')).toBe('vitest run');
  });

  it('handles a fence info string with extra attributes', () => {
    const text = ['```bash title="commands"', '# test:', 'npm test', '```'].join('\n');
    expect(parseValidationCommandOverride(text, 'test')).toBe('npm test');
  });

  it('returns null on empty input', () => {
    expect(parseValidationCommandOverride('', 'test')).toBeNull();
  });
});

describe('resolveValidationCommandOverride', () => {
  it('prefers earlier sources (AGENTS.md beats CLAUDE.md)', () => {
    const agents = ['```bash', '# test:', 'npm run test:agents', '```'].join('\n');
    const claude = ['```bash', '# test:', 'npm run test:claude', '```'].join('\n');
    expect(resolveValidationCommandOverride([agents, claude], 'test')).toBe('npm run test:agents');
  });

  it('falls through to a later source when the first has no override', () => {
    const agents = '# no fenced override here';
    const claude = ['```bash', '# test:', 'npm run test:claude', '```'].join('\n');
    expect(resolveValidationCommandOverride([agents, claude], 'test')).toBe('npm run test:claude');
  });

  it('returns null when no source declares the override', () => {
    expect(resolveValidationCommandOverride(['', 'no override'], 'test')).toBeNull();
  });
});
