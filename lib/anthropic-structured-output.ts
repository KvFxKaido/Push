type ClaudeFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'mythos';

interface ClaudeModelVersion {
  family: ClaudeFamily;
  major: number;
  minor: number;
}

function parseClaudeModelVersion(model: string | null | undefined): ClaudeModelVersion | null {
  if (typeof model !== 'string') return null;
  const id = model.toLowerCase().trim();
  if (!id) return null;

  // Current Anthropic ids are usually `claude-sonnet-4-6` or
  // `claude-haiku-4-5-20251001`; OpenRouter/Zen catalog ids may use
  // `claude-sonnet-4.6`. Keep the minor single/double digit so dated 4.x ids
  // such as `claude-opus-4-20250514` are not misread as "4.20".
  const familyFirst = id.match(
    /claude[-.](opus|sonnet|haiku|fable|mythos)[-.](\d+)(?:[-.](\d{1,2})(?!\d))?/,
  );
  if (familyFirst) {
    return {
      family: familyFirst[1] as ClaudeFamily,
      major: Number(familyFirst[2]),
      minor: familyFirst[3] === undefined ? 0 : Number(familyFirst[3]),
    };
  }

  // Older 3.x ids put the version before the family:
  // `claude-3-5-sonnet-20241022`. They do not support native
  // `output_config.format`, but parsing them keeps the predicate explicit.
  const versionFirst = id.match(
    /claude[-.](\d+)(?:[-.](\d{1,2})(?!\d))?[-.](opus|sonnet|haiku|fable|mythos)/,
  );
  if (!versionFirst) return null;
  return {
    family: versionFirst[3] as ClaudeFamily,
    major: Number(versionFirst[1]),
    minor: versionFirst[2] === undefined ? 0 : Number(versionFirst[2]),
  };
}

/**
 * Native Anthropic JSON outputs (`output_config.format`) are available on the
 * newer Claude 4.5+ family plus Claude 5-era names. Older Claude 4.0/4.1 and
 * non-Claude Anthropic-transport routes keep using Push's forced-tool fallback.
 */
export function anthropicModelSupportsNativeStructuredOutput(
  model: string | null | undefined,
): boolean {
  const parsed = parseClaudeModelVersion(model);
  if (!parsed) return false;

  if (parsed.family === 'fable' || parsed.family === 'mythos') {
    return parsed.major >= 5;
  }
  if (parsed.major > 4) return true;
  if (parsed.major < 4) return false;
  return parsed.minor >= 5;
}
