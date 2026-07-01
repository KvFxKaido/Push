/*
 * Portions derived from OpenAI Codex command-safety classifiers:
 * https://github.com/openai/codex
 * Inspected revision: db887d03e1f907467e33271572dffb73bceecd6b
 * Upstream paths:
 * - codex-rs/shell-command/src/command_safety/is_safe_command.rs
 * - codex-rs/shell-command/src/command_safety/is_dangerous_command.rs
 * - codex-rs/shell-command/src/bash.rs
 *
 * Scope: the shell-wrapper parser, the known-safe read-only command
 * classifier, and the known-dangerous `rm` classifier below trace directly
 * to the upstream files above (the `rm` check is generalized here to catch
 * `-f`/`--force` in any argument position rather than only the second word,
 * for defense in depth). Push-native rules that have no upstream
 * counterpart — git-mutation guards, find/rg high-risk escalation — live in
 * ../command-policy.ts (MIT), which composes on top of what's exported here.
 *
 * Copyright 2025 OpenAI
 * Modifications Copyright (c) 2026 Shawn Montgomery
 * SPDX-License-Identifier: Apache-2.0
 */

type ShellSplit = {
  segments: string[];
  sawOperator: boolean;
};

const SAFE_EXECUTABLES = new Set([
  'base64',
  'cat',
  'cd',
  'cut',
  'echo',
  'expr',
  'false',
  'grep',
  'head',
  'id',
  'ls',
  'nl',
  'numfmt',
  'paste',
  'pwd',
  'rev',
  'seq',
  'stat',
  'tac',
  'tail',
  'tr',
  'true',
  'uname',
  'uniq',
  'wc',
  'which',
  'whoami',
]);

const SHELL_EXECUTABLES = new Set(['bash', 'sh', 'zsh']);

const UNSAFE_BASE64_OPTIONS = new Set(['-o', '--output']);
export const UNSAFE_FIND_OPTIONS = new Set([
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-delete',
  '-fls',
  '-fprint',
  '-fprint0',
  '-fprintf',
]);
const UNSAFE_RG_OPTIONS_WITHOUT_ARGS = new Set(['--search-zip', '-z']);
export const UNSAFE_RG_OPTIONS_WITH_ARGS = ['--pre', '--hostname-bin'];

type GitOptionPattern =
  | { kind: 'exact'; value: string }
  | { kind: 'short-inline'; value: string }
  | { kind: 'prefix'; value: string };

const UNSAFE_GIT_GLOBAL_OPTIONS: GitOptionPattern[] = [
  { kind: 'exact', value: '-C' },
  { kind: 'short-inline', value: '-C' },
  { kind: 'exact', value: '-c' },
  { kind: 'short-inline', value: '-c' },
  { kind: 'exact', value: '-p' },
  { kind: 'exact', value: '--config-env' },
  { kind: 'prefix', value: '--config-env=' },
  { kind: 'exact', value: '--exec-path' },
  { kind: 'prefix', value: '--exec-path=' },
  { kind: 'exact', value: '--git-dir' },
  { kind: 'prefix', value: '--git-dir=' },
  { kind: 'exact', value: '--namespace' },
  { kind: 'prefix', value: '--namespace=' },
  { kind: 'exact', value: '--paginate' },
  { kind: 'exact', value: '--super-prefix' },
  { kind: 'prefix', value: '--super-prefix=' },
  { kind: 'exact', value: '--work-tree' },
  { kind: 'prefix', value: '--work-tree=' },
];

const UNSAFE_GIT_SUBCOMMAND_OPTIONS: GitOptionPattern[] = [
  { kind: 'exact', value: '--output' },
  { kind: 'prefix', value: '--output=' },
  { kind: 'exact', value: '--ext-diff' },
  { kind: 'exact', value: '--textconv' },
  { kind: 'exact', value: '--exec' },
  { kind: 'prefix', value: '--exec=' },
];

const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--config-env',
  '--exec-path',
  '--git-dir',
  '--namespace',
  '--super-prefix',
  '--work-tree',
]);

export function executableNameLookupKey(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? raw;
  const lower = base.toLowerCase();
  for (const suffix of ['.exe', '.cmd', '.bat', '.com']) {
    if (lower.endsWith(suffix)) return lower.slice(0, -suffix.length);
  }
  return base;
}

