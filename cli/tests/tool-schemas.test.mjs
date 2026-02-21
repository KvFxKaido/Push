import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CLI_TOOL_SCHEMAS, TOOL_RULES } from '../tool-schemas.mjs';

// ─── Schema structure ──────────────────────────────────────────────

describe('CLI_TOOL_SCHEMAS', () => {
  it('exports exactly 14 tool schemas', () => {
    assert.equal(CLI_TOOL_SCHEMAS.length, 14);
  });

  it('every schema has type "function" and function.name/parameters', () => {
    for (const schema of CLI_TOOL_SCHEMAS) {
      assert.equal(schema.type, 'function', `schema type should be "function"`);
      assert.ok(schema.function, `schema must have function property`);
      assert.equal(typeof schema.function.name, 'string', `function.name must be a string`);
      assert.ok(schema.function.name.length > 0, `function.name must not be empty`);
      assert.equal(typeof schema.function.description, 'string', `function.description must be a string`);
      assert.ok(schema.function.parameters, `function.parameters must exist`);
      assert.equal(schema.function.parameters.type, 'object', `parameters.type must be "object"`);
      assert.ok(schema.function.parameters.properties, `parameters.properties must exist`);
      assert.ok(Array.isArray(schema.function.parameters.required), `parameters.required must be an array`);
    }
  });

  it('has unique tool names', () => {
    const names = CLI_TOOL_SCHEMAS.map(s => s.function.name);
    const unique = new Set(names);
    assert.equal(unique.size, names.length, `duplicate tool names found: ${names}`);
  });

  const expectedTools = [
    'read_file', 'list_dir', 'search_files', 'web_search', 'exec',
    'write_file', 'edit_file', 'undo_edit', 'read_symbols',
    'git_status', 'git_diff', 'git_commit',
    'save_memory', 'coder_update_state',
  ];

  it('contains all expected tool names', () => {
    const names = new Set(CLI_TOOL_SCHEMAS.map(s => s.function.name));
    for (const expected of expectedTools) {
      assert.ok(names.has(expected), `missing tool schema: ${expected}`);
    }
  });
});

// ─── Required fields match tools.mjs validation ────────────────────

describe('schema required fields', () => {
  function getSchema(name) {
    return CLI_TOOL_SCHEMAS.find(s => s.function.name === name);
  }

  it('read_file requires path', () => {
    const schema = getSchema('read_file');
    assert.deepEqual(schema.function.parameters.required, ['path']);
  });

  it('search_files requires pattern', () => {
    const schema = getSchema('search_files');
    assert.deepEqual(schema.function.parameters.required, ['pattern']);
  });

  it('web_search requires query', () => {
    const schema = getSchema('web_search');
    assert.deepEqual(schema.function.parameters.required, ['query']);
  });

  it('exec requires command', () => {
    const schema = getSchema('exec');
    assert.deepEqual(schema.function.parameters.required, ['command']);
  });

  it('write_file requires path and content', () => {
    const schema = getSchema('write_file');
    assert.deepEqual(schema.function.parameters.required, ['path', 'content']);
  });

  it('edit_file requires path and edits', () => {
    const schema = getSchema('edit_file');
    assert.deepEqual(schema.function.parameters.required, ['path', 'edits']);
  });

  it('git_commit requires message', () => {
    const schema = getSchema('git_commit');
    assert.deepEqual(schema.function.parameters.required, ['message']);
  });

  it('save_memory requires content', () => {
    const schema = getSchema('save_memory');
    assert.deepEqual(schema.function.parameters.required, ['content']);
  });

  it('coder_update_state has no required fields', () => {
    const schema = getSchema('coder_update_state');
    assert.deepEqual(schema.function.parameters.required, []);
  });

  it('git_status has no required fields', () => {
    const schema = getSchema('git_status');
    assert.deepEqual(schema.function.parameters.required, []);
  });
});

// ─── edit_file HashlineOp shape ─────────────────────────────────────

describe('edit_file schema', () => {
  it('describes HashlineOp items with correct enum', () => {
    const schema = CLI_TOOL_SCHEMAS.find(s => s.function.name === 'edit_file');
    const editsParam = schema.function.parameters.properties.edits;
    assert.equal(editsParam.type, 'array');
    const item = editsParam.items;
    assert.equal(item.type, 'object');
    assert.deepEqual(item.properties.op.enum, ['replace_line', 'insert_after', 'insert_before', 'delete_line']);
    assert.equal(item.properties.ref.type, 'string');
    assert.deepEqual(item.required, ['op', 'ref']);
  });
});

// ─── TOOL_RULES ────────────────────────────────────────────────────

describe('TOOL_RULES', () => {
  it('is a non-empty string', () => {
    assert.equal(typeof TOOL_RULES, 'string');
    assert.ok(TOOL_RULES.length > 50);
  });

  it('does not contain tool definitions list', () => {
    // TOOL_RULES should only have behavioral rules, not the "Available tools:" list
    assert.ok(!TOOL_RULES.includes('Available tools:'), 'TOOL_RULES should not list tool definitions');
    assert.ok(!TOOL_RULES.includes('```json'), 'TOOL_RULES should not contain JSON format examples');
  });

  it('contains key behavioral rules', () => {
    assert.ok(TOOL_RULES.includes('workspace root'), 'should mention workspace root');
    assert.ok(TOOL_RULES.includes('edit_file'), 'should mention edit_file preference');
    assert.ok(TOOL_RULES.includes('mutating'), 'should mention mutating tool limit');
  });
});
