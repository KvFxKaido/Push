/**
 * tui-completer.ts — Tab completion state machine for Push TUI.
 *
 * Three states:
 *   inactive  — no candidates (text doesn't start with / or no matches)
 *   preview   — candidates visible as user types, none selected (index === -1)
 *   cycling   — Tab pressed, actively cycling through candidates (index >= 0)
 *
 * suggest() is called from the render path on every frame — cheap and idempotent.
 * tab() enters/advances cycling mode. reset() exits cycling so next suggest() refreshes.
 */

import { RESERVED_COMMANDS } from './skill-loader.js';
import {
  extractAtReferenceCompletionTarget,
  listReferencePathCompletionsSync,
} from './path-completion.js';
import { THEME_NAMES } from './tui-theme.js';
import { SPINNER_NAMES } from './tui-spinner.js';

export interface TabResult {
  text: string;
  index: number;
  total: number;
}

export interface CompletionState {
  items: string[];
  index: number;
}

interface ProviderConfig {
  id: string;
}

interface ProviderEntry {
  id: string;
}

interface TabCompleterDeps {
  ctx: { providerConfig: ProviderConfig };
  skills: Map<string, unknown>;
  getCuratedModels: (id: string) => string[];
  getProviderList: () => ProviderEntry[];
  workspaceRoot?: string;
  getPathCompletions?: (workspaceRoot: string, fragment: string) => string[];
  extraCommands?: string[];
}

export interface TabCompleter {
  tab: (text: string, reverse?: boolean) => TabResult | null;
  suggest: (text: string) => void;
  reset: () => void;
  isActive: () => boolean;
  getHint: () => string | null;
  getState: () => CompletionState | null;
}

