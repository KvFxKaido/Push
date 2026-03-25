/**
 * Explorer Turn Policy — read-only enforcement and investigation quality.
 *
 * Consolidates:
 * - EXPLORER_ALLOWED_TOOLS gate (was: buildExplorerHooks in explorer-agent.ts)
 * - No-evidence completion guard (new: prevents empty reports)
 *
 * The Explorer is strictly read-only and must produce evidence-backed findings.
 */

import type { TurnPolicy } from '../turn-policy';
import { EXPLORER_ALLOWED_TOOLS } from '../explorer-agent';

/**
 * Read-only enforcement: deny any tool not in the Explorer's allowed set.
 * This is the policy equivalent of the existing buildExplorerHooks() pre-hook,
 * expressed as a TurnPolicy so it lives alongside other Explorer invariants.
 */
function readOnlyGate(
  toolName: string,
): { action: 'deny'; reason: string } | null {
  if (EXPLORER_ALLOWED_TOOLS.has(toolName)) return null;
  return {
    action: 'deny',
    reason: `Explorer is read-only. "${toolName}" is not allowed. `
      + `Use only inspection/search tools such as ${Array.from(EXPLORER_ALLOWED_TOOLS).sort().join(', ')}.`,
  };
}

/**
 * No-empty-report guard: if the Explorer emits a response with no tool calls
 * and no structured report sections, nudge it to produce evidence.
 *
 * We check for the required output sections (Summary, Findings, etc.)
 * to distinguish a genuine completion from a premature/empty one.
 */
function noEmptyReport(
  response: string,
): { action: 'inject'; message: { id: string; role: 'user'; content: string; timestamp: number } } | null {
  const trimmed = response.trim();

  // If it contains a tool call JSON block, it's not a completion attempt
  if (/\{\s*"tool"\s*:/.test(trimmed)) return null;

  // Check for required report sections
  const hasStructure =
    /\bSummary\s*:/i.test(trimmed) &&
    /\bFindings\s*:/i.test(trimmed) &&
    /\bRelevant files\s*:/i.test(trimmed);

  if (hasStructure) return null;

  // Short response with no structure and no tool call → nudge
  if (trimmed.length < 100 || !hasStructure) {
    return {
      action: 'inject',
      message: {
        id: `explorer-policy-nudge-${Date.now()}`,
        role: 'user',
        content: [
          '[POLICY: INCOMPLETE_REPORT]',
          'Your response does not include the required report sections (Summary, Findings, Relevant files).',
          'Either use a tool to continue investigating, or produce a complete report with all required sections.',
          '[/POLICY]',
        ].join('\n'),
        timestamp: Date.now(),
      },
    };
  }

  return null;
}

export function createExplorerPolicy(): TurnPolicy {
  return {
    name: 'explorer-core',
    role: 'explorer',

    beforeToolExec: [
      (toolName) => readOnlyGate(toolName),
    ],

    afterModelCall: [
      (response) => noEmptyReport(response),
    ],
  };
}
