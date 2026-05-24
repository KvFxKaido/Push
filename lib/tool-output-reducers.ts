// Command-aware, deterministic reducers for noisy exec output. Inspired by
// tokenjuice's rule-driven model, adapted to Push: pure functions, reduce at
// ingestion (before context fills), and lossless for the human — callers feed
// only the model-facing text through here and keep the raw stdout/stderr for
// the UI card / session store. See lib/tool-output-reducers.test.ts.
//
// Hard boundaries (enforced by reduceToolOutput, asserted in the test):
//   - Reduces only the text it is given; exit code / failure semantics live in
//     the caller's formatting and are never touched here.
//   - Unsafe or ambiguous command shapes (pipes, chains, substitution, raw file
//     reads) bail out and return the input unchanged.
//   - Small wins pass through unchanged to protect prompt-cache stability.

export interface ReducerInput {
  /** Raw command string, e.g. call.args.command. */
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ReducedOutput {
  stdout: string;
  stderr: string;
  /** True if anything actually changed. */
  reduced: boolean;
  /** Which rule fired — only set when reduced. */
  reducerId?: string;
  originalChars: number;
  reducedChars: number;
  savedChars: number;
  /** Why no reduction happened (passthrough) — undefined when reduced. */
  reason?: PassthroughReason;
}

export type PassthroughReason =
  | 'unsafe-command'
  | 'unparseable-command'
  | 'file-read'
  | 'no-matching-rule'
  | 'below-threshold';

interface ParsedCommand {
  argv0: string; // basename of program, e.g. "git", "pnpm", "tsc"
  sub?: string; // first non-flag subcommand, e.g. "status"
  raw: string;
}

interface Reducer {
  id: string;
  match: (cmd: ParsedCommand) => boolean;
  /** Operate on raw streams. `failed` = non-zero exit (preserve more). */
  reduce: (input: ReducerInput, failed: boolean) => { stdout: string; stderr: string };
}

// Mirror of tokenjuice's SMALL_OUTPUT_PASSTHROUGH knobs: don't bother if the
// win is marginal — churn hurts prompt-cache stability more than it saves.
const MIN_SAVED_CHARS = 200;
const MAX_KEPT_RATIO = 0.75; // keep raw unless we cut at least 25%

// ---------------------------------------------------------------------------
// Safety: when NOT to touch output (tokenjuice "safe inventory policy").
// ---------------------------------------------------------------------------

const FILE_READ_ARGV0 = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'nl', 'xxd', 'od']);

function isUnsafeToReduce(command: string): boolean {
  // Chains / pipes / substitution / redirection: output may already be filtered
  // or transformed downstream — reducing could corrupt meaning. Stay raw.
  return /[|;><]|&&|\|\||\$\(|`/.test(command);
}

function parseCommand(command: string): ParsedCommand | null {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length === 0 || !tokens[0]) return null;
  const argv0 = tokens[0].split('/').pop() ?? tokens[0];
  // First token that isn't a flag or a `-c key=val` / `-C dir` style option.
  let sub: string | undefined;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      if (argv0 === 'git' && (t === '-c' || t === '-C')) i++; // skip its value
      continue;
    }
    sub = t;
    break;
  }
  return { argv0, sub, raw: command };
}

// ---------------------------------------------------------------------------
// Primitives.
// ---------------------------------------------------------------------------

function headTail(lines: string[], head: number, tail: number, noun = 'lines'): string[] {
  if (lines.length <= head + tail + 1) return lines;
  const omitted = lines.length - head - tail;
  return [
    ...lines.slice(0, head),
    `… [${omitted} ${noun} omitted — full output in the run card; re-run the same command for detail]`,
    ...lines.slice(lines.length - tail),
  ];
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

// ---------------------------------------------------------------------------
// Counters (tokenjuice "count facts" — keep the number even when you drop lines).
// ---------------------------------------------------------------------------

function countFacts(lines: string[], patterns: Record<string, RegExp>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, re] of Object.entries(patterns)) {
    out[name] = lines.filter((l) => re.test(l)).length;
  }
  return out;
}

function factLine(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`);
  return parts.length ? `[summary: ${parts.join(', ')}]` : '';
}

// ---------------------------------------------------------------------------
// Reducers (the "rules"). Add command families here.
// ---------------------------------------------------------------------------

