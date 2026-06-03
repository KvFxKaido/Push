import { readFromSandbox } from '@/lib/sandbox-client';
import { PROJECT_INSTRUCTION_FILENAMES } from '@push/lib/project-instructions-source';

// Phase B (sandbox re-read) resolves the same candidates as Phase A (GitHub
// REST) and the CLI — derived from the one shared list rather than re-spelled,
// so the orders can't diverge (a divergence would let a repo carrying both
// PUSH.md and AGENTS.md load one initially and the other once the sandbox is
// ready). Mapped onto the sandbox checkout's absolute paths.
export const PROJECT_INSTRUCTION_PATHS = PROJECT_INSTRUCTION_FILENAMES.map(
  (filename) => `/workspace/${filename}`,
) as readonly string[];

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
