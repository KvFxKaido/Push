import { readFromSandbox } from '@/lib/sandbox-client';

// Phase B (sandbox re-read) order must match the Phase A (GitHub REST)
// order in `github-tools.ts:fetchProjectInstructions`. If they diverge,
// a repo carrying both PUSH.md and AGENTS.md would load PUSH.md initially
// and then have it overwritten by AGENTS.md once the sandbox is ready.
export const PROJECT_INSTRUCTION_PATHS = [
  '/workspace/PUSH.md',
  '/workspace/AGENTS.md',
  '/workspace/CLAUDE.md',
  '/workspace/GEMINI.md',
] as const;

type SandboxInstructionReader = (
  sandboxId: string,
  path: string,
) => Promise<{ content?: string | null }>;

interface SyncProjectInstructionsOptions {
  applyEffectiveInstructions: (content: string) => void;
  setInstructionFilenameState: (filename: string) => void;
  setInstructionFilename: (filename: string | null) => void;
  readInstruction?: SandboxInstructionReader;
  instructionPaths?: readonly string[];
}

export function getInstructionFilenameFromPath(path: string): string {
  return path.replace(/^\/workspace\//, '');
}

export async function syncProjectInstructionsFromSandbox(
  sandboxId: string,
  {
    applyEffectiveInstructions,
    setInstructionFilenameState,
    setInstructionFilename,
    readInstruction = readFromSandbox,
    instructionPaths = PROJECT_INSTRUCTION_PATHS,
  }: SyncProjectInstructionsOptions,
): Promise<string | null> {
  for (const path of instructionPaths) {
    try {
      const result = await readInstruction(sandboxId, path);
      const content = result.content || '';
      if (!content.trim()) continue;

      applyEffectiveInstructions(content);
      const filename = getInstructionFilenameFromPath(path);
      setInstructionFilenameState(filename);
      setInstructionFilename(filename);
      return content;
    } catch {
      continue;
    }
  }

  return null;
}