function splitTopLevelShellSegments(script: string): ShellSplit | null {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaping = false;
  let sawOperator = false;

  const pushSegment = () => {
    const trimmed = current.trim();
    if (!trimmed) return false;
    segments.push(trimmed);
    current = '';
    return true;
  };

  for (let i = 0; i < script.length; i++) {
    const ch = script[i];

    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = null;
      continue;
    }

    if (quote === '"') {
      if (ch === '`' || ch === '$') return null;
      current += ch;
      if (ch === '\\') {
        escaping = true;
      } else if (ch === '"') {
        quote = null;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === '\\') {
      current += ch;
      escaping = true;
      continue;
    }

    if (ch === '$' || ch === '`' || ch === '<' || ch === '>' || ch === '(' || ch === ')') {
      return null;
    }

    if (ch === '&') {
      if (script[i + 1] !== '&') return null;
      if (!pushSegment()) return null;
      sawOperator = true;
      i++;
      continue;
    }

    if (ch === '|') {
      if (!pushSegment()) return null;
      sawOperator = true;
      if (script[i + 1] === '|') i++;
      continue;
    }

    if (ch === ';' || ch === '\n') {
      if (!pushSegment()) return null;
      sawOperator = true;
      continue;
    }

    current += ch;
  }

  if (escaping || quote !== null) return null;
  if (!pushSegment()) return null;

  return { segments, sawOperator };
}

export function splitShellWords(segment: string): string[] | null {
  const words: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaping = false;
  let wordStarted = false;

  const pushWord = () => {
    if (!wordStarted) return;
    words.push(current);
    current = '';
    wordStarted = false;
  };

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];

    if (escaping) {
      current += ch;
      wordStarted = true;
      escaping = false;
      continue;
    }

    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      wordStarted = true;
      continue;
    }

    if (quote === '"') {
      if (ch === '`' || ch === '$') return null;
      if (ch === '\\') {
        escaping = true;
      } else if (ch === '"') {
        quote = null;
      } else {
        current += ch;
      }
      wordStarted = true;
      continue;
    }

    if (/\s/.test(ch)) {
      pushWord();
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      wordStarted = true;
      continue;
    }

    if (ch === '\\') {
      escaping = true;
      wordStarted = true;
      continue;
    }

    if ('&|;<>()`'.includes(ch) || ch === '$') {
      return null;
    }

    current += ch;
    wordStarted = true;
  }

  if (escaping || quote !== null) return null;
  pushWord();

  return words;
}

export function parsePlainCommandSequence(script: string): string[][] | null {
  if (typeof script !== 'string' || !script.trim()) return null;
  const split = splitTopLevelShellSegments(script);
  if (!split) return null;
  const commands = split.segments.map((segment) => splitShellWords(segment));
  if (commands.some((words) => !words || words.length === 0)) return null;
  return commands as string[][];
}

export function isSinglePlainCommand(command: string): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  const split = splitTopLevelShellSegments(command);
  if (!split || split.sawOperator || split.segments.length !== 1) return false;
  const words = splitShellWords(split.segments[0]);
  return Array.isArray(words) && words.length > 0;
}

export function extractShellScript(words: string[]): string | null {
  if (words.length !== 3) return null;
  const [shell, flag, script] = words;
  if (!SHELL_EXECUTABLES.has(executableNameLookupKey(shell))) return null;
  if (flag !== '-lc' && flag !== '-c') return null;
  return script;
}

function matchesGitOptionPattern(arg: string, pattern: GitOptionPattern): boolean {
  if (pattern.kind === 'exact') return arg === pattern.value;
  if (pattern.kind === 'prefix') return arg.startsWith(pattern.value);
  return arg.startsWith(pattern.value) && arg.length > pattern.value.length;
}

function gitHasUnsafeGlobalOption(globalArgs: string[]): boolean {
  return globalArgs.some((arg) =>
    UNSAFE_GIT_GLOBAL_OPTIONS.some((pattern) => matchesGitOptionPattern(arg, pattern)),
  );
}

function gitSubcommandArgsAreReadOnly(args: string[]): boolean {
  return !args.some((arg) =>
    UNSAFE_GIT_SUBCOMMAND_OPTIONS.some((pattern) => matchesGitOptionPattern(arg, pattern)),
  );
}

function isGitGlobalOptionWithInlineValue(arg: string): boolean {
  return (
    arg.startsWith('--config-env=') ||
    arg.startsWith('--exec-path=') ||
    arg.startsWith('--git-dir=') ||
    arg.startsWith('--namespace=') ||
    arg.startsWith('--super-prefix=') ||
    arg.startsWith('--work-tree=') ||
    ((arg.startsWith('-C') || arg.startsWith('-c')) && arg.length > 2)
  );
}

/**
 * Find the first matching git subcommand, skipping known global options that
 * may appear before it (e.g., `-C`, `-c`, `--git-dir`). Shared with
 * ../command-policy.ts so Push-native git rules can't be bypassed by the
 * same global-option smuggling this closes for the safe-command allowlist.
 */
