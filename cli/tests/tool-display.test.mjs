import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatToolTitle,
  getToolVerbNoun,
  pluralNoun,
  withArticle,
} from '../../lib/tool-display.ts';

describe('tool-display vocabulary', () => {
  it('maps canonical tool names to a verb + noun', () => {
    assert.deepEqual(getToolVerbNoun('read_file'), { verb: 'Read', noun: 'file' });
    assert.deepEqual(getToolVerbNoun('sandbox_exec'), { verb: 'Ran', noun: 'command' });
    assert.deepEqual(getToolVerbNoun('sandbox_edit_file'), { verb: 'Edited', noun: 'file' });
  });

  it('falls back to the default entry for unknown tools', () => {
    assert.deepEqual(getToolVerbNoun('totally_made_up_tool'), { verb: 'Used', noun: 'tool' });
  });

  it('prefers the concrete target for the compact title', () => {
    assert.equal(formatToolTitle('read_file', 'README.md'), 'Read README.md');
    assert.equal(formatToolTitle('sandbox_exec', 'pnpm test'), 'Ran pnpm test');
    assert.equal(formatToolTitle('search_files', 'TODO'), 'Searched TODO');
  });

  it('falls back to the article + noun when no target is present', () => {
    assert.equal(formatToolTitle('read_file'), 'Read a file');
    assert.equal(formatToolTitle('sandbox_exec', ''), 'Ran a command');
    assert.equal(formatToolTitle('sandbox_exec', '   '), 'Ran a command');
    assert.equal(formatToolTitle('list_issues'), 'Fetched an issue list');
    assert.equal(formatToolTitle('totally_made_up_tool'), 'Used a tool');
  });

  it('articles and pluralizes the vocabulary nouns correctly', () => {
    assert.equal(withArticle('file'), 'a file');
    assert.equal(withArticle('issue list'), 'an issue list');
    assert.equal(pluralNoun('file'), 'files');
    assert.equal(pluralNoun('search'), 'searches');
    assert.equal(pluralNoun('branch'), 'branches');
    assert.equal(pluralNoun('memory'), 'memories');
    assert.equal(pluralNoun('push'), 'pushes');
  });
});
