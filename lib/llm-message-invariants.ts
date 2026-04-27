/**
 * Preconditions for handing a message array to an LLM.
 *
 * The model can only produce a fresh assistant turn when the trailing
 * message is something it could be replying to (a user turn or a tool
 * result encoded as `role: 'user'`). An assistant-trailing array slips
 * through to the provider as a 4xx, far from the actual bug — usually
 * a resume/continue path that re-streamed without appending the next
 * user/tool-result message first. Asserting up front turns that into a
 * loud, local error.
 */

export interface RoleBearingMessage {
  role: string;
}

export function assertReadyForAssistantTurn(
  messages: ReadonlyArray<RoleBearingMessage>,
  context: string,
): void {
  if (messages.length === 0) {
    throw new Error(`${context}: cannot stream assistant turn — message history is empty.`);
  }
  const lastRole = messages[messages.length - 1].role;
  if (lastRole === 'assistant') {
    throw new Error(
      `${context}: cannot stream assistant turn — last message has role 'assistant'. ` +
        `Append the next user message or tool result before re-streaming.`,
    );
  }
}
