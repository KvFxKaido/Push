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

/**
 * @param {{ providerConfig: { id: string } }} deps.ctx  Mutable runtime context
 * @param {Map<string, any>} deps.skills                 Loaded skill map
 * @param {(id: string) => string[]} deps.getCuratedModels
 * @param {() => Array<{ id: string }>} deps.getProviderList
 */
export function createTabCompleter({ ctx, skills, getCuratedModels, getProviderList }) {
  let candidates = null; // string[] | null — resolved candidate list
  let index = -1;        // -1 = preview, >= 0 = cycling

  /** Resolve candidates for the given text (mirrors completer.mjs logic). */
  function resolve(text) {
    if (!text.startsWith('/')) return [];

    const spaceIdx = text.indexOf(' ');

    if (spaceIdx === -1) {
      // Completing command/skill name: /mo → /model
      const all = [
        ...[...RESERVED_COMMANDS].map(c => '/' + c + ' '),
        ...[...skills.keys()].map(s => '/' + s + ' '),
      ];
      return all.filter(c => c.startsWith(text));
    }

    // Completing argument after "/command "
    const cmd = text.slice(1, spaceIdx);
    const arg = text.slice(spaceIdx + 1);
    const prefix = text.slice(0, spaceIdx + 1);

    if (cmd === 'model') {
      const models = getCuratedModels(ctx.providerConfig.id);
      return models.filter(m => m.startsWith(arg)).map(m => prefix + m);
    }

    if (cmd === 'provider') {
      const ids = getProviderList().map(p => p.id);
      return ids.filter(p => p.startsWith(arg)).map(p => prefix + p);
    }

    if (cmd === 'session') {
      if (arg.startsWith('rename ')) {
        const clearArg = 'rename --clear';
        return clearArg.startsWith(arg) ? [prefix + clearArg] : [];
      }
      const subs = ['rename '];
      return subs.filter(s => s.startsWith(arg)).map(s => prefix + s);
    }

    if (cmd === 'skills') {
      const subs = ['reload'];
      return subs.filter(s => s.startsWith(arg)).map(s => prefix + s);
    }

    if (cmd === 'config') {
      const parts = arg.split(' ');
      if (parts.length <= 1) {
        // First arg: subcommand
        const subs = ['key', 'url', 'tavily', 'sandbox'];
        return subs.filter(s => s.startsWith(arg)).map(s => prefix + s + ' ');
      }
      const sub = parts[0];
      const rest = parts.slice(1).join(' ');
      const subPrefix = prefix + sub + ' ';
      if (sub === 'key') {
        // Second arg: optional provider name
        const ids = getProviderList().map(p => p.id);
        return ids.filter(p => p.startsWith(rest)).map(p => subPrefix + p + ' ');
      }
      if (sub === 'sandbox') {
        const opts = ['on', 'off'];
        return opts.filter(o => o.startsWith(rest)).map(o => subPrefix + o);
      }
      return [];
    }

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
