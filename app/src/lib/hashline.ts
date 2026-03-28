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
  applyHashlineEdits,
  renderAnchoredRange,
  type HashlineOp,
  type HashlineEditResult,
} from '@push/lib/hashline';