export function findGitSubcommand(
  command: string[],
  subcommands: readonly string[],
): { index: number; subcommand: string } | null {
  const cmd0 = command[0];
  if (!cmd0 || executableNameLookupKey(cmd0) !== 'git') return null;

  let skipNext = false;
  for (let idx = 1; idx < command.length; idx++) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    const arg = command[idx];
    if (isGitGlobalOptionWithInlineValue(arg)) continue;
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
      skipNext = true;
      continue;
    }
    if (arg === '--' || arg.startsWith('-')) continue;
    if (subcommands.includes(arg)) return { index: idx, subcommand: arg };
    return null;
  }

  return null;
}

function gitBranchIsReadOnly(args: string[]): boolean {
  if (args.length === 0) return true;

  let sawReadOnlyFlag = false;
  for (const arg of args) {
    if (
      arg === '--list' ||
      arg === '-l' ||
      arg === '--show-current' ||
      arg === '-a' ||
      arg === '--all' ||
      arg === '-r' ||
      arg === '--remotes' ||
      arg === '-v' ||
      arg === '-vv' ||
      arg === '--verbose' ||
      arg.startsWith('--format=')
    ) {
      sawReadOnlyFlag = true;
      continue;
    }
    return false;
  }

  return sawReadOnlyFlag;
}

function isSafeGitCommand(command: string[]): boolean {
  const match = findGitSubcommand(command, ['status', 'log', 'diff', 'show', 'branch']);
  if (!match) return false;
  if (gitHasUnsafeGlobalOption(command.slice(1, match.index))) return false;

  const args = command.slice(match.index + 1);
  if (!gitSubcommandArgsAreReadOnly(args)) return false;
  if (match.subcommand === 'branch') return gitBranchIsReadOnly(args);
  return true;
}

function isValidSedPrintArg(arg: string | undefined): boolean {
  if (!arg || !arg.endsWith('p')) return false;
  const core = arg.slice(0, -1);
  const parts = core.split(',');
  if (parts.length !== 1 && parts.length !== 2) return false;
  return parts.every((part) => part.length > 0 && /^\d+$/.test(part));
}

function isSafeToCallWithExec(command: string[]): boolean {
  const cmd0 = command[0];
  if (!cmd0) return false;

  const executable = executableNameLookupKey(cmd0);

  if (SAFE_EXECUTABLES.has(executable)) {
    if (executable === 'base64') {
      return !command.slice(1).some((arg) => {
        return (
          UNSAFE_BASE64_OPTIONS.has(arg) ||
          arg.startsWith('--output=') ||
          (arg.startsWith('-o') && arg !== '-o')
        );
      });
    }

    return true;
  }

  if (executable === 'find') {
    return !command.some((arg) => UNSAFE_FIND_OPTIONS.has(arg));
  }

  if (executable === 'rg') {
    return !command.some((arg) => {
      return (
        UNSAFE_RG_OPTIONS_WITHOUT_ARGS.has(arg) ||
        UNSAFE_RG_OPTIONS_WITH_ARGS.some((option) => arg === option || arg.startsWith(`${option}=`))
      );
    });
  }

  if (executable === 'git') return isSafeGitCommand(command);

  if (executable === 'sed') {
    return command.length <= 4 && command[1] === '-n' && isValidSedPrintArg(command[2]);
  }

  return false;
}

function isKnownSafeReadOnlyWords(command: string[]): boolean {
  if (isSafeToCallWithExec(command)) return true;

  const shellScript = extractShellScript(command);
  if (!shellScript) return false;
  const nestedCommands = parsePlainCommandSequence(shellScript);
  return (
    Array.isArray(nestedCommands) &&
    nestedCommands.length > 0 &&
    nestedCommands.every((nestedCommand) => isSafeToCallWithExec(nestedCommand))
  );
}

export function isKnownSafeReadOnlyCommand(command: string): boolean {
  const commands = parsePlainCommandSequence(command);
  return (
    Array.isArray(commands) &&
    commands.length > 0 &&
    commands.every((words) => isKnownSafeReadOnlyWords(words))
  );
}

export function shortOptionIncludes(arg: string, option: string): boolean {
  return arg.startsWith('-') && !arg.startsWith('--') && arg.slice(1).includes(option);
}

/**
 * Upstream's `is_dangerous_to_call_with_exec` only ever matches `rm` (plus a
 * `sudo`/`doas` unwrap, handled by the caller in ../command-policy.ts).
 * Generalized here to scan every argument for `-f`/`--force` instead of only
 * `command[1]`, since a flag can appear anywhere (`rm file -f`, `rm -r -f`).
 */
export function isDangerousRmInvocation(command: string[]): boolean {
  const cmd0 = command[0];
  if (!cmd0 || executableNameLookupKey(cmd0) !== 'rm') return false;
  return command.slice(1).some((arg) => arg === '--force' || shortOptionIncludes(arg, 'f'));
}
