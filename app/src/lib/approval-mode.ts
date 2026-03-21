/**
 * System-controlled approval modes.
 *
 * Moves consent decisions from model personality to system configuration.
 * The model is told explicitly what it may do without asking.
 *
 * - supervised: Model asks before mutating actions (default — current behavior)
 * - autonomous: Model executes freely, only asks on genuine ambiguity
 * - full-auto:  Execute everything, errors auto-retry, no ask_user unless blocked
 */

export type ApprovalMode = 'supervised' | 'autonomous' | 'full-auto';

const APPROVAL_MODE_STORAGE_KEY = 'push_approval_mode';

export function getApprovalMode(): ApprovalMode {
  try {
    const stored = localStorage.getItem(APPROVAL_MODE_STORAGE_KEY);
    if (stored === 'supervised' || stored === 'autonomous' || stored === 'full-auto') {
      return stored;
    }
  } catch {
    // ignore storage errors
  }
  return 'supervised';
}

export function setApprovalMode(mode: ApprovalMode): void {
  try {
    localStorage.setItem(APPROVAL_MODE_STORAGE_KEY, mode);
  } catch {
    // ignore storage errors
  }
}

// ---------------------------------------------------------------------------
// System prompt blocks — injected into Orchestrator and Coder prompts
// ---------------------------------------------------------------------------

const SUPERVISED_BLOCK = `## Approval Mode: Supervised

You are in Supervised mode. Before taking mutating actions (file edits, command execution, commits), confirm with the user using ask_user unless the user has already approved the overall plan. Prefer asking over assuming when the consequences are non-trivial.`;

const AUTONOMOUS_BLOCK = `## Approval Mode: Autonomous

You are in Autonomous mode. Execute file edits, commands, and commits without asking for confirmation. Only use ask_user when:
- There is genuine ambiguity that would materially change the outcome
- The user needs to choose between fundamentally different approaches
- A destructive or irreversible action is required outside the sandbox

Do NOT ask for permission to read, edit, write, run tests, install dependencies, or commit. Just do it. Mistakes in the sandbox are cheap — act decisively and fix issues as they come up.`;

const FULL_AUTO_BLOCK = `## Approval Mode: Full Auto

You are in Full Auto mode. Execute everything without asking. Never use ask_user — if you encounter ambiguity, make the best reasonable choice and continue. If an operation fails, retry silently up to 3 times before reporting the error. Your goal is uninterrupted flow: read, edit, test, commit, push — no pauses, no confirmations, no questions.

Errors are expected and cheap. Retry, adapt, and keep moving. Only stop if you hit a hard blocker that no retry or alternative approach can resolve.`;

export function buildApprovalModeBlock(mode: ApprovalMode): string {
  switch (mode) {
    case 'supervised':
      return SUPERVISED_BLOCK;
    case 'autonomous':
      return AUTONOMOUS_BLOCK;
    case 'full-auto':
      return FULL_AUTO_BLOCK;
  }
}
