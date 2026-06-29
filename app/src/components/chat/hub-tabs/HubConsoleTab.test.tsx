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
    // Subagent/task labels render phase-first via lib/role-display.ts (the
    // Coder role surfaces as the "Editing" phase, not the internal role name).
    expect(html).toContain('Editing completed');
    expect(html).toContain('Task Graph · Editing · fix-auth completed');
    expect(html).toContain('Applied auth fix. (18ms)');
    expect(html).toContain('Task Graph completed');
    expect(html).toContain('All tasks completed successfully. (2 tasks, 3 rounds, 42ms)');
    expect(html).toContain('Steering request captured');
    expect(html).toContain('Turn 1 steered');
    expect(html).toContain('Thinking...');
  });

  it('renders a completed sandbox_exec as a Sandbox card, matching the public tool name', () => {
    const html = renderToStaticMarkup(
      <HubConsoleTab
        messages={[]}
        agentEvents={[]}
        runEvents={[
          {
            id: 'event-1',
            timestamp: 1,
            type: 'tool.execution_start',
            round: 0,
            executionId: 'exec-1',
            // Run events carry the registry public name; sandbox_exec → 'exec'.
            toolName: 'exec',
            toolSource: 'sandbox',
          },
          {
            id: 'event-2',
            timestamp: 2,
            type: 'tool.execution_complete',
            round: 0,
            executionId: 'exec-1',
            toolName: 'exec',
            toolSource: 'sandbox',
            durationMs: 1500,
            isError: false,
            preview: 'Command: echo "hello world" Exit code: 0 hello world',
            target: 'echo "hello world"',
          },
        ]}
      />,
    );

    // The 'exec' public name must still resolve to the sandbox card (not the
    // flat result line). Command lands in the collapsed header (completed →
    // collapsed).
    expect(html).toContain('echo &quot;hello world&quot;');
    expect(html).toContain('Completed');
    // The flat result line ("preview (durationMs)") must NOT appear for exec.
    expect(html).not.toContain('(1500ms)');
    // It must not double-render the running placeholder for a completed run.
    expect(html).not.toContain('Running');
  });

  it('flags a non-zero exec exit as errored and opens the Console tab', () => {
    const html = renderToStaticMarkup(
      <HubConsoleTab
        messages={[]}
        agentEvents={[]}
        runEvents={[
          {
            id: 'event-1',
            timestamp: 1,
            type: 'tool.execution_complete',
            round: 0,
            executionId: 'exec-err',
            toolName: 'exec',
            toolSource: 'sandbox',
            durationMs: 1500,
            // A non-zero exit is a tool *result*, not a tool *error*: isError is
            // false, the exit code lives in the preview envelope.
            isError: false,
            preview: 'Command: badcmd Exit code: 127 command not found',
            target: 'badcmd --nope',
          },
        ]}
      />,
    );

    // Errored cards default open AND default to the Console tab, so the failure
    // output (and its error styling) render in the active panel — this is the
    // real coverage of the console-output branch.
    expect(html).toContain('badcmd --nope');
    expect(html).toContain('Error');
    expect(html).toContain('1.5s');
    expect(html).toContain('command not found');
    expect(html).toContain('text-push-status-error/80');
  });

  it('shows a running Sandbox card for an exec with no completion event', () => {
    const html = renderToStaticMarkup(
      <HubConsoleTab
        messages={[]}
        agentEvents={[]}
        runEvents={[
          {
            id: 'event-1',
            timestamp: 1,
            type: 'tool.execution_start',
            round: 0,
            executionId: 'exec-running',
            toolName: 'exec',
            toolSource: 'sandbox',
          },
        ]}
      />,
    );

    expect(html).toContain('Running');
    expect(html).toContain('sandbox_exec');
  });
});
