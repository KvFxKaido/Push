#!/usr/bin/env node
/**
 * Test script for Track 2: Validate shared lib modules work from CLI
 *
 * Tests: diff-utils, error-types, reasoning-tokens, context-budget,
 *        tool-protocol, working-memory
 */

import {
  parseDiffStats,
  parseDiffIntoFiles,
  classifyFilePath,
  chunkDiffByFile,
  formatSize,
} from '../lib/diff-utils';

import {
  classifyError,
  formatStructuredError,
} from '../lib/error-types';

import type { ToolErrorType, StructuredToolError } from '../lib/error-types';

import {
  createReasoningTokenParser,
} from '../lib/reasoning-tokens';

import type { ReasoningTokenParser } from '../lib/reasoning-tokens';

import {
  getContextBudget,
  estimateTokens,
  estimateMessageTokens,
  estimateContextTokens,
} from '../lib/context-budget';

import type { ContextBudget } from '../lib/context-budget';

import {
  asRecord,
  diagnoseJsonSyntaxError,
  repairToolJson,
  detectTruncatedToolCall,
  extractBareToolJsonObjects,
  detectToolFromText,
  stableJsonStringify,
  isInsideInlineCode,
} from '../lib/tool-protocol';

import {
  createWorkingMemory,
  applyWorkingMemoryUpdate,
  applyObservationUpdates,
  invalidateObservationDependencies,
  getVisibleObservations,
  hasCoderState,
  formatCoderState,
  detectUpdateStateCall,
} from '../lib/working-memory';

import type { CoderWorkingMemory, CoderObservation } from '../lib/working-memory';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.log(`  ❌ ${message}`);
  }
}

// ---------------------------------------------------------------------------
// diff-utils tests
// ---------------------------------------------------------------------------

function testDiffUtils(): void {
  console.log('\n=== diff-utils ===\n');

  const sampleDiff = `diff --git a/src/foo.ts b/src/foo.ts
index 1234567..abcdefg 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
diff --git a/src/bar.ts b/src/bar.ts
index 1111111..2222222 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1,2 +1,2 @@
-export const x = 'old';
+export const x = 'new';
`;

  // parseDiffStats
  console.log('parseDiffStats:');
  const stats = parseDiffStats(sampleDiff);
  assert(stats.filesChanged === 2, `filesChanged = ${stats.filesChanged} (expected 2)`);
  assert(stats.additions === 3, `additions = ${stats.additions} (expected 3)`);
  assert(stats.deletions === 2, `deletions = ${stats.deletions} (expected 2)`);
  assert(stats.fileNames.includes('src/foo.ts'), 'fileNames includes src/foo.ts');
  assert(stats.fileNames.includes('src/bar.ts'), 'fileNames includes src/bar.ts');

  // parseDiffIntoFiles
  console.log('\nparseDiffIntoFiles:');
  const files = parseDiffIntoFiles(sampleDiff);
  assert(files.length === 2, `${files.length} files parsed (expected 2)`);
  assert(files[0].path === 'src/foo.ts', `first file path = ${files[0].path}`);
  assert(files[0].additions === 2, `foo.ts additions = ${files[0].additions}`);
  assert(files[0].deletions === 1, `foo.ts deletions = ${files[0].deletions}`);
  assert(files[1].path === 'src/bar.ts', `second file path = ${files[1].path}`);

  // classifyFilePath
  console.log('\nclassifyFilePath:');
  assert(classifyFilePath('src/lib/auth.ts') === 'production', 'src/lib/auth.ts → production');
  assert(classifyFilePath('src/__tests__/auth.test.ts') === 'test', '__tests__ → test');
  assert(classifyFilePath('src/utils.spec.js') === 'test', '.spec.js → test');
  assert(classifyFilePath('scripts/deploy.sh') === 'tooling', 'scripts/ → tooling');
  assert(classifyFilePath('tests/fixtures/data.json') === 'fixture', 'fixtures/ → fixture');

  // chunkDiffByFile
  console.log('\nchunkDiffByFile:');
  const chunked = chunkDiffByFile(sampleDiff, 500);
  assert(chunked.length <= 500, `chunked length ${chunked.length} <= 500`);
  const chunkedFull = chunkDiffByFile(sampleDiff, 10000);
  assert(chunkedFull.includes('src/foo.ts'), 'full budget includes foo.ts');
  assert(chunkedFull.includes('src/bar.ts'), 'full budget includes bar.ts');

  // formatSize
  console.log('\nformatSize:');
  assert(formatSize(0) === '0 B', `formatSize(0) = ${formatSize(0)}`);
  assert(formatSize(500) === '500 B', `formatSize(500) = ${formatSize(500)}`);
  assert(formatSize(1024) === '1.0 KB', `formatSize(1024) = ${formatSize(1024)}`);
  assert(formatSize(1048576) === '1.0 MB', `formatSize(1048576) = ${formatSize(1048576)}`);
}

