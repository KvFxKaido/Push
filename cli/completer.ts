// Tab-completion factory for the interactive REPL.
// Separate file for testability — pure function with injected deps.

import { RESERVED_COMMANDS } from './skill-loader.js';
import { extractAtReferenceCompletionTarget, listReferencePathCompletionsSync } from './path-completion.js';

export interface ProviderConfig {
  id: string;
}

export interface RuntimeContext {
  providerConfig: ProviderConfig;
}

export interface ProviderEntry {
  id: string;
}

export interface CompleterDeps {
  ctx: RuntimeContext;
  skills: Map<string, unknown>;
  getCuratedModels: (id: string) => string[];
  getProviderList: () => ProviderEntry[];
  workspaceRoot?: string;
  getPathCompletions?: (workspaceRoot: string, fragment: string) => string[];
}

export type CompleterFn = (line: string) => [string[], string];

/**
 * Creates a readline-compatible completer function.
 */
export function createCompleter({ ctx, skills, getCuratedModels, getProviderList, workspaceRoot, getPathCompletions }: CompleterDeps): CompleterFn {
  const pathCompleter: (workspaceRoot: string, fragment: string) => string[] = getPathCompletions ?? listReferencePathCompletionsSync;

  return (line: string): [string[], string] => {
    if (workspaceRoot) {
      const target: { fragment: string; token: string } | null = extractAtReferenceCompletionTarget(line);
      if (target) {
        const hits: string[] = pathCompleter(workspaceRoot, target.fragment).map((p: string) => `@${p}`);
        if (hits.length > 0) {
          return [hits, target.token];
        }
      }
    }

    // Only complete slash commands (non-@ path completion handled above)
    if (!line.startsWith('/')) return [[], line];

    const spaceIdx: number = line.indexOf(' ');

    if (spaceIdx === -1) {
      // Completing the command/skill name: /he → /help
      const all: string[] = [
        ...[...RESERVED_COMMANDS].map((c: string) => '/' + c),
        ...[...skills.keys()].map((s: string) => '/' + s),
      ];
      const hits: string[] = all.filter((c: string) => c.startsWith(line));
      return [hits, line];
    }

    // Completing an argument after "/command "
    const cmd: string = line.slice(1, spaceIdx);
    const arg: string = line.slice(spaceIdx + 1);

    if (cmd === 'model') {
      const models: string[] = getCuratedModels(ctx.providerConfig.id);
      const hits: string[] = models.filter((m: string) => m.startsWith(arg));
      return [hits, arg];
    }

    if (cmd === 'provider') {
      const ids: string[] = getProviderList().map((p: ProviderEntry) => p.id);
      const hits: string[] = ids.filter((p: string) => p.startsWith(arg));
      return [hits, arg];
    }

    if (cmd === 'session') {
      if (arg.startsWith('rename ')) {
        const clearArg: string = 'rename --clear';
        const hits: string[] = clearArg.startsWith(arg) ? [clearArg] : [];
        return [hits, arg];
      }
      const subs: string[] = ['rename '];
      const hits: string[] = subs.filter((s: string) => s.startsWith(arg));
      return [hits, arg];
    }

    if (cmd === 'skills') {
      const subs: string[] = ['reload'];
      const hits: string[] = subs.filter((s: string) => s.startsWith(arg));
      return [hits, arg];
    }

    // Skill args, unknown commands — no completion
    return [[], arg];
  };
}
