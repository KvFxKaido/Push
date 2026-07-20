/**
 * Moonshot/Kimi per-model sampling policy — single source of truth.
 *
 * Three surfaces build Kimi Chat Completions bodies (CLI
 * `cli/openai-stream.ts`, Worker `app/src/worker/worker-providers.ts`, web
 * client `app/src/lib/kimi-stream.ts`); each previously hand-carried its own
 * copy of the K2.7 regex, which is how K3 shipped into the catalog with the
 * 0.1 deterministic default still applied (Codex P1 on PR #1550). Model ids
 * here are the bare direct-API ids — vendor-prefixed routes (OpenRouter
 * `moonshotai/...`) normalize sampling upstream and don't consult this table.
 *
 * - K2.7 Code (+highspeed): Moonshot recommends pinning temperature=1,
 *   top_p=0.95 — send them explicitly (pre-existing behavior, kept).
 * - K3: sampling is FIXED server-side (temperature=1.0, top_p=0.95) and the
 *   quickstart says to omit the fields from requests entirely
 *   (platform.kimi.ai/docs/guide/kimi-k3-quickstart, 2026-07-20).
 */

export type KimiSamplingRule =
  | { readonly mode: 'pinned'; readonly temperature: number; readonly topP: number }
  | { readonly mode: 'omit' };

/**
 * Sampling rule for a bare Kimi model id, or null when the model has no
 * special policy (caller defaults apply unchanged).
 */
export function kimiSamplingRule(model: string | null | undefined): KimiSamplingRule | null {
  const m = (model ?? '').trim();
  if (/^kimi-k3(?:$|[.-])/i.test(m)) return { mode: 'omit' };
  if (/^kimi-k2\.7-code(?:-highspeed)?$/i.test(m)) {
    return { mode: 'pinned', temperature: 1, topP: 0.95 };
  }
  return null;
}
