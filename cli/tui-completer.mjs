/**
 * tui-completer.mjs — Tab completion state machine for Push TUI.
 *
 * Three states:
 *   inactive  — no candidates (text doesn't start with / or no matches)
 *   preview   — candidates visible as user types, none selected (index === -1)
 *   cycling   — Tab pressed, actively cycling through candidates (index >= 0)
 *
 * suggest() is called from the render path on every frame — cheap and idempotent.
 * tab() enters/advances cycling mode. reset() exits cycling so next suggest() refreshes.
 */

import { RESERVED_COMMANDS } from './skill-loader.mjs';
import { extractAtReferenceCompletionTarget, listReferencePathCompletionsSync } from './path-completion.mjs';

/**
 * @param {{ providerConfig: { id: string } }} deps.ctx  Mutable runtime context
 * @param {Map<string, any>} deps.skills                 Loaded skill map
 * @param {(id: string) => string[]} deps.getCuratedModels
 * @param {() => Array<{ id: string }>} deps.getProviderList
 * @param {string} [deps.workspaceRoot]
 * @param {(workspaceRoot: string, fragment: string) => string[]} [deps.getPathCompletions]
 * @param {string[]} [deps.extraCommands]
 */
export function createTabCompleter({ ctx, skills, getCuratedModels, getProviderList, workspaceRoot, getPathCompletions, extraCommands = [] }) {
  let candidates = null; // string[] | null — resolved candidate list
  let index = -1;        // -1 = preview, >= 0 = cycling
  let lastResolvedText = null;
  let lastResolvedCandidates = null;
  const pathCompleter = getPathCompletions ?? listReferencePathCompletionsSync;

  /** Resolve candidates for the given text (mirrors completer.mjs logic). */
  function resolve(text) {
    if (text === lastResolvedText && Array.isArray(lastResolvedCandidates)) {
      return lastResolvedCandidates;
    }

    if (workspaceRoot) {
      const target = extractAtReferenceCompletionTarget(text);
      if (target) {
        const prefix = text.slice(0, target.start);
        const suffix = text.slice(target.end);
        const pathHits = pathCompleter(workspaceRoot, target.fragment);
        const resolved = pathHits.map((p) => `${prefix}@${p}${suffix}`);
        lastResolvedText = text;
        lastResolvedCandidates = resolved;
        return resolved;
      }
    }

    if (!text.startsWith('/')) {
      lastResolvedText = text;
      lastResolvedCandidates = [];
      return [];
    }

    const spaceIdx = text.indexOf(' ');

    if (spaceIdx === -1) {
      // Completing command/skill name: /mo → /model
      const commandNames = [...new Set([...RESERVED_COMMANDS, ...extraCommands])];
      const all = [
        ...commandNames.map(c => '/' + c + ' '),
        ...[...skills.keys()].map(s => '/' + s + ' '),
      ];
      const resolved = all.filter(c => c.startsWith(text));
      lastResolvedText = text;
      lastResolvedCandidates = resolved;
      return resolved;
    }

    // Completing argument after "/command "
    const cmd = text.slice(1, spaceIdx);
    const arg = text.slice(spaceIdx + 1);
    const prefix = text.slice(0, spaceIdx + 1);

    if (cmd === 'model') {
      const models = getCuratedModels(ctx.providerConfig.id);
      const resolved = models.filter(m => m.startsWith(arg)).map(m => prefix + m);
      lastResolvedText = text;
      lastResolvedCandidates = resolved;
      return resolved;
    }

    if (cmd === 'provider') {
      const ids = getProviderList().map(p => p.id);
      const resolved = ids.filter(p => p.startsWith(arg)).map(p => prefix + p);
      lastResolvedText = text;
      lastResolvedCandidates = resolved;
      return resolved;
    }

    if (cmd === 'session') {
      if (arg.startsWith('rename ')) {
        const clearArg = 'rename --clear';
        const resolved = clearArg.startsWith(arg) ? [prefix + clearArg] : [];
        lastResolvedText = text;
        lastResolvedCandidates = resolved;
        return resolved;
      }
      const subs = ['rename '];
      const resolved = subs.filter(s => s.startsWith(arg)).map(s => prefix + s);
      lastResolvedText = text;
      lastResolvedCandidates = resolved;
      return resolved;
    }

    if (cmd === 'skills') {
      const subs = ['reload'];
      const resolved = subs.filter(s => s.startsWith(arg)).map(s => prefix + s);
      lastResolvedText = text;
      lastResolvedCandidates = resolved;
      return resolved;
    }

    if (cmd === 'debug') {
      const subs = ['runtime'];
      const resolved = subs.filter(s => s.startsWith(arg)).map(s => prefix + s);
      lastResolvedText = text;
      lastResolvedCandidates = resolved;
      return resolved;
    }

    if (cmd === 'config') {
      const parts = arg.split(' ');
      if (parts.length <= 1) {
        // First arg: subcommand
        const subs = ['key', 'url', 'tavily', 'sandbox'];
        const resolved = subs.filter(s => s.startsWith(arg)).map(s => prefix + s + ' ');
        lastResolvedText = text;
        lastResolvedCandidates = resolved;
        return resolved;
      }
      const sub = parts[0];
      const rest = parts.slice(1).join(' ');
      const subPrefix = prefix + sub + ' ';
      if (sub === 'key') {
        // Second arg: optional provider name
        const ids = getProviderList().map(p => p.id);
        const resolved = ids.filter(p => p.startsWith(rest)).map(p => subPrefix + p + ' ');
        lastResolvedText = text;
        lastResolvedCandidates = resolved;
        return resolved;
      }
      if (sub === 'sandbox') {
        const opts = ['on', 'off'];
        const resolved = opts.filter(o => o.startsWith(rest)).map(o => subPrefix + o);
        lastResolvedText = text;
        lastResolvedCandidates = resolved;
        return resolved;
      }
      lastResolvedText = text;
      lastResolvedCandidates = [];
      return [];
    }

    lastResolvedText = text;
    lastResolvedCandidates = [];
    return [];
  }

  /**
   * Live-suggest candidates for the current text.
   * Called from the render path — cheap, idempotent.
   * Does NOT enter cycling mode; just refreshes the preview list.
   * Skipped when already cycling (Tab owns the state).
   */
  function suggest(text) {
    if (index >= 0) return; // cycling — don't override

    const resolved = resolve(text);
    if (resolved.length === 0) {
      candidates = null;
      return;
    }
    candidates = resolved;
    // index stays -1 (preview mode)
  }

  /**
   * Handle a Tab press. Enters cycling mode or advances to next candidate.
   * @param {string} text   Current composer text (used if no pre-resolved candidates)
   * @param {boolean} reverse  true for Shift+Tab (backward cycling)
   */
  function tab(text, reverse = false) {
    if (candidates === null) {
      // No pre-resolved candidates — resolve now
      candidates = resolve(text);
      if (candidates.length === 0) {
        candidates = null;
        return null;
      }
    }

    if (index < 0) {
      // Entering cycling mode (from preview or fresh resolve)
      index = reverse ? candidates.length - 1 : 0;
    } else {
      // Already cycling — advance
      if (reverse) {
        index = (index - 1 + candidates.length) % candidates.length;
      } else {
        index = (index + 1) % candidates.length;
      }
    }

    return { text: candidates[index], index, total: candidates.length };
  }

  /** Reset cycling state. Next render's suggest() will re-resolve from current text. */
  function reset() {
    candidates = null;
    index = -1;
    lastResolvedText = null;
    lastResolvedCandidates = null;
  }

  /** Whether candidates are visible (preview or cycling). */
  function isActive() {
    return candidates !== null;
  }

  /** Hint string for the composer border, e.g. "Tab 1/4". Only during cycling. */
  function getHint() {
    if (!candidates || index < 0) return null;
    return `Tab ${index + 1}/${candidates.length}`;
  }

  /**
   * Snapshot of completion state for rendering.
   * Returns { items: string[], index: number } or null when inactive.
   * index is -1 in preview mode (no selection), >= 0 when cycling.
   */
  function getState() {
    if (!candidates) return null;
    // Extract display labels: for "/model foo" → "foo", for "/help " → "/help"
    const items = candidates.map(c => {
      if (!c.startsWith('/')) {
        const target = extractAtReferenceCompletionTarget(c);
        return target ? target.token : c;
      }
      const trimmed = c.trimEnd();
      const sp = trimmed.indexOf(' ');
      if (sp === -1) return trimmed;        // bare command (shouldn't happen, but safe)
      const cmd = trimmed.slice(0, sp);
      const arg = trimmed.slice(sp + 1);
      return arg || cmd;                     // show arg if present, else command
    });
    return { items, index };
  }

  return { tab, suggest, reset, isActive, getHint, getState };
}
