import { describe, expect, it, vi } from 'vitest';
import {
  getInstructionFilenameFromPath,
  syncProjectInstructionsFromSandbox,
} from './project-instructions-utils';

describe('project-instructions-utils', () => {
  it('derives the instruction filename from a sandbox path', () => {
    expect(getInstructionFilenameFromPath('/workspace/CLAUDE.md')).toBe('CLAUDE.md');
  });

  it('syncs the filename for the first non-empty sandbox instruction file', async () => {
    const applyEffectiveInstructions = vi.fn();
    const setInstructionFilenameState = vi.fn();
    const setInstructionFilename = vi.fn();
    const readInstruction = vi
      .fn<(sandboxId: string, path: string) => Promise<{ content?: string | null }>>()
      .mockResolvedValueOnce({ content: '' })
      .mockResolvedValueOnce({ content: '' })
      .mockResolvedValueOnce({ content: 'Claude instructions' });

    const result = await syncProjectInstructionsFromSandbox('sandbox-1', {
      applyEffectiveInstructions,
      setInstructionFilenameState,
      setInstructionFilename,
      readInstruction,
    });

    expect(result).toBe('Claude instructions');
    expect(readInstruction).toHaveBeenNthCalledWith(1, 'sandbox-1', '/workspace/PUSH.md');
    expect(readInstruction).toHaveBeenNthCalledWith(2, 'sandbox-1', '/workspace/AGENTS.md');
    expect(readInstruction).toHaveBeenNthCalledWith(3, 'sandbox-1', '/workspace/CLAUDE.md');
    expect(applyEffectiveInstructions).toHaveBeenCalledWith('Claude instructions');
    expect(setInstructionFilenameState).toHaveBeenCalledWith('CLAUDE.md');
    expect(setInstructionFilename).toHaveBeenCalledWith('CLAUDE.md');
  });

  it('prefers PUSH.md over AGENTS.md when both exist in the sandbox', async () => {
    const applyEffectiveInstructions = vi.fn();
    const setInstructionFilenameState = vi.fn();
    const setInstructionFilename = vi.fn();
    const readInstruction = vi
      .fn<(sandboxId: string, path: string) => Promise<{ content?: string | null }>>()
      .mockResolvedValueOnce({ content: 'Push instructions' })
      .mockResolvedValueOnce({ content: 'Agents instructions' });

    const result = await syncProjectInstructionsFromSandbox('sandbox-1', {
      applyEffectiveInstructions,
      setInstructionFilenameState,
      setInstructionFilename,
      readInstruction,
    });

    expect(result).toBe('Push instructions');
    expect(readInstruction).toHaveBeenNthCalledWith(1, 'sandbox-1', '/workspace/PUSH.md');
    expect(setInstructionFilename).toHaveBeenCalledWith('PUSH.md');
  });
});
