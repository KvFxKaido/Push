/**
 * tui-focus.ts — Focus-stack key routing for the Push TUI.
 * Zero dependencies beyond sibling types.
 *
 * Borrowed (pattern, not code) from giggles' focus/keybinding model: each
 * focus scope *owns its keys* and the dispatcher walks active scopes
 * highest-priority-first, letting unconsumed keys fall through to the next
 * scope and ultimately to the global keybind map. This replaces the
 * hand-maintained `if (runState === …) … switch (getActiveOverlayModal()) …`
 * cascade in `tui.ts` with an ordered, inspectable, testable resolution.
 *
 * The global keybind map + composer text editing are the implicit *bottom*
 * of the stack: a `dispatch()` that returns `handledBy: null` means "no
 * scope claimed this key — fall through to global handling," preserving the
 * pre-existing precedence exactly.
 */

import type { ParsedKey } from './tui-input.js';

/**
 * A focus scope owns the keys it cares about while it is active.
 *
 * Scopes are evaluated highest-priority-first (registration order). The first
 * active scope whose `handleKey` returns `true` consumes the event and stops
 * dispatch. A *hard-modal* scope (e.g. an open picker that captures all input)
 * returns `true` for every key while active; a *soft* scope (e.g. a non-modal
 * pane that only claims a few bindings) returns `false` for keys it doesn't
 * recognize so they fall through.
 */
export interface KeyScope {
  /** Stable identifier, surfaced by `activeScope()` and dispatch results. */
  readonly id: string;
  /** Whether this scope is currently on the focus stack. */
  isActive(): boolean;
  /**
   * Handle a key.
   *  - `true`  → consumed; dispatch stops here.
   *  - `false` → not consumed; fall through to the next active scope.
   */
  handleKey(key: ParsedKey): boolean;
}

export interface FocusDispatchResult {
  /** `id` of the scope that consumed the key, or `null` if none did. */
  handledBy: string | null;
}

/**
 * Sink for a scope whose `handleKey` throws. The dispatcher never lets the
 * input loop die on a buggy scope: it surfaces the error here and stops (see
 * `dispatch`). Kept injectable so the TUI can route into its own error surface
 * (`handleAsyncError` → transcript) instead of writing to the alt-screen.
 */
export type ScopeErrorHandler = (scopeId: string, key: ParsedKey, err: unknown) => void;

export interface FocusStackOptions {
  /**
   * Called when a scope's `handleKey` throws. Defaults to a structured
   * `console.error` line; the TUI overrides it to render into the transcript.
   */
  onError?: ScopeErrorHandler;
}

const defaultOnError: ScopeErrorHandler = (scopeId, _key, err) => {
  // Structured, single-line (symmetric-logging convention). Default sink for
  // the generic primitive / tests; the TUI injects a display-safe sink.
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'focus_scope_handle_threw',
      scopeId,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
};

/**
 * Ordered focus stack. Scopes registered earlier have higher priority (top of
 * stack). `dispatch()` walks active scopes top-down; the first to return `true`
 * consumes the key. Anything left unconsumed returns `handledBy: null` so the
 * caller can run its global handling (keybind map + composer editing), which is
 * the implicit bottom of the stack.
 */
export class FocusStack {
  private readonly scopes: KeyScope[] = [];
  private readonly onError: ScopeErrorHandler;

  constructor(options: FocusStackOptions = {}) {
    this.onError = options.onError ?? defaultOnError;
  }

  /** Register a scope. Earlier registrations win on conflict. */
  register(scope: KeyScope): this {
    if (this.scopes.some((s) => s.id === scope.id)) {
      throw new Error(`FocusStack: duplicate scope id "${scope.id}"`);
    }
    this.scopes.push(scope);
    return this;
  }

  /**
   * Walk active scopes highest-priority-first; the first to consume the key
   * wins. Returns the consuming scope's id, or `null` for fall-through.
   */
  dispatch(key: ParsedKey): FocusDispatchResult {
    for (const scope of this.scopes) {
      if (!scope.isActive()) continue;
      let consumed: boolean;
      try {
        consumed = scope.handleKey(key);
      } catch (err) {
        // A scope that throws must not crash the input loop, and must not
        // leak the key to lower-priority scopes — a thrown hard-modal handler
        // falling through to the composer would be a worse bug than a no-op.
        // Surface the error and treat the key as consumed by the failing scope.
        this.onError(scope.id, key, err);
        return { handledBy: scope.id };
      }
      if (consumed) return { handledBy: scope.id };
    }
    return { handledBy: null };
  }

  /** The id of the topmost active scope, or `null`. Useful for status/debug. */
  activeScope(): string | null {
    for (const scope of this.scopes) {
      if (scope.isActive()) return scope.id;
    }
    return null;
  }

  /** Registered scope ids, top-of-stack first. Test/introspection helper. */
  scopeIds(): string[] {
    return this.scopes.map((s) => s.id);
  }
}