// ---------------------------------------------------------------------------
// error-types tests
// ---------------------------------------------------------------------------

function testErrorTypes(): void {
  console.log('\n=== error-types ===\n');

  // classifyError
  console.log('classifyError:');
  const e1 = classifyError('ENOENT: no such file or directory');
  assert(e1.type === 'FILE_NOT_FOUND', `ENOENT → ${e1.type}`);
  assert(e1.retryable === false, 'FILE_NOT_FOUND is not retryable');

  const e2 = classifyError('Command timed out after 90s');
  assert(e2.type === 'EXEC_TIMEOUT', `timeout → ${e2.type}`);
  assert(e2.retryable === true, 'EXEC_TIMEOUT is retryable');

  const e3 = classifyError('Rate limit exceeded (429)');
  assert(e3.type === 'RATE_LIMITED', `429 → ${e3.type}`);
  assert(e3.retryable === true, 'RATE_LIMITED is retryable');

  const e4 = classifyError('Permission denied: EACCES');
  assert(e4.type === 'AUTH_FAILURE', `EACCES → ${e4.type}`);

  const e5 = classifyError('Stale file detected');
  assert(e5.type === 'STALE_FILE', `stale → ${e5.type}`);

  const e6 = classifyError('Edit guard: file not fully read');
  assert(e6.type === 'EDIT_GUARD_BLOCKED', `edit guard → ${e6.type}`);

  const e7 = classifyError('Hash mismatch on line 42');
  assert(e7.type === 'EDIT_HASH_MISMATCH', `hash mismatch → ${e7.type}`);

  const e8 = classifyError('Write failed: disk full');
  assert(e8.type === 'WRITE_FAILED', `write failed → ${e8.type}`);

  const e9 = classifyError('Something completely unexpected happened');
  assert(e9.type === 'UNKNOWN', `unknown error → ${e9.type}`);

  const e10 = classifyError('Sandbox unavailable');
  assert(e10.type === 'SANDBOX_UNREACHABLE', `sandbox unavailable → ${e10.type}`);

  const e11 = classifyError('Search string not found in file.ts');
  assert(e11.type === 'EDIT_CONTENT_NOT_FOUND', `search not found → ${e11.type}`);

  // context preservation
  const e12 = classifyError('Not found', 'read_file');
  assert(e12.detail === 'read_file', `context preserved in detail: ${e12.detail}`);

  // formatStructuredError
  console.log('\nformatStructuredError:');
  const formatted = formatStructuredError(e1, 'Error reading file');
  assert(formatted.includes('error_type: FILE_NOT_FOUND'), 'formatted includes error_type');
  assert(formatted.includes('retryable: false'), 'formatted includes retryable');
  assert(formatted.includes('Error reading file'), 'formatted includes base text');
}

// ---------------------------------------------------------------------------
// reasoning-tokens tests
// ---------------------------------------------------------------------------

