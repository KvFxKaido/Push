import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readmeSource = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const rawProviderSource = readFileSync(new URL('../provider.ts', import.meta.url), 'utf8');
const providerModelsSource = readFileSync(
  new URL('../../lib/provider-models.ts', import.meta.url),
  'utf8',
);
const cliSource = readFileSync(new URL('../cli.ts', import.meta.url), 'utf8');
const toolsSource = readFileSync(new URL('../tools.ts', import.meta.url), 'utf8');

// Some provider defaults were refactored from inline string literals to
// named constants exported from `lib/provider-models.ts` (e.g.
// `OLLAMA_DEFAULT_MODEL`). The regex extractor below looks for quoted
// string literals inside each provider's config block, so it can't follow
// that indirection. Pre-process `provider.ts` by inlining every known
// `export const NAME = 'value'` from `provider-models.ts` into the
// `PROVIDER_CONFIGS` block so the regex sees string literals where it
// expects them.
//
// NOTE: this is a pragmatic band-aid. The correct long-term fix is to
// dynamically `import()` `provider.ts` in a test harness with env vars
// cleared and read `PROVIDER_CONFIGS` values directly. That's a bigger
// refactor and out of scope for the CI-wiring PR that unblocked this.
const stringConstPattern = /^export const ([A-Z_][A-Z0-9_]*) = '([^']+)'/gm;
const inlinedConstants = new Map();
for (const match of providerModelsSource.matchAll(stringConstPattern)) {
  const [, name, value] = match;
  inlinedConstants.set(name, value);
}

const providerSource = rawProviderSource.replace(
  /(export const PROVIDER_CONFIGS[^=]*= \{[\s\S]*?\n\};)/,
  (block) => {
    let patched = block;
    for (const [name, value] of inlinedConstants) {
      patched = patched.replace(new RegExp(`\\b${name}\\b`, 'g'), `'${value}'`);
    }
    return patched;
  },
);

function extractProviderConfigsBlock(source) {
  const match = source.match(/export const PROVIDER_CONFIGS[^=]*= \{([\s\S]*?)\n\};/);
  assert.ok(match, 'Expected to find PROVIDER_CONFIGS');
  return match[1];
}

function extractCliProviderEntries(source) {
  const block = extractProviderConfigsBlock(source);
  const entryRegex = /^\s{2}([a-z]+):\s*\{([\s\S]*?)^\s{2}\},?$/gm;
  const entries = [];

  for (const match of block.matchAll(entryRegex)) {
    const [, providerId, entryBody] = match;
    // `url:` and `defaultModel:` may span multiple lines when the value is a
    // long `process.env.X || process.env.Y || 'fallback'` chain (see the
    // `ollama` entry in cli/provider.ts). `[\s\S]+?` matches across newlines
    // non-greedily, and the `,\s*\n` terminator anchors on a comma at the
    // end of the line so we don't accidentally stop at a comma inside an
    // array or function argument list.
    const urlLine = entryBody.match(/url:\s*([\s\S]+?),\s*\n/);
    const defaultModelLine = entryBody.match(/defaultModel:\s*([\s\S]+?),\s*\n/);
    const requiresKeyLine = entryBody.match(/requiresKey:\s*(true|false)/);

    assert.ok(urlLine, `Expected ${providerId} to define url`);
    assert.ok(defaultModelLine, `Expected ${providerId} to define defaultModel`);
    assert.ok(requiresKeyLine, `Expected ${providerId} to define requiresKey`);

    const urlStrings = [...urlLine[1].matchAll(/'([^']+)'/g)].map(([, value]) => value);
    const modelStrings = [...defaultModelLine[1].matchAll(/'([^']+)'/g)].map(([, value]) => value);

    assert.ok(urlStrings.length > 0, `Expected ${providerId} url line to include a default string`);
    assert.ok(
      modelStrings.length > 0,
      `Expected ${providerId} defaultModel line to include a default string`,
    );

    entries.push({
      id: providerId,
      url: urlStrings[urlStrings.length - 1],
      defaultModel: modelStrings[modelStrings.length - 1],
      requiresKey: requiresKeyLine[1] === 'true',
    });
  }

  return entries;
}

