/**
 * App-side re-export of the shared tool-hook runtime. The canonical
 * module now lives in `lib/tool-hooks.ts` so the CLI executor can
 * evaluate the same hooks. Web call sites import from here; CLI
 * imports directly from `@push/lib/tool-hooks`.
 */

export {
  evaluatePreHooks,
  evaluatePostHooks,
  createToolHookRegistry,
  type ToolHookContext,
  type ToolHookRegistry,
  type PreToolUseHook,
  type PostToolUseHook,
  type PreToolHookEntry,
  type PostToolHookEntry,
  type PreToolUseResult,
  type PostToolUseResult,
} from '@push/lib/tool-hooks';
