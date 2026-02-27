import { detectToolFromText } from './utils';
import type { AskUserCardData } from '@/types';

export interface AskUserToolCall {
  tool: 'ask_user';
  args: AskUserCardData;
}

export const ASK_USER_TOOL_PROTOCOL = `
## User Interaction Tools

Use this tool to ask the user a question with structured options. This is preferred over prose questions when there are limited valid choices, as it allows the user to simply tap an option on their mobile device.

### ask_user
Ask a question with 2-4 defined options.
\`\`\`json
{
  "tool": "ask_user",
  "args": {
    "question": "Which authentication method should I implement?",
    "options": [
      { "id": "apiKey", "label": "API Key", "description": "Simple header-based auth" },
      { "id": "oauth", "label": "OAuth 2.0", "description": "Standard secure flow" }
    ],
    "multiSelect": false
  }
}
\`\`\`

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
    if (typeof parsed === 'object' && parsed !== null && 'tool' in parsed && parsed.tool === 'ask_user') {
      const p = parsed as any;
      if (p.args && typeof p.args.question === 'string' && Array.isArray(p.args.options)) {
        return {
          tool: 'ask_user',
          args: {
            question: p.args.question,
            options: p.args.options,
            multiSelect: !!p.args.multiSelect
          }
        };
      }
    }
    return null;
  });
}