function testReasoningTokens(): void {
  console.log('\n=== reasoning-tokens ===\n');

  // Test 1: Basic think tag parsing
  console.log('Think tag parsing:');
  const content: string[] = [];
  const thinking: (string | null)[] = [];

  const parser = createReasoningTokenParser(
    (t) => content.push(t),
    (t) => thinking.push(t),
  );

  parser.pushContent('Hello ');
  parser.pushContent('<think>reasoning here</think>');
  parser.pushContent('World');
  parser.flush();

  assert(content.join('').includes('Hello'), 'content includes Hello');
  assert(content.join('').includes('World'), 'content includes World');
  assert(thinking.some(t => t !== null && t.includes('reasoning')), 'thinking includes reasoning');
  assert(thinking.includes(null), 'thinking closed with null signal');

  // Test 2: Native reasoning_content
  console.log('\nNative reasoning_content:');
  const content2: string[] = [];
  const thinking2: (string | null)[] = [];

  const parser2 = createReasoningTokenParser(
    (t) => content2.push(t),
    (t) => thinking2.push(t),
  );

  parser2.pushReasoning('I need to think');
  parser2.pushReasoning(' about this');
  parser2.closeThinking();
  parser2.pushContent('The answer is 42');
  parser2.flush();

  assert(thinking2.some(t => t !== null && t.includes('think')), 'native reasoning captured');
  assert(thinking2.includes(null), 'native reasoning closed');
  assert(content2.join('').includes('42'), 'content after reasoning works');

  // Test 3: Streamed think tags (split across tokens)
  console.log('\nStreamed think tags:');
  const content3: string[] = [];
  const thinking3: (string | null)[] = [];

  const parser3 = createReasoningTokenParser(
    (t) => content3.push(t),
    (t) => thinking3.push(t),
  );

  parser3.pushContent('Before ');
  parser3.pushContent('<thi');
  parser3.pushContent('nk>deep thought</th');
  parser3.pushContent('ink>After');
  parser3.flush();

  const allContent3 = content3.join('');
  const allThinking3 = thinking3.filter(t => t !== null).join('');
  assert(allContent3.includes('Before'), 'streamed: content before tag');
  assert(allContent3.includes('After'), 'streamed: content after tag');
  assert(allThinking3.includes('deep thought'), 'streamed: thinking captured');

  // Test 4: No think tags (passthrough)
  console.log('\nPassthrough (no think tags):');
  const content4: string[] = [];
  const parser4 = createReasoningTokenParser((t) => content4.push(t));

  parser4.pushContent('Just regular content');
  parser4.pushContent(' with no thinking');
  parser4.flush();

  assert(content4.join('').includes('Just regular content with no thinking'), 'passthrough works');
}

// ---------------------------------------------------------------------------
// context-budget tests
// ---------------------------------------------------------------------------

function testContextBudget(): void {
  console.log('\n=== context-budget ===\n');

  // getContextBudget
  console.log('getContextBudget:');
  const defaultBudget = getContextBudget('ollama', 'some-model');
  assert(defaultBudget.maxTokens === 100_000, `default max = ${defaultBudget.maxTokens}`);
  assert(defaultBudget.targetTokens === 88_000, `default target = ${defaultBudget.targetTokens}`);

  const geminiBudget = getContextBudget('ollama', 'gemini-3-flash-preview');
  assert(geminiBudget.maxTokens === 850_000, `gemini max = ${geminiBudget.maxTokens}`);

  const claudeBudget = getContextBudget('openrouter', 'claude-sonnet-4.6');
  assert(claudeBudget.maxTokens === 850_000, `claude max = ${claudeBudget.maxTokens}`);

  const haikuBudget = getContextBudget('openrouter', 'claude-haiku-3');
  assert(haikuBudget.maxTokens === 100_000, `haiku max = ${haikuBudget.maxTokens} (default)`);

  const grokBudget = getContextBudget('openrouter', 'grok-3');
  assert(grokBudget.maxTokens === 1_500_000, `grok max = ${grokBudget.maxTokens}`);

  const gpt5Budget = getContextBudget('openrouter', 'gpt-5.4-turbo');
  assert(gpt5Budget.maxTokens === 850_000, `gpt-5.4 max = ${gpt5Budget.maxTokens}`);

  // estimateTokens
  console.log('\nestimateTokens:');
  assert(estimateTokens('') === 0, 'empty string → 0');
  assert(estimateTokens('hello') > 0, 'non-empty → positive');

  const shortEstimate = estimateTokens('Hello world');
  assert(shortEstimate > 0 && shortEstimate < 10, `short text: ${shortEstimate} tokens`);

  const codeEstimate = estimateTokens('function foo() { return bar[0] + baz(x, y); }'.repeat(20));
  const proseEstimate = estimateTokens('The quick brown fox jumps over the lazy dog. '.repeat(20));
  // Code should tokenize at a higher rate (more tokens per char) than prose
  const codeLen = ('function foo() { return bar[0] + baz(x, y); '.repeat(20)).length;
  const proseLen = ('The quick brown fox jumps over the lazy dog. '.repeat(20)).length;
  const codeRate = codeLen / codeEstimate;
  const proseRate = proseLen / proseEstimate;
  assert(codeRate <= proseRate + 0.5, `code rate (${codeRate.toFixed(1)}) <= prose rate (${proseRate.toFixed(1)})`);

  // estimateMessageTokens
  console.log('\nestimateMessageTokens:');
  const msgTokens = estimateMessageTokens({ content: 'Hello world' });
  assert(msgTokens > estimateTokens('Hello world'), 'message tokens > raw text tokens (includes overhead)');

  const msgWithThinking = estimateMessageTokens({
    content: 'Answer',
    thinking: 'Let me think about this carefully',
  });
  assert(msgWithThinking > msgTokens, 'message with thinking > without');

  // estimateContextTokens
  console.log('\nestimateContextTokens:');
  const contextTokens = estimateContextTokens([
    { content: 'Hello' },
    { content: 'World' },
  ]);
  assert(contextTokens > 0, `context tokens = ${contextTokens}`);
}

