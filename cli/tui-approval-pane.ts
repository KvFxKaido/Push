/**
 * tui-approval-pane.ts — Approval prompt as a self-contained Pane.
 *
 * Encapsulates render + key handling for the high-risk command approval
 * modal. The pane closes over its action callbacks at construction; the
 * call site is responsible for tearing it down (clearing the slot) when
 * the underlying approval state goes away.
 */

import { wordWrap } from './tui-renderer.js';
import { renderCenteredModalBox, type Pane } from './tui-widgets.js';
import type { Theme } from './tui-theme.js';
import type { ParsedKey } from './tui-input.js';

export interface ApprovalPayload {
  kind: string;
  summary: string;
  suggestedPrefix?: string | null;
}

export interface ApprovalActions {
  approve(): void;
  alwaysApprove(): void;
  /** May trigger async work; pane fires-and-forgets. */
  persistPrefix(): void;
  deny(): void;
}

export function createApprovalPane(payload: ApprovalPayload, actions: ApprovalActions): Pane {
  return {
    render(buf, rows, cols, theme: Theme) {
      const modalWidth = Math.min(60, cols - 8);
      const lines: string[] = [
        theme.bold(theme.style('state.warn', '  Approval Required')),
        '',
        `  ${theme.style('fg.secondary', 'kind:')} ${theme.style('fg.primary', payload.kind || 'exec')}`,
        `  ${theme.style('fg.secondary', 'detail:')}`,
      ];

      const summaryLines = wordWrap(payload.summary || '', modalWidth - 6);
      for (const sl of summaryLines) {
        lines.push(`    ${theme.style('fg.primary', sl)}`);
      }

      if (payload.suggestedPrefix) {
        lines.push('');
        lines.push(
          `  ${theme.style('fg.secondary', 'prefix:')} ${theme.style('fg.primary', payload.suggestedPrefix)}`,
        );
      }

      lines.push('');
      lines.push(
        `  ${theme.style('accent.link', 'Ctrl+Y / y')} approve  ` +
          `${theme.style('accent.link', 'a')} always  ` +
          `${theme.style('accent.link', 'p')} save-prefix  ` +
          `${theme.style('accent.link', 'Ctrl+N / n')} deny  ` +
          `${theme.style('accent.link', 'Esc')} close`,
      );

      renderCenteredModalBox(buf, theme, rows, cols, modalWidth, lines);
    },

    handleKey(key: ParsedKey) {
      // Approval is a hard-modal: every key is consumed while the prompt is
      // open so unrelated global keybinds (composer typing, cancel, exit)
      // can't fire underneath it. Only the explicit shortcuts below trigger
      // an action; everything else is silently swallowed.
      if (key.ctrl && key.name === 'y') {
        actions.approve();
        return true;
      }
      if (key.ctrl && key.name === 'n') {
        actions.deny();
        return true;
      }
      if (key.ctrl || key.meta) return true;
      switch (key.name) {
        case 'y':
          actions.approve();
          return true;
        case 'a':
          actions.alwaysApprove();
          return true;
        case 'p':
          actions.persistPrefix();
          return true;
        case 'n':
        case 'escape':
          actions.deny();
          return true;
        default:
          return true;
      }
    },
  };
}
