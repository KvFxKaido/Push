/**
 * Explorer constants — lightweight module for shared Explorer configuration.
 *
 * Extracted from explorer-agent.ts so that turn policies can import the
 * allowed tools set without pulling in the full Explorer agent module
 * (which depends on tool-dispatch, orchestrator, etc.).
 *
 * Imports from tool-registry (zero-dependency leaf module) instead of
 * tool-dispatch to avoid dragging in github-tools → utils → clsx.
 */

import { getToolCanonicalNames } from './tool-registry';

/** The canonical set of tools the Explorer is allowed to use (read-only + web search). */
export const EXPLORER_ALLOWED_TOOLS = new Set([
  ...getToolCanonicalNames({ source: 'github', readOnly: true }),
  ...getToolCanonicalNames({ source: 'sandbox', readOnly: true }),
  'web_search',
]);