// ---------------------------------------------------------------------------
// tool-protocol tests
// ---------------------------------------------------------------------------

function testToolProtocol(): void {
  console.log('\n=== tool-protocol ===\n');

  // asRecord
  console.log('asRecord:');
  assert(asRecord({ a: 1 }) !== null, 'object → JsonRecord');
  assert(asRecord(null) === null, 'null → null');
  assert(asRecord('string') === null, 'string → null');
  assert(asRecord(42) === null, 'number → null');

  // diagnoseJsonSyntaxError
  console.log('\ndiagnoseJsonSyntaxError:');
  assert(diagnoseJsonSyntaxError('{"valid": true}') === null, 'valid JSON → null');
  const missingBrace = diagnoseJsonSyntaxError('"tool": "test"');
  assert(missingBrace !== null && missingBrace.message.includes('Missing opening brace'), 'missing opening brace');
  const unterminated = diagnoseJsonSyntaxError('{"tool": "test');
  assert(unterminated !== null && unterminated.message.includes('Unterminated string'), 'unterminated string');
  const unbalanced = diagnoseJsonSyntaxError('{"tool": "test", "args": {');
  assert(unbalanced !== null && unbalanced.message.includes('Unbalanced'), 'unbalanced braces');

  // repairToolJson
  console.log('\nrepairToolJson:');
  const repaired1 = repairToolJson('{"tool": "test", "args": {"a": 1},}');
  assert(repaired1 !== null && repaired1.tool === 'test', 'trailing comma repaired');
  const repaired2 = repairToolJson("{tool: 'test', args: {}}");
  assert(repaired2 !== null && repaired2.tool === 'test', 'unquoted keys + single quotes repaired');
  const repaired3 = repairToolJson('{"tool": "test", "args": {"val": True}}');
  assert(repaired3 !== null, 'Python True repaired');
  const repaired4 = repairToolJson('"tool": "test", "args": {}');
  assert(repaired4 !== null && repaired4.tool === 'test', 'missing opening brace repaired');
  assert(repairToolJson('not json at all') === null, 'non-JSON → null');

  // detectTruncatedToolCall
  console.log('\ndetectTruncatedToolCall:');
  const truncated = detectTruncatedToolCall('{"tool": "sandbox_exec", "args": {"command": "npm test"');
  assert(truncated !== null && truncated.toolName === 'sandbox_exec', 'truncated tool detected');
  assert(detectTruncatedToolCall('{"tool": "test", "args": {}}') === null, 'complete tool → null');

  // extractBareToolJsonObjects
  console.log('\nextractBareToolJsonObjects:');
  const extracted = extractBareToolJsonObjects('Here is a tool call: {"tool": "read_file", "args": {"path": "test.ts"}} and some text');
  assert(extracted.length === 1, `extracted ${extracted.length} tool objects`);
  const obj = asRecord(extracted[0]);
  assert(obj !== null && obj.tool === 'read_file', 'extracted correct tool');

  // detectToolFromText
  console.log('\ndetectToolFromText:');
  const detected = detectToolFromText<{ tool: string }>(
    'Some text\n```json\n{"tool": "test_tool", "args": {}}\n```\nMore text',
    (parsed) => {
      const o = asRecord(parsed);
      return o && typeof o.tool === 'string' ? { tool: o.tool as string } : null;
    },
  );
  assert(detected !== null && detected.tool === 'test_tool', 'detected tool from fenced JSON');

  const noTool = detectToolFromText<{ tool: string }>(
    'Just regular text with no JSON',
    (parsed) => {
      const o = asRecord(parsed);
      return o && typeof o.tool === 'string' ? { tool: o.tool as string } : null;
    },
  );
  assert(noTool === null, 'no tool in plain text');

  // stableJsonStringify
  console.log('\nstableJsonStringify:');
  const key1 = stableJsonStringify({ b: 2, a: 1 });
  const key2 = stableJsonStringify({ a: 1, b: 2 });
  assert(key1 === key2, 'stable stringify produces same key regardless of key order');
  assert(stableJsonStringify(null) === 'null', 'null → "null"');
  assert(stableJsonStringify(undefined) === 'null', 'undefined → "null"');

  // isInsideInlineCode
  console.log('\nisInsideInlineCode:');
  assert(isInsideInlineCode('hello `world` test', 8) === true, 'inside inline code');
  assert(isInsideInlineCode('hello `world` test', 14) === false, 'after inline code');
  assert(isInsideInlineCode('hello world test', 6) === false, 'no code spans');
}

