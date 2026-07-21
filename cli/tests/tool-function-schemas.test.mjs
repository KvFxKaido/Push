import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCliNativeToolSchemas,
  getCliReadOnlyNativeToolSchemas,
} from '../tool-function-schemas.ts';
import {
  cliProviderModelSupportsNativeToolCalling,
  resolveCliPushCapabilityProfile,
} from '../native-tool-gate.ts';

function byName(schemas) {
  return new Map(schemas.map((schema) => [schema.name, schema]));
}

describe('CLI native tool function schemas', () => {
  it('derives the full CLI tool surface from the CLI protocol names', () => {
    const schemas = byName(getCliNativeToolSchemas());

    for (const name of [
      'read_file',
      'list_dir',
      'search_files',
      'exec',
      'exec_start',
      'write_file',
      'edit_file',
      'git_commit',
      'coder_update_state',
      'ask_user',
    ]) {
      assert.ok(schemas.has(name), `expected full CLI schema for ${name}`);
    }

    assert.equal(schemas.has('read'), false, 'must not advertise web registry read name');
    assert.equal(schemas.has('search'), false, 'must not advertise web registry search name');
    assert.deepEqual(schemas.get('read_file').input_schema.required, ['path']);
    assert.equal(schemas.get('read_file').input_schema.properties.start_line.type, 'integer');
    assert.equal(schemas.get('exec_start').input_schema.properties.tty.type, 'boolean');
    // Exec session ids are strings (`exec_<base36>_<n>`); the executor calls
    // asString(session_id). The schema must not tell the model they're integers.
    for (const tool of ['exec_poll', 'exec_write', 'exec_stop']) {
      assert.equal(
        schemas.get(tool).input_schema.properties.session_id.type,
        'string',
        `${tool}.session_id must be string`,
      );
    }
  });

  it('derives the Explorer read-only schema from READ_ONLY_TOOL_PROTOCOL', () => {
    const schemas = byName(getCliReadOnlyNativeToolSchemas());

    assert.ok(schemas.has('read_file'));
    assert.ok(schemas.has('memory_grep'));
    assert.ok(schemas.has('lsp_diagnostics'));
    assert.equal(schemas.has('write_file'), false);
    assert.equal(schemas.has('exec'), false);
    assert.equal(schemas.has('exec_poll'), false);
    assert.equal(schemas.has('exec_list_sessions'), false);
  });

  it('optionally appends GitHub registry schemas for the lead when GitHub tools are advertised', () => {
    const schemas = byName(getCliNativeToolSchemas({ includeGitHub: true }));

    assert.ok(schemas.has('read_file'));
    assert.ok(schemas.has('repo_read'));
    assert.ok(schemas.has('pr_create'));
    assert.ok(schemas.has('pr_merge'));
  });

  it('renames edit_file for Kimi K3 while preserving the executable schema shape', () => {
    const schemas = byName(
      getCliNativeToolSchemas({ provider: 'openrouter', model: 'moonshotai/kimi-k3' }),
    );
    assert.equal(schemas.has('edit_file'), false);
    assert.ok(schemas.has('Edit'));
    assert.ok(schemas.get('Edit').input_schema.properties.old_string);
    assert.ok(schemas.get('Edit').input_schema.properties.new_string);
  });

  it('keeps GLM and DeepSeek on their trained edit_file name', () => {
    for (const [provider, model] of [
      ['zai', 'glm-5.1'],
      ['deepseek', 'deepseek-v4'],
    ]) {
      const schemas = byName(getCliNativeToolSchemas({ provider, model }));
      assert.ok(schemas.has('edit_file'), `${provider}/${model} missing edit_file`);
    }
  });
});

describe('CLI native tool calling gate', () => {
  it('enables curated CLI providers and rejects unknown/free-text ids', () => {
    assert.equal(
      cliProviderModelSupportsNativeToolCalling('openrouter', 'anthropic/claude-sonnet-4.6:nitro'),
      true,
    );
    assert.equal(cliProviderModelSupportsNativeToolCalling('google', 'gemini-3.5-flash'), true);
    assert.equal(cliProviderModelSupportsNativeToolCalling('anthropic', 'claude-sonnet-4-6'), true);
    assert.equal(cliProviderModelSupportsNativeToolCalling('openai', 'gpt-4o'), true);
    assert.equal(cliProviderModelSupportsNativeToolCalling('openai', 'custom-deployment'), false);
    assert.equal(cliProviderModelSupportsNativeToolCalling('openrouter', 'unknown/model'), false);
    assert.equal(cliProviderModelSupportsNativeToolCalling('google', undefined), false);
  });

  it('routes curated CLI evidence through the shared complete profile resolver', () => {
    assert.deepEqual(resolveCliPushCapabilityProfile('anthropic', 'claude-sonnet-4-6'), {
      toolCalling: 'native',
      streamingTools: true,
      multimodal: true,
      structuredOutput: 'strict',
      openaiWire: 'chat-completions',
      contentBlocks: true,
      reasoningBlocks: true,
      context: 'medium',
    });
    assert.equal(
      resolveCliPushCapabilityProfile('cloudflare', '@cf/moonshotai/kimi-k2.7-code').toolCalling,
      'json-text',
      'an absent CLI provider allowlist is a known denial, not a web cold-cache fallback',
    );
  });
});
