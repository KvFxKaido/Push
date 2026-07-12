import path from 'node:path';

import { buildSystemPromptBase, ensureSystemPromptReady } from './engine.js';
import { ensureRepoCommandsSeeded } from './repo-commands.js';
import { createSessionState, loadSessionState, type SessionState } from './session-store.js';

export async function initCliSession(
  sessionId: string | null | undefined,
  provider: string,
  model: string,
  cwd: string,
  mode = 'interactive',
): Promise<SessionState> {
  if (sessionId) {
    const resumed = await loadSessionState(sessionId);
    void ensureRepoCommandsSeeded(resumed);
    return resumed;
  }

  const resolvedCwd = path.resolve(cwd);
  const state = {
    ...createSessionState({
      provider,
      model,
      cwd: resolvedCwd,
      mode,
      messages: [{ role: 'system', content: buildSystemPromptBase(resolvedCwd) }],
    }),
    workingMemory: {
      plan: '',
      openTasks: [],
      filesTouched: [],
      assumptions: [],
      errorsEncountered: [],
      currentPhase: '',
      completedPhases: [],
    },
    sessionName: '',
  } as SessionState;
  await ensureSystemPromptReady(state);
  void ensureRepoCommandsSeeded(state);
  return state;
}
