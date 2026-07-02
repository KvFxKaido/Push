/**
 * Push-native command-safety rules layered on top of the Codex-derived
 * shell parser and known-safe/known-dangerous classifiers in
 * ./codex-derived/command-safety.ts.
 *
 * The git-mutation guards and find/rg high-risk escalation below have no
 * upstream Codex counterpart: Codex's own dangerous-command classifier only
 * flags `rm -f`/`-rf` and unwraps `sudo`/`doas`. Everything else here (git
 * reset/clean/push/checkout/restore, find -delete-class options, rg
 * --pre-class options as *dangerous* rather than merely not-safe) is Push's
 * own policy, expressed with the shared parser and git-subcommand-finder
 * imported from the codex-derived module below.
 */

import {
  executableNameLookupKey,
  extractShellScript,
  findGitSubcommand,
  isDangerousRmInvocation,
  isKnownSafeReadOnlyCommand,
  isSinglePlainCommand,
  parsePlainCommandSequence,
  shortOptionIncludes,
  splitShellWords,
  UNSAFE_FIND_OPTIONS,
  UNSAFE_RG_OPTIONS_WITH_ARGS,
} from './codex-derived/command-safety.ts';
import { classifyGitArgv, type GitDecision } from './git/policy.ts';

export {
  isKnownSafeReadOnlyCommand,
  isSinglePlainCommand,
  parsePlainCommandSequence,
  splitShellWords,
};

const RAW_DANGEROUS_PATTERNS = [
  /\brm\b[^;&|\n]*\s(?:-[^\s-]*f[^\s]*|--force)(?=\s|$|[<>])/,
  /\bfind\b[^;&|\n]*(?:^|\s)(?:-exec|-execdir|-ok|-okdir|-delete|-fls|-fprint|-fprint0|-fprintf)(?=\s|$|[<>])/,
  /\brg\b[^;&|\n]*\s(?:--pre|--hostname-bin)(?:=|\s|$)/,
  /\bgit\b[^;&|\n]*\breset\b[^;&|\n]*\s--hard(?=\s|$|[<>])/,
  /\bgit\b[^;&|\n]*\bclean\b[^;&|\n]*\s(?:-[^\s-]*f[^\s]*|--force)(?=\s|$|[<>])/,
  /\bgit\b[^;&|\n]*\bpush\b[^;&|\n]*\s(?:-f|--force|--force-with-lease)(?:=|\s|$)/,
  /\bgit\b[^;&|\n]*\b(?:checkout|restore)\b[^;&|\n]*(?:^|\s)\.(?=\s|$|[<>])/,
];

function rawCommandMightBeDangerous(command: string): boolean {
  return RAW_DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
}

const ELEVATION_OPTION_VALUE_ARGS = new Set([
  '-u',
  '--user',
  '-g',
  '--group',
  '-h',
  '--host',
  '-p',
  '--prompt',
  '-C',
  '--close-from',
  '-T',
  '--command-timeout',
  '-D',
  '--chdir',
  '-a',
  '--auth-type',
  '--config',
]);

const ELEVATION_OPTION_VALUE_PREFIXES = Array.from(ELEVATION_OPTION_VALUE_ARGS)
  .filter((option) => option.startsWith('--'))
  .map((option) => `${option}=`);

const ELEVATION_SHORT_OPTIONS_WITH_VALUE = new Set(['u', 'g', 'h', 'p', 'C', 'T', 'D', 'a']);

function unwrapElevatedCommand(command: string[]): string[] | null {
  const executable = executableNameLookupKey(command[0] ?? '');
  if (executable !== 'sudo' && executable !== 'doas') return null;

  let index = 1;
  while (index < command.length) {
    const arg = command[index];
    if (!arg) break;
    if (arg === '--') {
      index += 1;
      break;
    }
    if (!arg.startsWith('-') || arg === '-') break;

    if (ELEVATION_OPTION_VALUE_ARGS.has(arg)) {
      index += 2;
      continue;
    }
    if (ELEVATION_OPTION_VALUE_PREFIXES.some((prefix) => arg.startsWith(prefix))) {
      index += 1;
      continue;
    }

    const attachedValueShort = Array.from(ELEVATION_SHORT_OPTIONS_WITH_VALUE).some(
      (option) => arg.startsWith(`-${option}`) && arg.length > 2,
    );
    if (attachedValueShort) {
      index += 1;
      continue;
    }

    const shortCluster = /^-[A-Za-z]+$/.test(arg) ? arg.slice(1) : '';
    if (shortCluster) {
      const valueOptionIndex = Array.from(shortCluster).findIndex((option) =>
        ELEVATION_SHORT_OPTIONS_WITH_VALUE.has(option),
      );
      if (valueOptionIndex >= 0) {
        index += valueOptionIndex === shortCluster.length - 1 ? 2 : 1;
        continue;
      }
    }

    index += 1;
  }

  const unwrapped = command.slice(index);
  return unwrapped.length > 0 ? unwrapped : null;
}

