import type { ActiveRepo, AskUserCardData, QuickPrompt } from '@/types';

export interface QuickPromptMessage {
  text: string;
  displayText: string;
}

function formatSuggestedAskUserPath(path: AskUserCardData): string {
  const optionLines = path.options.map((option) => (
    `- ${option.id}: ${option.label}${option.description ? ` — ${option.description}` : ''}`
  ));

  return [
    'If one short clarification would materially change the work, use the ask_user tool before you start.',
    `Suggested question: ${path.question}`,
    'Suggested options:',
    ...optionLines,
    path.multiSelect ? 'Use multi-select if it fits.' : 'Keep it single-select.',
    'Once the user answers, continue without asking the same question again.',
  ].join('\n');
}

export function buildQuickPromptMessage(prompt: QuickPrompt): QuickPromptMessage {
  const sections = [prompt.label];

  if (prompt.expandedPrompt?.trim()) {
    sections.push(prompt.expandedPrompt.trim());
  }

  if (prompt.suggestedAskUserPath) {
    sections.push(formatSuggestedAskUserPath(prompt.suggestedAskUserPath));
  }

  return {
    text: sections.join('\n\n'),
    displayText: prompt.label,
  };
}

export function getChatQuickPrompts(): QuickPrompt[] {
  return [
    { label: 'Think through a technical decision with me' },
    { label: 'Explain a concept I keep getting wrong' },
    { label: 'Help me plan before I start building' },
  ];
}

export function getEmptyStateQuickPrompts(
  activeRepo?: ActiveRepo | null,
  hasWorkspace?: boolean,
): QuickPrompt[] {
  if (activeRepo) {
    return [
      { label: `Show open PRs on ${activeRepo.name}` },
      { label: `What changed recently in ${activeRepo.name}?` },
      { label: `Summarize the ${activeRepo.name} codebase` },
    ];
  }

  if (hasWorkspace) {
    return [
      {
        label: 'Sharpen a half-baked idea with me',
        expandedPrompt: 'Help me turn a rough idea into something concrete and actionable. Keep it collaborative, and aim to leave me with a clearer direction plus a tangible next step in this workspace.',
        suggestedAskUserPath: {
          question: 'What kind of idea are we shaping?',
          options: [
            { id: 'product', label: 'Product idea', description: 'A feature, app, or user experience concept' },
            { id: 'workflow', label: 'Workflow idea', description: 'An automation, script, or process improvement' },
            { id: 'technical', label: 'Technical idea', description: 'An architecture, refactor, or implementation direction' },
            { id: 'describe', label: "I'll describe it", description: 'Let me explain the idea in my own words' },
          ],
        },
      },
      {
        label: 'Draft a design doc',
        expandedPrompt: 'Create a concise, practical design doc in /workspace that I can build from. Prefer something implementation-oriented over a vague brainstorm.',
        suggestedAskUserPath: {
          question: 'What kind of design doc do you want?',
          options: [
            { id: 'feature', label: 'Feature spec', description: 'Goals, flows, requirements, and edge cases' },
            { id: 'technical', label: 'Technical plan', description: 'Architecture, components, data flow, and rollout' },
            { id: 'architecture', label: 'Architecture note', description: 'Tradeoffs, decisions, and system shape' },
            { id: 'template', label: 'Start from a template', description: 'Give me a clean starter doc to fill in' },
          ],
        },
      },
      {
        label: 'Scaffold a project',
        expandedPrompt: 'Scaffold a small project in /workspace with sensible structure, starter files, config, and a short README so I can start iterating quickly.',
        suggestedAskUserPath: {
          question: 'What stack should I use?',
          options: [
            { id: 'node-ts', label: 'Node / TypeScript', description: 'TypeScript-first app or tool with modern config' },
            { id: 'python', label: 'Python', description: 'Simple Python project with clear entrypoint and packaging' },
            { id: 'go', label: 'Go', description: 'Minimal Go module with clean package structure' },
            { id: 'rust', label: 'Rust', description: 'Cargo project with a straightforward starter layout' },
          ],
        },
      },
    ];
  }

  return [
    { label: 'Review my latest PR' },
    { label: 'What changed in main today?' },
    { label: 'Show my open pull requests' },
  ];
}
