// Tab-completion factory for the interactive REPL.
// Separate file for testability — pure function with injected deps.

import { RESERVED_COMMANDS } from './skill-loader.mjs';
import { extractAtReferenceCompletionTarget, listReferencePathCompletionsSync } from './path-completion.mjs';

/**
 * Creates a readline-compatible completer function.
 *
 * @param {{ providerConfig: { id: string } }} deps.ctx  Mutable runtime context
 * @param {Map<string, any>} deps.skills                 Loaded skill map
 * @param {(id: string) => string[]} deps.getCuratedModels
 * @param {() => Array<{ id: string }>} deps.getProviderList
 * @param {string} [deps.workspaceRoot]                    Workspace root for @file completion
 * @param {(workspaceRoot: string, fragment: string) => string[]} [deps.getPathCompletions]
 * @returns {(line: string) => [string[], string]}
 */
export function createCompleter({ ctx, skills, getCuratedModels, getProviderList, workspaceRoot, getPathCompletions }) {
  const pathCompleter = getPathCompletions ?? listReferencePathCompletionsSync;

  return (line) => {
    if (workspaceRoot) {
      const target = extractAtReferenceCompletionTarget(line);
      if (target) {
        const hits = pathCompleter(workspaceRoot, target.fragment).map((p) => `@${p}`);
        if (hits.length > 0) {
          return [hits, target.token];
        }
      }
    }

    // Only complete slash commands (non-@ path completion handled above)
    if (!line.startsWith('/')) return [[], line];

    const spaceIdx = line.indexOf(' ');

    if (spaceIdx === -1) {
      // Completing the command/skill name: /he → /help
      const all = [
        ...[...RESERVED_COMMANDS].map(c => '/' + c),
        ...[...skills.keys()].map(s => '/' + s),
      ];
      const hits = all.filter(c => c.startsWith(line));
      return [hits, line];
    }

    // Completing an argument after "/command "
    const cmd = line.slice(1, spaceIdx);
    const arg = line.slice(spaceIdx + 1);

    if (cmd === 'model') {
      const models = getCuratedModels(ctx.providerConfig.id);
      const hits = models.filter(m => m.startsWith(arg));
      return [hits, arg];
    }

    if (cmd === 'provider') {
      const ids = getProviderList().map(p => p.id);
      const hits = ids.filter(p => p.startsWith(arg));
      return [hits, arg];
    }

    if (cmd === 'session') {
      if (arg.startsWith('rename ')) {
        const clearArg = 'rename --clear';
        const hits = clearArg.startsWith(arg) ? [clearArg] : [];
        return [hits, arg];
      }
      const subs = ['rename '];
      const hits = subs.filter(s => s.startsWith(arg));
      return [hits, arg];
    }

    if (cmd === 'skills') {
      const subs = ['reload'];
      const hits = subs.filter(s => s.startsWith(arg));
      return [hits, arg];
    }

    // Skill args, unknown commands — no completion
    return [[], arg];
  };
}
