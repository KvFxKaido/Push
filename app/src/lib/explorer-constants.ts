/**
 * Explorer constants — lightweight module for shared Explorer configuration.
 *
 * Extracted from explorer-agent.ts so that turn policies can import the
 * allowed tools set without pulling in the full Explorer agent module
 * (which depends on tool-dispatch, orchestrator, etc.).
 */

import {
  PARALLEL_READ_ONLY_GITHUB_TOOLS,
  PARALLEL_READ_ONLY_SANDBOX_TOOLS,
} from './tool-dispatch';

/** The canonical set of tools the Explorer is allowed to use (read-only + web search). */
export const EXPLORER_ALLOWED_TOOLS = new Set([
  ...PARALLEL_READ_ONLY_GITHUB_TOOLS,
  ...PARALLEL_READ_ONLY_SANDBOX_TOOLS,
  'web_search',
]);
