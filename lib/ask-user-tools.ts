/**
 * Ask-user tool — lets the LLM surface a structured question card to the user.
 *
 * Pure lib-side detector: Web call sites import via `@push/lib/ask-user-tools`
 * (or the existing `@/lib/ask-user-tools` shim). The Web side keeps its own
 * `AskUserCardData` type in `@/types` for UI components; the shape here is
 * structurally identical, so both sides can round-trip the same objects.
 */

import { detectToolFromText } from './tool-call-parsing.js';
import { getToolArgHint, getToolPublicName, resolveToolName } from './tool-registry.js';

export interface AskUserOption {
  id: string;
  label: string;
  description?: string;
}

export interface AskUserCardData {
  question: string;
  options: AskUserOption[];
  multiSelect?: boolean;
  selectedOptionIds?: string[];
  responseText?: string;
}

export interface AskUserToolCall {
  tool: 'ask_user';
  args: AskUserCardData;
}

export const ASK_USER_TOOL_PROTOCOL = `
## User Interaction Tools

Use this tool to ask the user a question with structured options. This is preferred over prose questions when there are limited valid choices, as it allows the user to simply tap an option on their mobile device.

### ${getToolPublicName('ask_user')}
Ask a question with 2-4 defined options.
\`\`\`json
${getToolArgHint('ask_user')}
\`\`\`

Prefer the short name \`${getToolPublicName('ask_user')}\`. The long name still works for compatibility.

**When to use:**
- Choosing between specific implementation approaches.
- Confirming which files to modify when multiple options exist.
- Selecting configuration values.
- Any decision where defined options reduce user typing.

**Rules:**
- Provide 2-4 clear options.
- Include a helpful description for each option.
- Every \`ask_user\` call automatically includes an "Other..." option for free-text response.
- Use only when there is genuine ambiguity. Do not use for "Is this okay?" if a plan was already approved.
`;

export function detectAskUserToolCall(text: string): AskUserToolCall | null {
  return detectToolFromText<AskUserToolCall>(text, (parsed) => {
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'tool' in parsed &&
      resolveToolName((parsed as { tool?: string }).tool) === 'ask_user'
    ) {
      const p = parsed as Record<string, unknown>;
      const args = p.args as Record<string, unknown> | undefined;
      if (args && typeof args.question === 'string' && Array.isArray(args.options)) {
        const question = args.question.trim();
        const options = args.options
          .filter(
            (option): option is Record<string, unknown> =>
              typeof option === 'object' && option !== null,
          )
          .map((option, index) => ({
            id:
              typeof option.id === 'string' && option.id.trim()
                ? option.id.trim()
                : `option-${index + 1}`,
            label: typeof option.label === 'string' ? option.label.trim() : '',
            ...(typeof option.description === 'string' && option.description.trim()
              ? { description: option.description.trim() }
              : {}),
          }))
          .filter((option) => option.label.length > 0);

        if (!question || options.length === 0) {
          return null;
        }

        return {
          tool: 'ask_user',
          args: {
            question,
            options,
            multiSelect: !!args.multiSelect,
          },
        };
      }
    }
    return null;
  });
}
