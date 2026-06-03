import { describe, expect, it, vi } from 'vitest';
import {
  PROJECT_INSTRUCTION_FILENAMES,
  resolveProjectInstructions,
} from './project-instructions-source.js';

describe('PROJECT_INSTRUCTION_FILENAMES', () => {
  // Drift pin: the canonical precedence every surface resolves against. When a
  // surface stops hand-copying its own list, this is the one place the order
  // lives — a careless reorder has to move this assertion with it.
  it('is the canonical first-found-wins ordering', () => {
    expect([...PROJECT_INSTRUCTION_FILENAMES]).toEqual([
      'PUSH.md',
      'AGENTS.md',
      'CLAUDE.md',
      'GEMINI.md',
    ]);
  });
});

describe('resolveProjectInstructions', () => {
  it('returns the first candidate the reader resolves, in canonical order', async () => {
    const read = vi.fn(async (f: string) => (f === 'AGENTS.md' ? 'be excellent' : null));

    const result = await resolveProjectInstructions(read);

    expect(result).toEqual({ content: 'be excellent', filename: 'AGENTS.md' });
    // PUSH.md was tried first (and missed) before AGENTS.md won; CLAUDE/GEMINI
    // were never read because resolution short-circuits.
    expect(read.mock.calls.map((c) => c[0])).toEqual(['PUSH.md', 'AGENTS.md']);
  });

  it('skips empty / whitespace-only files', async () => {
    const read = async (f: string) =>
      f === 'PUSH.md' ? '   \n\t' : f === 'CLAUDE.md' ? 'real instructions' : null;

    const result = await resolveProjectInstructions(read);

    expect(result).toEqual({ content: 'real instructions', filename: 'CLAUDE.md' });
  });

  it('returns null when no candidate resolves', async () => {
    expect(await resolveProjectInstructions(async () => null)).toBeNull();
  });

  it('propagates reader errors instead of treating them as a missing file', async () => {
    // The GitHub REST reader throws on a non-404 status; resolution must let
    // that surface rather than swallowing it and falling through to "no
    // instructions" (which would silently drop a repo's orientation on a 500).
    const read = async (f: string) => {
      if (f === 'AGENTS.md') throw new Error('GitHub API error 500');
      return null;
    };

    await expect(resolveProjectInstructions(read)).rejects.toThrow('GitHub API error 500');
  });
});