export function createTabCompleter({
  ctx,
  skills,
  getCuratedModels,
  getProviderList,
  workspaceRoot,
  getPathCompletions,
  extraCommands = [],
}: TabCompleterDeps): TabCompleter {
  let candidates: string[] | null = null;
  let index: number = -1; // -1 = preview, >= 0 = cycling
  let lastResolvedText: string | null = null;
  let lastResolvedCandidates: string[] | null = null;
  const pathCompleter = getPathCompletions ?? listReferencePathCompletionsSync;

  /** Resolve candidates for the given text (mirrors completer.mjs logic). */
  function resolve(text: string): string[] {
    if (text === lastResolvedText && Array.isArray(lastResolvedCandidates)) {
      return lastResolvedCandidates;
    }

    if (workspaceRoot) {
      const target = extractAtReferenceCompletionTarget(text);
      if (target) {
        const prefix = text.slice(0, target.start);
        const suffix = text.slice(target.end);
        const pathHits = pathCompleter(workspaceRoot, target.fragment);
        const resolved = pathHits.map((p: string) => `${prefix}@${p}${suffix}`);
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
        ...commandNames.map((c: string) => '/' + c + ' '),
        ...[...skills.keys()].map((s: string) => '/' + s + ' '),
      ];
      const resolved = all.filter((c: string) => c.startsWith(text));
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
      const resolved = models
        .filter((m: string) => m.startsWith(arg))
        .map((m: string) => prefix + m);
      lastResolvedText = text;
      lastResolvedCandidates = resolved;
      return resolved;
    }

    if (cmd === 'provider') {
      const ids = getProviderList().map((p: ProviderEntry) => p.id);
      const resolved = ids.filter((p: string) => p.startsWith(arg)).map((p: string) => prefix + p);
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
      const resolved = subs.filter((s: string) => s.startsWith(arg)).map((s: string) => prefix + s);
      lastResolvedText = text;
      lastResolvedCandidates = resolved;
      return resolved;
    }

    if (cmd === 'skills') {
      const subs = ['reload'];
      const resolved = subs.filter((s: string) => s.startsWith(arg)).map((s: string) => prefix + s);
      lastResolvedText = text;
      lastResolvedCandidates = resolved;
      return resolved;
    }

    if (cmd === 'debug') {
      const subs = ['runtime'];
      const resolved = subs.filter((s: string) => s.startsWith(arg)).map((s: string) => prefix + s);
      lastResolvedText = text;
      lastResolvedCandidates = resolved;
      return resolved;
    }

    if (cmd === 'copy') {
      const subs = ['last', 'code', 'tool'];
      const resolved = subs.filter((s: string) => s.startsWith(arg)).map((s: string) => prefix + s);
      lastResolvedText = text;
      lastResolvedCandidates = resolved;
      return resolved;
    }

    if (cmd === 'theme') {
      // `/theme <name>` and `/theme set <name>` both switch live. Offer
      // subcommands and theme names as top-level options; after `set`/`preview`,
      // complete against theme names only.
      const parts = arg.split(' ');
      if (parts.length <= 1) {
        const opts = ['list', 'preview ', 'set ', ...THEME_NAMES];
        const resolved = opts
          .filter((s: string) => s.startsWith(arg))
          .map((s: string) => prefix + s);
        lastResolvedText = text;
        lastResolvedCandidates = resolved;
        return resolved;
      }
      const sub = parts[0];
      const rest = parts.slice(1).join(' ');
      const subPrefix = prefix + sub + ' ';
      if (sub === 'set' || sub === 'preview') {
        const resolved = (THEME_NAMES as readonly string[])
          .filter((t: string) => t.startsWith(rest))
          .map((t: string) => subPrefix + t);
        lastResolvedText = text;
        lastResolvedCandidates = resolved;
        return resolved;
      }
      lastResolvedText = text;
      lastResolvedCandidates = [];
      return [];
    }

    if (cmd === 'spinner') {
      const parts = arg.split(' ');
      if (parts.length <= 1) {
        const opts = ['list', 'set ', 'unpin', ...SPINNER_NAMES];
        const resolved = opts
          .filter((s: string) => s.startsWith(arg))
          .map((s: string) => prefix + s);
        lastResolvedText = text;
        lastResolvedCandidates = resolved;
        return resolved;
      }
      const sub = parts[0];
      const rest = parts.slice(1).join(' ');
      const subPrefix = prefix + sub + ' ';
      if (sub === 'set') {
        const resolved = (SPINNER_NAMES as readonly string[])
          .filter((n: string) => n.startsWith(rest))
          .map((n: string) => subPrefix + n);
        lastResolvedText = text;
        lastResolvedCandidates = resolved;
        return resolved;
      }
      lastResolvedText = text;
      lastResolvedCandidates = [];
      return [];
    }

    if (cmd === 'config') {
      const parts = arg.split(' ');
      if (parts.length <= 1) {
        // First arg: subcommand
        const subs = ['key', 'url', 'tavily', 'sandbox'];
        const resolved = subs
          .filter((s: string) => s.startsWith(arg))
          .map((s: string) => prefix + s + ' ');
        lastResolvedText = text;
        lastResolvedCandidates = resolved;
        return resolved;
      }
      const sub = parts[0];
      const rest = parts.slice(1).join(' ');
      const subPrefix = prefix + sub + ' ';
      if (sub === 'key') {
        // Second arg: optional provider name
        const ids = getProviderList().map((p: ProviderEntry) => p.id);
        const resolved = ids
          .filter((p: string) => p.startsWith(rest))
          .map((p: string) => subPrefix + p + ' ');
        lastResolvedText = text;
        lastResolvedCandidates = resolved;
        return resolved;
      }
      if (sub === 'sandbox') {
        const opts = ['on', 'off'];
        const resolved = opts
          .filter((o: string) => o.startsWith(rest))
          .map((o: string) => subPrefix + o);
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
  function suggest(text: string): void {
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
   */
  function tab(text: string, reverse: boolean = false): TabResult | null {
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
  function reset(): void {
    candidates = null;
    index = -1;
    lastResolvedText = null;
    lastResolvedCandidates = null;
  }

  /** Whether candidates are visible (preview or cycling). */
  function isActive(): boolean {
    return candidates !== null;
  }

  /** Hint string for the composer border, e.g. "Tab 1/4". Only during cycling. */
  function getHint(): string | null {
    if (!candidates || index < 0) return null;
    return `Tab ${index + 1}/${candidates.length}`;
  }

  /**
   * Snapshot of completion state for rendering.
   * Returns { items: string[], index: number } or null when inactive.
   * index is -1 in preview mode (no selection), >= 0 when cycling.
   */
  function getState(): CompletionState | null {
    if (!candidates) return null;
    // Extract display labels: for "/model foo" → "foo", for "/help " → "/help"
    const items = candidates.map((c: string) => {
      if (!c.startsWith('/')) {
        const target = extractAtReferenceCompletionTarget(c);
        return target ? target.token : c;
      }
      const trimmed = c.trimEnd();
      const sp = trimmed.indexOf(' ');
      if (sp === -1) return trimmed; // bare command (shouldn't happen, but safe)
      const cmd = trimmed.slice(0, sp);
      const arg = trimmed.slice(sp + 1);
      return arg || cmd; // show arg if present, else command
    });
    return { items, index };
  }

  return { tab, suggest, reset, isActive, getHint, getState };
}
