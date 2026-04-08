/**
 * Re-exports from the shared hashline implementation.
 *
 * Previously this file contained a browser-only copy. Now it delegates to
 * lib/hashline.ts which handles both Node.js and browser runtimes via
 * runtime crypto detection.
 */
export {
  calculateLineHash,
  calculateContentVersion,
  adaptiveHashDisplayLength,
  resolveHashlineRefs,
  applyResolvedHashlineEdits,
  applyHashlineEdits,
  renderAnchoredRange,
  type HashlineOp,
  type HashlineEditResult,
  type ResolvedEdit,
  type AppliedEditDetail,
} from '@push/lib/hashline';
