import { describe, expect, it } from 'vitest';
import {
  buildEffectiveProjectInstructions,
  getBuiltInProjectInstructions,
  isPushRepo,
} from './push-built-in-context';

describe('push built-in project context', () => {
  it('recognizes only the canonical Push repo', () => {
    expect(isPushRepo('KvFxKaido/Push')).toBe(true);
    expect(isPushRepo('someone-else/Push')).toBe(false);
    expect(isPushRepo('someone-else/not-push')).toBe(false);
  });

  it('provides built-in instructions for the Push repo even without repo docs', () => {
    const builtIn = getBuiltInProjectInstructions('KvFxKaido/Push');
    expect(builtIn).toContain('Push is an AI coding agent with a web app plus a local CLI/TUI');
    expect(builtIn).toContain(
      'Explorer: autonomous read-only investigator for codebase understanding',
    );
    expect(builtIn).toContain('Branch creation is UI-owned');
  });

  it('merges built-in context with repo-authored instructions', () => {
    const effective = buildEffectiveProjectInstructions(
      'KvFxKaido/Push',
      '# AGENTS.md\n\n## Testing\n- Run npm test',
    );
    expect(effective).toContain('# Push Built-In Project Context');
    expect(effective).toContain('# Repo Instruction File');
    expect(effective).toContain('Run npm test');
  });

  it('leaves non-Push repos unchanged', () => {
    expect(buildEffectiveProjectInstructions('owner/other', '# AGENTS.md\n\nhello')).toBe(
      '# AGENTS.md\n\nhello',
    );
  });
});
