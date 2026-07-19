/**
 * reasoning-replay-routing.ts — the single source of truth for "does this
 * resolved provider+model route replay plain `reasoning_content` on the next
 * request?"
 *
 * Shared because two surfaces gate on it: the web orchestrator (the inline lane
 * decides whether to carry the assistant `reasoning_content` forward) and the
 * CLI lead lane (whether a resumed session promotes its history to a structured
 * reasoning-replay seed). Keeping one implementation stops the two lanes from
 * drifting into different ideas of which routes want the replay.
 *
 * The routes that DO replay: Kimi/Moonshot (direct), and DeepSeek/Kimi/Moonshot
 * reasoning models reached through the OpenAI-compat gateways (Zen, OpenRouter,
 * HuggingFace) — the ones #1536 established silently degrade without it.
 * DeepSeek's OWN API is deliberately absent: it takes signed thinking blocks
 * over the Anthropic transport, not `reasoning_content` in the request body, and
 * 400s if that field appears in input. Callers pass the resolved provider id and
 * model as plain strings so both the web `ActiveProvider` union and the CLI
 * provider ids satisfy it without a cast.
 */
export function routeReplaysReasoningContent(
  provider: string | undefined,
  model: string | undefined,
): boolean {
  if (!provider || !model) return false;
  return (
    provider === 'kimi' ||
    ((provider === 'zen' || provider === 'openrouter' || provider === 'huggingface') &&
      /deepseek|kimi|moonshot/i.test(model))
  );
}
