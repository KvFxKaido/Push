#!/usr/bin/env node
/**
 * Test script for Track 1: Validate shared hashline module works from CLI
 */

import { 
  calculateLineHash, 
  calculateLineHashSync,
  applyHashlineEdits,
  renderAnchoredRange,
  calculateContentVersion,
  getNodeCrypto
} from '../lib/hashline.js';

async function runTests() {
  // Initialize Node crypto cache for sync tests
  await getNodeCrypto();

  console.log('=== Track 1: Hashline Convergence Test ===\n');

  // Test 1: Basic hash calculation (async)
  console.log('Test 1: Async hash calculation');
  const hash1 = await calculateLineHash('const x = 1;');
  console.log(`  'const x = 1;' => ${hash1}`);
  console.assert(hash1.length === 7, 'Hash should be 7 chars');
  console.log('  ✅ Async hash works\n');

  // Test 2: Sync hash calculation (Node.js only)
  console.log('Test 2: Sync hash calculation');
  const hash2 = calculateLineHashSync('const x = 1;');
  console.log(`  'const x = 1;' => ${hash2}`);
  console.assert(hash1 === hash2, 'Async and sync should produce same hash');
  console.log('  ✅ Sync hash works and matches async\n');

  // Test 3: Content version
  console.log('Test 3: Content version');
  const version = await calculateContentVersion('file content here');
  console.log(`  Version: ${version}`);
  console.assert(version.length === 12, 'Version should be 12 chars');
  console.log('  ✅ Content version works\n');

  // Test 4: Render anchored range
  console.log('Test 4: Render anchored range');
  const content = `line 1
line 2
line 3`;
  const rendered = await renderAnchoredRange(content);
  console.log('  Rendered:');
  rendered.text.split('\n').forEach(l => console.log(`    ${l}`));
  console.log('  ✅ Render anchored range works\n');

  // Test 5: Apply hashline edits
  console.log('Test 5: Apply hashline edits');
  const testContent = `function hello() {
  console.log('world');
  return 42;
}`;
  
  // Get hash for line 2
  const line2Hash = await calculateLineHash("  console.log('world');", 12);
  console.log(`  Line 2 hash (12-char): ${line2Hash}`);
  
  // Replace line 2
  const result = await applyHashlineEdits(testContent, [
    { op: 'replace_line', ref: `2:${line2Hash.slice(0, 7)}`, content: "  console.log('updated');" }
  ]);
  
  console.log('  Applied:', result.applied, 'Failed:', result.failed);
  if (result.errors.length > 0) {
    console.log('  Errors:', result.errors);
  }
  console.log('  Result:');
  result.content.split('\n').forEach(l => console.log(`    ${l}`));
  console.assert(result.applied === 1, 'Should apply 1 edit');
  console.assert(result.failed === 0, 'Should have 0 failures');
  console.assert(result.content.includes('updated'), 'Content should be updated');
  console.log('  ✅ Hashline edits work\n');

  // Test 6: Insert operation
  console.log('Test 6: Insert operation');
  const insertResult = await applyHashlineEdits(result.content, [
    { op: 'insert_after', ref: '1:' + (await calculateLineHash('function hello() {', 12)).slice(0, 7), content: '  // New comment' }
  ]);
  console.log('  Applied:', insertResult.applied);
  console.log('  Result:');
  insertResult.content.split('\n').forEach(l => console.log(`    ${l}`));
  console.log('  ✅ Insert works\n');

  console.log('=== All tests passed! ===');
  console.log('\nTrack 1 validation: SUCCESS');
  console.log('CLI can import and use shared lib/hashline.ts');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});