function extractSetValues(source, setName) {
  const match = source.match(new RegExp(`const ${setName} = new Set\\(\\[([^\\]]+)\\]\\)`));
  assert.ok(match, `Expected to find ${setName}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map(([, value]) => value);
}

function extractObjectEntries(source, constName) {
  const match = source.match(new RegExp(`const ${constName} = \\{([\\s\\S]*?)\\n\\};`));
  assert.ok(match, `Expected to find ${constName}`);
  return [...match[1].matchAll(/^\s+([a-z]+):\s+'([^']+)',?$/gm)].map(([, key, value]) => ({
    key,
    value,
  }));
}

function extractReadmeTableRows(source) {
  return source
    .split('\n')
    .filter((line) => /^\| `[^`]+` \|/.test(line))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
}

function extractReadmeEnvVarRows(source) {
  const rows = extractReadmeTableRows(source);
  const envRows = rows.filter(([variable]) => variable.startsWith('`PUSH_'));
  return new Map(envRows.map(([variable, purpose]) => [variable.slice(1, -1), purpose]));
}

function extractReadmeProviderRows(source) {
  const rows = extractReadmeTableRows(source);
  return rows
    .filter(([provider]) =>
      [
        '`ollama`',
        '`openrouter`',
        '`zen`',
        '`nvidia`',
        '`kilocode`',
        '`blackbox`',
        '`openadapter`',
      ].includes(provider),
    )
    .map(([provider, model, requiresKey]) => ({
      id: provider.slice(1, -1),
      defaultModel: model.slice(1, -1),
      requiresKey,
    }));
}

function extractBacktickList(text) {
  return [...text.matchAll(/`([^`]+)`/g)].map(([, value]) => value);
}

function extractReadmeOptionValues(source, optionName) {
  const escaped = optionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`^\\s+${escaped}\\s+(.+)$`, 'm'));
  assert.ok(match, `Expected to find README option ${optionName}`);
  return match[1];
}

describe('README config parity', () => {
  const providerEntries = extractCliProviderEntries(providerSource);
  const readmeEnvRows = extractReadmeEnvVarRows(readmeSource);
  const readmeProviderRows = extractReadmeProviderRows(readmeSource);
  const searchBackendsFromCli = extractSetValues(cliSource, 'SEARCH_BACKENDS');
  const searchBackendsFromTools = extractSetValues(toolsSource, 'WEB_SEARCH_BACKENDS');
  const deprecatedProviders = extractObjectEntries(cliSource, 'DEPRECATED_PROVIDERS');

  it('documents provider URLs and default models that match cli/provider.ts', () => {
    for (const provider of providerEntries) {
      const upper = provider.id.toUpperCase();
      const urlRow = readmeEnvRows.get(`PUSH_${upper}_URL`);
      const modelRow = readmeEnvRows.get(`PUSH_${upper}_MODEL`);

      assert.ok(urlRow, `Expected README to document PUSH_${upper}_URL`);
      assert.ok(modelRow, `Expected README to document PUSH_${upper}_MODEL`);
      assert.ok(
        urlRow.includes(`default: \`${provider.url}\``),
        `Expected PUSH_${upper}_URL doc to include default ${provider.url}`,
      );
      assert.ok(
        modelRow.includes(`default: \`${provider.defaultModel}\``),
        `Expected PUSH_${upper}_MODEL doc to include default ${provider.defaultModel}`,
      );
    }
  });

  it('documents the same provider table defaults and key requirements as cli/provider.ts', () => {
    assert.deepEqual(
      readmeProviderRows,
      providerEntries.map((provider) => ({
        id: provider.id,
        defaultModel: provider.defaultModel,
        requiresKey: provider.requiresKey ? 'Yes' : 'No',
      })),
    );
  });

  it('documents the same provider options and deprecated-provider redirects as cli/cli.ts', () => {
    const providerOptionTail = extractReadmeOptionValues(readmeSource, '--provider <name>');
    assert.equal(
      providerOptionTail,
      `${providerEntries.map((provider) => provider.id).join(' | ')} (default: ollama)`,
    );

    const deprecatedSentence = readmeSource.match(
      /Removed providers \(([^)]+)\) are gracefully redirected to `([^`]+)`/,
    );
    assert.ok(deprecatedSentence, 'Expected README deprecated provider note');

    const deprecatedIds = extractBacktickList(deprecatedSentence[1]);
    assert.deepEqual(
      deprecatedIds,
      deprecatedProviders.map(({ key }) => key),
    );
    assert.ok(
      deprecatedProviders.every(({ value }) => value === deprecatedSentence[2]),
      'Expected all deprecated providers to redirect to the README replacement target',
    );
  });

  it('documents the same web search backend options as the CLI runtime', () => {
    assert.deepEqual(searchBackendsFromCli, searchBackendsFromTools);

    const backendRow = readmeEnvRows.get('PUSH_WEB_SEARCH_BACKEND');
    assert.ok(backendRow, 'Expected README to document PUSH_WEB_SEARCH_BACKEND');
    assert.deepEqual(extractBacktickList(backendRow), searchBackendsFromCli);

    const backendOptionTail = extractReadmeOptionValues(readmeSource, '--search-backend <mode>');
    assert.equal(backendOptionTail, searchBackendsFromCli.join(' | '));
  });
});
