import { readFromSandbox } from '@/lib/sandbox-client';

export const PROJECT_INSTRUCTION_PATHS = [
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