function isDangerousGitCommand(command: string[]): boolean {
  const match = findGitSubcommand(command, ['reset', 'clean', 'push', 'checkout', 'restore']);
  if (!match) return false;
  const args = command.slice(match.index + 1);

  if (match.subcommand === 'reset') return args.includes('--hard');
  if (match.subcommand === 'clean') {
    return args.some((arg) => shortOptionIncludes(arg, 'f') || arg === '--force');
  }
  if (match.subcommand === 'push') {
    return args.some(
      (arg) =>
        arg === '-f' ||
        arg === '--force' ||
        arg.startsWith('--force=') ||
        arg === '--force-with-lease' ||
        arg.startsWith('--force-with-lease='),
    );
  }
  if (match.subcommand === 'checkout' || match.subcommand === 'restore') {
    return args.some((arg) => arg === '.');
  }

  return false;
}

function isDangerousToCallWithExec(command: string[]): boolean {
  const cmd0 = command[0];
  if (!cmd0) return false;

  const executable = executableNameLookupKey(cmd0);

  const elevatedCommand = unwrapElevatedCommand(command);
  if (elevatedCommand) {
    return isDangerousToCallWithExec(elevatedCommand);
  }

  if (isDangerousRmInvocation(command)) return true;

  if (executable === 'find') {
    return command.some((arg) => UNSAFE_FIND_OPTIONS.has(arg));
  }

  if (executable === 'rg') {
    return command.some((arg) => {
      return UNSAFE_RG_OPTIONS_WITH_ARGS.some(
        (option) => arg === option || arg.startsWith(`${option}=`),
      );
    });
  }

  if (executable === 'git') return isDangerousGitCommand(command);

  return false;
}

function commandWordsMightBeDangerous(command: string[]): boolean {
  if (isDangerousToCallWithExec(command)) return true;

  const shellScript = extractShellScript(command);
  if (!shellScript) return false;
  const nestedCommands = parsePlainCommandSequence(shellScript);
  if (Array.isArray(nestedCommands)) {
    return nestedCommands.some((nestedCommand) => isDangerousToCallWithExec(nestedCommand));
  }
  return rawCommandMightBeDangerous(shellScript);
}

export function commandMightBeDangerous(command: string): boolean {
  const commands = parsePlainCommandSequence(command);
  if (Array.isArray(commands)) return commands.some((words) => commandWordsMightBeDangerous(words));
  return rawCommandMightBeDangerous(command);
}

function gitDecisionRequiresApproval(decision: GitDecision): boolean {
  return decision.kind === 'block' || decision.kind === 'route';
}

function commandWordsRequireGitFlowApproval(command: string[]): boolean {
  const cmd0 = command[0];
  if (!cmd0) return false;

  const executable = executableNameLookupKey(cmd0);

  const elevatedCommand = unwrapElevatedCommand(command);
  if (elevatedCommand) {
    return commandWordsRequireGitFlowApproval(elevatedCommand);
  }

  if (executable === 'git') {
    return gitDecisionRequiresApproval(classifyGitArgv(command));
  }

  const shellScript = extractShellScript(command);
  if (!shellScript) return false;
  const nestedCommands = parsePlainCommandSequence(shellScript);
  return (
    Array.isArray(nestedCommands) &&
    nestedCommands.some((nestedCommand) => commandWordsRequireGitFlowApproval(nestedCommand))
  );
}

/**
 * Approval-level policy: true when a command either performs a destructive
 * operation or tries to use a raw git operation that Push routes/blocks on the
 * `sandbox_exec` path (commit, push, branch create/switch, merge/rebase,
 * remote-identity rewrites, etc.).
 *
 * This intentionally sits above `commandMightBeDangerous`: not every routed git
 * operation is destructive, but all of them need an explicit approval boundary
 * when issued as a free-form CLI exec command.
 */
export function commandRequiresApproval(command: string): boolean {
  if (commandMightBeDangerous(command)) return true;
  const commands = parsePlainCommandSequence(command);
  return (
    Array.isArray(commands) && commands.some((words) => commandWordsRequireGitFlowApproval(words))
  );
}
