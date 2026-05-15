/**
 * Detector adapter for the CoderJob Durable Object.
 *
 * **Intentional seam violation — see PR #2 description.**
 *
 * The background-jobs DO ships behind this tiny local interface even
 * though the production implementation currently imports the detector
 * functions from `app/src/lib/*` (Web-side module paths). The adapter
 * exists so PR #4 can lift the detector logic into `lib/` without
 * hunting call sites across the DO code — it becomes a one-file swap
 * (`createWebDetectorAdapter()` → `createSharedDetectorAdapter()`).
 *
 * Rule for maintainers:
 *   DO NOT add direct `@/lib/sandbox-tool-detection` or
 *   `@/lib/web-search-tools` imports anywhere else in the DO code.
 *   Go through `CoderJobDetectorAdapter`.
 *
 * Tracked in `docs/archive/runbooks/Background Coder Tasks Phase 1.md` PR #4.
 */

import type { DetectedToolCalls } from '@push/lib/coder-agent';

// --- Intentional Web-side imports (see module docstring) ---
import { detectSandboxToolCall, type SandboxToolCall } from '@/lib/sandbox-tool-detection';
import { detectWebSearchToolCall, type WebSearchToolCall } from '@/lib/web-search-tools';
import {
  detectAllToolCalls as detectAllToolCallsWeb,
  detectAnyToolCall as detectAnyToolCallWeb,
  type AnyToolCall,
} from '@/lib/tool-dispatch';

export type { SandboxToolCall, WebSearchToolCall, AnyToolCall };

/** Detector operations the CoderJob DO needs. Production impl wraps the
 * Web detectors; tests can supply stubs that never fire. */
export interface CoderJobDetectorAdapter {
  detectSandboxToolCall: (text: string) => SandboxToolCall | null;
  detectWebSearchToolCall: (text: string) => WebSearchToolCall | null;
  detectAllToolCalls: (text: string) => DetectedToolCalls<AnyToolCall>;
  detectAnyToolCall: (text: string) => AnyToolCall | null;
  tagSandboxCall: (call: SandboxToolCall) => AnyToolCall;
  tagWebSearchCall: (call: WebSearchToolCall) => AnyToolCall;
}

/** Production detector adapter — wraps the Web-side detectors. */
export function createWebDetectorAdapter(): CoderJobDetectorAdapter {
  return {
    detectSandboxToolCall,
    detectWebSearchToolCall,
    detectAllToolCalls: detectAllToolCallsWeb,
    detectAnyToolCall: detectAnyToolCallWeb,
    tagSandboxCall: (call) => ({ source: 'sandbox', call }),
    tagWebSearchCall: (call) => ({ source: 'web-search', call }),
  };
}
