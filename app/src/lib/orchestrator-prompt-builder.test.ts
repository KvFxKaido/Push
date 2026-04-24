import { describe, it, expect } from 'vitest';
import {
  buildOrchestratorGuidelines,
  buildOrchestratorToolInstructions,
  buildOrchestratorDelegation,
  buildOrchestratorBaseBuilder,
  buildOrchestratorBasePrompt,
  ORCHESTRATOR_IDENTITY,
  ORCHESTRATOR_VOICE,
} from './orchestrator-prompt-builder';

describe('orchestrator-prompt-builder (shared lib)', () => {
  it('ORCHESTRATOR_IDENTITY is a non-empty string', () => {
    expect(typeof ORCHESTRATOR_IDENTITY).toBe('string');
    expect(ORCHESTRATOR_IDENTITY.length).toBeGreaterThan(0);
    expect(ORCHESTRATOR_IDENTITY).toMatch(/Push/);
  });

  it('ORCHESTRATOR_VOICE includes the voice/boundaries markers', () => {
    expect(ORCHESTRATOR_VOICE).toContain('Voice:');
    expect(ORCHESTRATOR_VOICE).toContain('Boundaries:');
  });

  it('buildOrchestratorGuidelines returns the default-workflow block', () => {
    const text = buildOrchestratorGuidelines();
    expect(text).toContain('## Default Workflow');
    expect(text).toContain('## Clarifications and Assumptions');
  });

  it('buildOrchestratorToolInstructions covers the tool execution + error handling sections', () => {
    const text = buildOrchestratorToolInstructions();
    expect(text).toContain('## Tool Execution Model');
    expect(text).toContain('## Tool Call Placement');
    expect(text).toContain('## Tool Routing');
    expect(text).toContain('## Error Handling');
    expect(text).toContain('EDIT_HASH_MISMATCH');
    // The placement section specifically addresses reasoning-model
    // tool-call emission — Kimi K2.6 was seen emitting `{"tool": ...}`
    // JSON inside its reasoning channel, which the parser never scans
    // (orchestrator.ts only forwards `content` tokens to `parser.push`).
    // Regression guard so the instruction isn't silently dropped in a
    // future refactor; the symptom (two boops per session) is subtle
    // enough that a missing-section bug would be easy to miss.
    expect(text).toMatch(/thinking|reasoning/i);
    expect(text).toMatch(/response content/i);
  });

  it('buildOrchestratorDelegation covers delegation + task graph sections', () => {
    const text = buildOrchestratorDelegation();
    expect(text).toContain('## Efficient Delegation and Handoffs');
    expect(text).toContain('## Explorer Task Template');
    expect(text).toContain('## Multi-Task Delegation');
    expect(text).toContain('## Task Graph Orchestration');
    expect(text).toContain('## When to Delegate vs Handle Directly');
  });

  it('buildOrchestratorBaseBuilder wires the base sections', () => {
    const builder = buildOrchestratorBaseBuilder();
    // identity / voice / safety / guidelines / tool_instructions / delegation
    expect(builder.get('identity')).toContain('Push is a mobile AI coding agent');
    expect(builder.get('voice')).toContain('Voice:');
    expect(builder.get('safety')?.length ?? 0).toBeGreaterThan(0);
    expect(builder.get('guidelines')?.length ?? 0).toBeGreaterThan(0);
    expect(builder.get('tool_instructions')?.length ?? 0).toBeGreaterThan(0);
    expect(builder.get('delegation')?.length ?? 0).toBeGreaterThan(0);
  });

  it('buildOrchestratorBasePrompt emits a stable non-empty prompt', () => {
    const prompt = buildOrchestratorBasePrompt();
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
    // sanity-check that multiple sections composed
    expect(prompt).toContain('Push');
    expect(prompt).toContain('## Default Workflow');
    expect(prompt).toContain('## Tool Execution Model');
    expect(prompt).toContain('## Efficient Delegation and Handoffs');
  });
});