// ---------------------------------------------------------------------------
// working-memory tests
// ---------------------------------------------------------------------------

function testWorkingMemory(): void {
  console.log('\n=== working-memory ===\n');

  // createWorkingMemory
  console.log('createWorkingMemory:');
  const mem = createWorkingMemory();
  assert(mem.plan === '', 'initial plan is empty');
  assert(Array.isArray(mem.openTasks) && mem.openTasks.length === 0, 'initial openTasks is empty array');
  assert(mem.observations === undefined, 'initial observations is undefined');

  // applyWorkingMemoryUpdate
  console.log('\napplyWorkingMemoryUpdate:');
  applyWorkingMemoryUpdate(mem, {
    plan: 'Fix the bug',
    openTasks: ['Read file', 'Edit file'],
    filesTouched: ['src/app.ts'],
    currentPhase: 'investigation',
  });
  assert(mem.plan === 'Fix the bug', 'plan updated');
  assert(mem.openTasks!.length === 2, 'openTasks updated');
  assert(mem.filesTouched!.includes('src/app.ts'), 'filesTouched updated');
  assert(mem.currentPhase === 'investigation', 'currentPhase updated');

  // dedup
  applyWorkingMemoryUpdate(mem, {
    filesTouched: ['src/app.ts', 'src/app.ts', 'src/utils.ts'],
  });
  assert(mem.filesTouched!.length === 2, 'filesTouched deduped');

  // applyObservationUpdates
  console.log('\napplyObservationUpdates:');
  const obs = applyObservationUpdates(undefined, [
    { id: 'obs-1', text: 'Uses adapter pattern' },
    { id: 'obs-2', text: 'Has circular dep', dependsOn: ['src/a.ts'] },
  ], 1);
  assert(obs !== undefined && obs.length === 2, '2 observations added');
  assert(obs![0].id === 'obs-1', 'first observation id');
  assert(obs![0].addedAtRound === 1, 'addedAtRound set');

  // update existing observation
  const obs2 = applyObservationUpdates(obs, [
    { id: 'obs-1', text: 'Uses adapter pattern (confirmed)' },
  ], 3);
  assert(obs2![0].text === 'Uses adapter pattern (confirmed)', 'observation updated');
  assert(obs2![0].addedAtRound === 1, 'addedAtRound preserved on update');

  // remove observation
  const obs3 = applyObservationUpdates(obs2, [{ id: 'obs-1', remove: true }], 4);
  assert(obs3!.length === 1, 'observation removed');
  assert(obs3![0].id === 'obs-2', 'remaining observation is obs-2');

  // invalidateObservationDependencies
  console.log('\ninvalidateObservationDependencies:');
  const withDeps: CoderObservation[] = [
    { id: 'a', text: 'Observation A', dependsOn: ['src/a.ts'] },
    { id: 'b', text: 'Observation B' }, // no deps
    { id: 'c', text: 'Observation C', dependsOn: ['src/c.ts'] },
  ];
  const invalidated = invalidateObservationDependencies(withDeps, 'src/a.ts', 5);
  assert(invalidated![0].stale === true, 'obs A stale after dependency modified');
  assert(invalidated![1].stale === undefined, 'obs B unchanged (no deps)');
  assert(invalidated![2].stale === undefined, 'obs C unchanged (different dep)');

  // workspace path normalization
  const invalidated2 = invalidateObservationDependencies(
    [{ id: 'x', text: 'Test', dependsOn: ['src/foo.ts'] }],
    '/workspace/src/foo.ts',
    6,
  );
  assert(invalidated2![0].stale === true, 'workspace path normalization works');

  // getVisibleObservations
  console.log('\ngetVisibleObservations:');
  const staleObs: CoderObservation[] = [
    { id: 'fresh', text: 'Fresh obs' },
    { id: 'stale-recent', text: 'Stale recent', stale: true, staleAtRound: 8 },
    { id: 'stale-old', text: 'Stale old', stale: true, staleAtRound: 1 },
  ];
  const visible = getVisibleObservations(staleObs, 10);
  assert(visible.length === 2, `${visible.length} visible (fresh + stale-recent, old expired)`);
  assert(visible.some(o => o.id === 'fresh'), 'fresh is visible');
  assert(visible.some(o => o.id === 'stale-recent'), 'stale-recent is visible (within 5 rounds)');
  assert(!visible.some(o => o.id === 'stale-old'), 'stale-old is expired');

  // hasCoderState
  console.log('\nhasCoderState:');
  assert(hasCoderState(createWorkingMemory(), 0) === false, 'empty memory → false');
  assert(hasCoderState({ plan: 'Do stuff' }, 0) === true, 'memory with plan → true');

  // formatCoderState
  console.log('\nformatCoderState:');
  const formatted = formatCoderState({
    plan: 'Fix the bug',
    openTasks: ['Read file', 'Edit file'],
    filesTouched: ['src/app.ts'],
  });
  assert(formatted.includes('[CODER_STATE]'), 'contains opening tag');
  assert(formatted.includes('[/CODER_STATE]'), 'contains closing tag');
  assert(formatted.includes('Fix the bug'), 'contains plan');
  assert(formatted.includes('src/app.ts'), 'contains file');

  // detectUpdateStateCall
  console.log('\ndetectUpdateStateCall:');
  const stateCall = detectUpdateStateCall('```json\n{"tool": "coder_update_state", "args": {"plan": "New plan", "openTasks": ["task1"]}}\n```');
  assert(stateCall !== null, 'detected update state call');
  assert(stateCall!.plan === 'New plan', 'parsed plan');
  assert(stateCall!.openTasks!.length === 1, 'parsed openTasks');

  const noState = detectUpdateStateCall('Just regular text');
  assert(noState === null, 'no state call in plain text');

  // with observations
  const obsCall = detectUpdateStateCall('```json\n{"tool": "coder_update_state", "args": {"observations": [{"id": "test", "text": "Found pattern"}]}}\n```');
  assert(obsCall !== null && obsCall.observations!.length === 1, 'parsed observation updates');
  assert(obsCall!.observations![0].id === 'test', 'observation id parsed');
}

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------

console.log('=== Track 2: Shared Module Convergence Tests ===');

testDiffUtils();
testErrorTypes();
testReasoningTokens();
testContextBudget();
testToolProtocol();
testWorkingMemory();

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));

if (failed > 0) {
  console.log('\n❌ Track 2 validation: FAILED');
  process.exit(1);
} else {
  console.log('\n✅ Track 2 validation: SUCCESS');
  console.log('CLI can import and use all shared lib modules:');
  console.log('  - lib/diff-utils.ts');
  console.log('  - lib/error-types.ts');
  console.log('  - lib/reasoning-tokens.ts');
  console.log('  - lib/context-budget.ts');
  console.log('  - lib/tool-protocol.ts');
  console.log('  - lib/working-memory.ts');
}
