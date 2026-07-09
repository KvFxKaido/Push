import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEPRECATED_PROVIDERS, PROVIDER_CONFIGS } from '../provider.ts';
import { getCliProviderDefinitions } from '../../lib/provider-definition.ts';

const readmeSource = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const cliSource = readFileSync(new URL('../cli.ts', import.meta.url), 'utf8');
const toolsSource = readFileSync(new URL('../tools.ts', import.meta.url), 'utf8');

function withClearedCliEnv(fn) {
  const envVars = new Set();
  for (const def of getCliProviderDefinitions()) {
    assert.ok(def.cli, `Expected ${def.id} to carry CLI metadata`);
    envVars.add(def.cli.modelEnvVar);
    for (const envVar of def.cli.urlEnvVars) envVars.add(envVar);
  }

  const previous = new Map();
  for (const envVar of envVars) {
    previous.set(envVar, process.env[envVar]);
    delete process.env[envVar];
  }

  try {
    return fn();
  } finally {
    for (const [envVar, value] of previous) {
      if (value === undefined) {
        delete process.env[envVar];
      } else {
        process.env[envVar] = value;
      }
    }
  }
}

function providerEntriesFromRuntime() {
  return withClearedCliEnv(() =>
    Object.values(PROVIDER_CONFIGS).map((provider) => ({
      id: provider.id,
      url: provider.url,
      defaultModel: provider.defaultModel,
      requiresKey: provider.requiresKey,
    })),
  );
}

function extractSetValues(source, setName) {
  const match = source.match(new RegExp(`const ${setName} = new Set\\(\\[([^\\]]+)\\]\\)`));
  assert.ok(match, `Expected to find ${setName}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map(([, value]) => value);
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
  const providerIds = new Set(Object.keys(PROVIDER_CONFIGS).map((provider) => `\`${provider}\``));
  const rows = extractReadmeTableRows(source);
  return rows
    .filter(([provider]) => providerIds.has(provider))
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
  const providerEntries = providerEntriesFromRuntime();
  const readmeEnvRows = extractReadmeEnvVarRows(readmeSource);
  const readmeProviderRows = extractReadmeProviderRows(readmeSource);
  const searchBackendsFromCli = extractSetValues(cliSource, 'SEARCH_BACKENDS');
  const searchBackendsFromTools = extractSetValues(toolsSource, 'WEB_SEARCH_BACKENDS');
  // The map lives in provider.ts (shared by cli/tui/pushd/session-store) and
  // is imported directly — no source parsing needed.
  const deprecatedProviders = Object.entries(DEPRECATED_PROVIDERS).map(([key, value]) => ({
    key,
    value,
  }));

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
