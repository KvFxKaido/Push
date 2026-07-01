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

export {
  isKnownSafeReadOnlyCommand,
  isSinglePlainCommand,
  parsePlainCommandSequence,
  splitShellWords,
};

function isDangerousGitCommand(command: string[]): boolean {
  const match = findGitSubcommand(command, ['reset', 'clean', 'push', 'checkout', 'restore']);
  if (!match) return false;
  const args = command.slice(match.index + 1);

  if (match.subcommand === 'reset') return args.includes('--hard');
  if (match.subcommand === 'clean') {
    return args.some((arg) => shortOptionIncludes(arg, 'f') || arg === '--force');
  }
  if (match.subcommand === 'push') {
    return args.some((arg) => arg === '-f' || arg === '--force' || arg.startsWith('--force='));
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

  if (executable === 'sudo' || executable === 'doas') {
    return isDangerousToCallWithExec(command.slice(1));
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
  return (
    Array.isArray(nestedCommands) &&
    nestedCommands.some((nestedCommand) => isDangerousToCallWithExec(nestedCommand))
  );
}

export function commandMightBeDangerous(command: string): boolean {
  const commands = parsePlainCommandSequence(command);
  return Array.isArray(commands) && commands.some((words) => commandWordsMightBeDangerous(words));
}
