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
            type: 'task_graph.task_completed',
            executionId: 'graph-1',
            taskId: 'fix-auth',
            agent: 'coder',
            summary: 'Applied auth fix.',
            elapsedMs: 18,
          },
          {
            id: 'event-6',
            timestamp: 7,
            type: 'task_graph.graph_completed',
            executionId: 'graph-1',
            summary: 'All tasks completed successfully.',
            success: true,
            aborted: false,
            nodeCount: 2,
            totalRounds: 3,
            wallTimeMs: 42,
          },
          {
            id: 'event-7',
            timestamp: 8,
            type: 'user.follow_up_steered',
            round: 0,
            preview: 'Skip that and inspect the failing test instead.',
            replacedPending: false,
          },
          {
            id: 'event-8',
            timestamp: 9,
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
    expect(html).toContain('Task Graph · Coder · fix-auth completed');
    expect(html).toContain('Applied auth fix. (18ms)');
    expect(html).toContain('Task Graph completed');
    expect(html).toContain('All tasks completed successfully. (2 tasks, 3 rounds, 42ms)');
    expect(html).toContain('Steering request captured');
    expect(html).toContain('Turn 1 steered');
    expect(html).toContain('Thinking...');
  });
});
