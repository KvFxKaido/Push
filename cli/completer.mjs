// Tab-completion factory for the interactive REPL.
// Separate file for testability — pure function with injected deps.

import { RESERVED_COMMANDS } from './skill-loader.mjs';

/**
 * Creates a readline-compatible completer function.
 *
 * @param {{ providerConfig: { id: string } }} deps.ctx  Mutable runtime context
 * @param {Map<string, any>} deps.skills                 Loaded skill map
 * @param {(id: string) => string[]} deps.getCuratedModels
 * @param {() => Array<{ id: string }>} deps.getProviderList
 * @returns {(line: string) => [string[], string]}
 */
export function createCompleter({ ctx, skills, getCuratedModels, getProviderList }) {
  return (line) => {
    // Only complete slash commands
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

    // Skill args, unknown commands — no completion
    return [[], arg];
  };
}
