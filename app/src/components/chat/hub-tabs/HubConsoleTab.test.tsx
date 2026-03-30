import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HubConsoleTab } from './HubConsoleTab';

describe('HubConsoleTab', () => {
  it('renders structured run events without scraping newer tool messages', () => {
    const html = renderToStaticMarkup(
      <HubConsoleTab
        messages={[]}
        agentEvents={[
          {
            id: 'status-1',
            timestamp: 5,
            source: 'orchestrator',
            phase: 'Thinking...',
          },
        ]}
        runEvents={[
          {
            id: 'event-1',
            timestamp: 1,
            type: 'assistant.turn_start',
            round: 0,
          },
          {
            id: 'event-2',
            timestamp: 2,
            type: 'tool.execution_start',
            round: 0,
            executionId: 'exec-1',
            toolName: 'Read file',
            toolSource: 'sandbox',
          },
          {
            id: 'event-3',
            timestamp: 3,
            type: 'tool.execution_complete',
            round: 0,
            executionId: 'exec-1',
            toolName: 'Read file',
            toolSource: 'sandbox',
            durationMs: 12,
            isError: false,
            preview: 'Loaded app.ts',
          },
          {
            id: 'event-4',
            timestamp: 4,
            type: 'subagent.completed',
            executionId: 'sub-1',
            agent: 'coder',
            summary: 'Patched tests.',
          },
          {
            id: 'event-5',
            timestamp: 6,
            type: 'user.follow_up_steered',
            round: 0,
            preview: 'Skip that and inspect the failing test instead.',
            replacedPending: false,
          },
          {
            id: 'event-6',
            timestamp: 7,
            type: 'assistant.turn_end',
            round: 0,
            outcome: 'steered',
          },
        ]}
      />,
    );

    expect(html).toContain('Turn 1 started');
    expect(html).toContain('&gt; Read file');
    expect(html).toContain('Loaded app.ts (12ms)');
    expect(html).toContain('Coder completed');
    expect(html).toContain('Steering request captured');
    expect(html).toContain('Turn 1 steered');
    expect(html).toContain('Thinking...');
  });
});