const gitStatus: Reducer = {
  id: 'git/status',
  match: (c) => c.argv0 === 'git' && c.sub === 'status',
  reduce: (input) => {
    const lines = stripAnsi(input.stdout).split('\n');
    // Drop git's repetitive "(use ...)" hint blocks and blank padding; keep
    // branch/tracking lines, section headers, and file entries in order.
    const kept = lines.filter((l) => l.trim().length > 0 && !/^\s*\(use /.test(l));
    return { stdout: headTail(kept, 14, 6, 'status lines').join('\n'), stderr: input.stderr };
  },
};

const inventory: Reducer = {
  id: 'filesystem/inventory',
  match: (c) =>
    c.argv0 === 'find' ||
    c.argv0 === 'fd' ||
    c.argv0 === 'ls' ||
    (c.argv0 === 'rg' && /(^|\s)(--files|-l|--files-with-matches)(\s|$)/.test(c.raw)) ||
    (c.argv0 === 'git' && c.sub === 'ls-files'),
  reduce: (input) => {
    const lines = stripAnsi(input.stdout)
      .split('\n')
      .filter((l) => l.trim());
    if (lines.length <= 40) return { stdout: input.stdout, stderr: input.stderr };
    const summary = [`[${lines.length} entries]`, ...headTail(lines, 20, 10, 'entries')];
    return { stdout: summary.join('\n'), stderr: input.stderr };
  },
};

const checkRunner: Reducer = {
  id: 'check/test-typecheck-lint',
  // tsc, eslint, vitest, jest, pytest, and the npm/pnpm/yarn wrappers around them.
  match: (c) =>
    ['tsc', 'tsgo', 'eslint', 'biome', 'vitest', 'jest', 'pytest', 'mypy', 'ruff'].includes(
      c.argv0,
    ) ||
    // npm/pnpm/yarn/npx/bun wrappers: match the task verb OR a wrapped runner
    // name (`npx vitest run` — the verb regex alone misses "vitest").
    (['npm', 'pnpm', 'yarn', 'npx', 'bun'].includes(c.argv0) &&
      /\b(test|lint|typecheck|check|vitest|jest|tsc|tsgo|eslint|biome|pytest|mypy|ruff|mocha|ava)\b/.test(
        c.raw,
      )),
  reduce: (input, failed) => {
    if (failed) {
      // On failure the signal lives in the errors — keep error/warn lines + a
      // counter summary, drop passing-test chatter. Never silently eat the
      // failure: error lines move into stdout and the caller still prints the
      // non-zero exit code.
      const merged = `${stripAnsi(input.stdout)}\n${stripAnsi(input.stderr)}`
        .split('\n')
        .filter((l) => l.trim());
      const errs = merged.filter((l) => /(error|warn|fail|✕|✗|✖)/i.test(l));
      const counters = countFacts(merged, { errors: /error/i, warnings: /warn/i });
      const kept = headTail(errs, 25, 10, 'diagnostic lines');
      return { stdout: [factLine(counters), ...kept].filter(Boolean).join('\n'), stderr: '' };
    }
    // Success: the model rarely needs the per-test log — keep head + tail summary.
    const lines = stripAnsi(input.stdout)
      .split('\n')
      .filter((l) => l.trim());
    return { stdout: headTail(lines, 3, 8, 'passing lines').join('\n'), stderr: input.stderr };
  },
};

const REDUCERS: Reducer[] = [gitStatus, inventory, checkRunner];

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export function reduceToolOutput(input: ReducerInput): ReducedOutput {
  const originalChars = input.stdout.length + input.stderr.length;
  const pass = (reason: PassthroughReason): ReducedOutput => ({
    stdout: input.stdout,
    stderr: input.stderr,
    reduced: false,
    originalChars,
    reducedChars: originalChars,
    savedChars: 0,
    reason,
  });

  if (isUnsafeToReduce(input.command)) return pass('unsafe-command');
  const parsed = parseCommand(input.command);
  if (!parsed) return pass('unparseable-command');
  if (FILE_READ_ARGV0.has(parsed.argv0)) return pass('file-read'); // exact reads stay raw

  const reducer = REDUCERS.find((r) => r.match(parsed));
  if (!reducer) return pass('no-matching-rule');

  const result = reducer.reduce(input, input.exitCode !== 0);
  const reducedChars = result.stdout.length + result.stderr.length;
  const savedChars = originalChars - reducedChars;

  // Passthrough if the win is marginal (tokenjuice SMALL_OUTPUT_PASSTHROUGH).
  if (savedChars < MIN_SAVED_CHARS || reducedChars / Math.max(originalChars, 1) > MAX_KEPT_RATIO) {
    return pass('below-threshold');
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    reduced: true,
    reducerId: reducer.id,
    originalChars,
    reducedChars,
    savedChars,
  };
}
