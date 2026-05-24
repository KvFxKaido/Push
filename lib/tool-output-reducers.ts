// SKETCH (unwired proposal): command-aware, deterministic reducers for noisy
// sandbox_exec output. Inspired by tokenjuice's rule-driven model, but adapted
// to Push: pure functions, reduce-at-ingestion (before context fills), and
// lossless for the human — only the model-facing text is shrunk, the UI card
// keeps full stdout/stderr. Wire into app/src/lib/sandbox-tools.ts and
// cli/tools.ts; add a drift/unit test in the same PR (CLAUDE.md feature checklist).

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
  /** Which rule fired — for metrics/debugging. */
  reducerId?: string;
  savedChars: number;
}

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
  // Chains / pipes / substitution: output may already be filtered or
  // transformed downstream — reducing could corrupt meaning. Stay raw.
  if (/[|;]|&&|\|\||\$\(|`/.test(command)) return true;
  return false;
}

function parseCommand(command: string): ParsedCommand | null {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length === 0 || !tokens[0]) return null;
  const argv0 = tokens[0].split('/').pop() ?? tokens[0];
  if (FILE_READ_ARGV0.has(argv0)) return null; // exact file reads stay raw
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
    `… [${omitted} ${noun} omitted — full output in the run card; re-run with the same command for detail]`,
    ...lines.slice(lines.length - tail),
  ];
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

// ---------------------------------------------------------------------------
// Reducers (the "rules"). Add command families here.
// ---------------------------------------------------------------------------

const gitStatus: Reducer = {
  id: 'git/status',
  match: (c) => c.argv0 === 'git' && c.sub === 'status',
  reduce: (input) => {
    const lines = stripAnsi(input.stdout).split('\n');
    // Drop git's verbose hint blocks; keep branch + tracking + file entries.
    const kept = lines.filter((l) => !/^\s*\(use /.test(l));
    const branch = kept.filter((l) => /^(On branch|Your branch|HEAD detached)/.test(l));
    const files = kept.filter((l) => /^(\s+|\?\?|[ MADRCU]{1,2}\s)/.test(l) && l.trim());
    const summarizedFiles = headTail(files, 10, 5, 'changed paths');
    const out = [...branch, ...summarizedFiles].filter(Boolean).join('\n');
    return { stdout: out || input.stdout, stderr: input.stderr };
  },
};

const inventory: Reducer = {
  id: 'filesystem/inventory',
  match: (c) =>
    (c.argv0 === 'find' || c.argv0 === 'fd' || c.argv0 === 'ls') ||
    (c.argv0 === 'rg' && /(^|\s)(--files|-l|--files-with-matches)(\s|$)/.test(c.raw)) ||
    (c.argv0 === 'git' && c.sub === 'ls-files'),
  reduce: (input) => {
    const lines = stripAnsi(input.stdout).split('\n').filter((l) => l.trim());
    if (lines.length <= 40) return { stdout: input.stdout, stderr: input.stderr };
    const summary = [`[${lines.length} entries]`, ...headTail(lines, 20, 10, 'entries')];
    return { stdout: summary.join('\n'), stderr: input.stderr };
  },
};

const checkRunner: Reducer = {
  id: 'check/test-typecheck-lint',
  // tsc, eslint, vitest, jest, pytest, and the npm/pnpm/yarn wrappers around them.
  match: (c) =>
    ['tsc', 'tsgo', 'eslint', 'biome', 'vitest', 'jest', 'pytest', 'mypy', 'ruff'].includes(c.argv0) ||
    (['npm', 'pnpm', 'yarn', 'npx'].includes(c.argv0) && /\b(test|lint|typecheck|check)\b/.test(c.raw)),
  reduce: (input, failed) => {
    if (failed) {
      // On failure, signal lives in the errors — keep error/warn lines + the
      // summary, drop passing-test chatter. Never silently eat the failure.
      const merged = `${stripAnsi(input.stdout)}\n${stripAnsi(input.stderr)}`.split('\n');
      const errs = merged.filter((l) =>
        /(error|fail|✕|✗|FAIL|✖|warning)\b/i.test(l) || /\b\d+ (passed|failed|errors?|warnings?)\b/i.test(l),
      );
      const counters = countFacts(merged, {
        errors: /\berror\b/i,
        warnings: /\bwarning\b/i,
        failed: /\b(fail|✕|✗|✖)\b/i,
      });
      const kept = headTail(errs, 25, 10, 'diagnostic lines');
      return { stdout: [factLine(counters), ...kept].filter(Boolean).join('\n'), stderr: '' };
    }
    // Success: the model rarely needs the per-test log — keep the tail summary.
    const lines = stripAnsi(input.stdout).split('\n').filter((l) => l.trim());
    return { stdout: headTail(lines, 3, 8, 'passing lines').join('\n'), stderr: input.stderr };
  },
};

const REDUCERS: Reducer[] = [gitStatus, inventory, checkRunner];

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
// Entry point.
// ---------------------------------------------------------------------------

export function reduceToolOutput(input: ReducerInput): ReducedOutput {
  const noChange: ReducedOutput = {
    stdout: input.stdout,
    stderr: input.stderr,
    reduced: false,
    savedChars: 0,
  };

  if (isUnsafeToReduce(input.command)) return noChange;
  const parsed = parseCommand(input.command);
  if (!parsed) return noChange;

  const reducer = REDUCERS.find((r) => r.match(parsed));
  if (!reducer) return noChange;

  const failed = input.exitCode !== 0;
  const result = reducer.reduce(input, failed);

  const before = input.stdout.length + input.stderr.length;
  const after = result.stdout.length + result.stderr.length;
  const savedChars = before - after;

  // Passthrough if the win is marginal (tokenjuice SMALL_OUTPUT_PASSTHROUGH).
  if (savedChars < MIN_SAVED_CHARS || after / Math.max(before, 1) > MAX_KEPT_RATIO) {
    return noChange;
  }

  return { ...result, reduced: true, reducerId: reducer.id, savedChars };
}
