import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatToolGroupSummary,
  formatToolTitle,
  getToolVerbNoun,
  pluralNoun,
  TOOL_VERB_NOUN,
  withArticle,
} from '../../lib/tool-display.ts';
import { getToolTargetDetail } from '../../lib/tool-target-detail.ts';
import { VERB_BY_TOOL } from '../tui-verbs.ts';

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

  it('never lets a verb swallow its own noun — on EITHER rendering path', () => {
    // "Searched a search" shipped, and after it was fixed in `formatToolTitle`
    // the group summary still rendered "Searched 1 search" — because the first
    // version of THIS test iterated the whole table and called only one of the
    // two functions that consume it. Exhaustive over entries, blind to half the
    // call paths. Both are asserted now, and both go through `formatToolTitle`.
    for (const name of Object.keys(TOOL_VERB_NOUN)) {
      const { verb, noun } = getToolVerbNoun(name);
      if (noun.toLowerCase() !== verb.toLowerCase().replace(/ed$|d$/, '')) continue;
      assert.equal(formatToolTitle(name), verb, `title: ${name}`);
      // A singleton bucket in a mixed group renders through the same helper.
      assert.equal(
        formatToolGroupSummary([{ toolName: name }, { toolName: 'read_file' }]),
        `${verb}, Read a file`,
        `group summary: ${name}`,
      );
    }
    assert.equal(formatToolTitle('search_files'), 'Searched');
    assert.equal(formatToolTitle('web_search'), 'Searched');
    // The fix is the noun, not a special case: 'list' became 'directory', so
    // the ordinary article form is available again.
    assert.equal(formatToolTitle('list_dir'), 'Listed a directory');
  });

  it('falls back to the article + noun when no target is present', () => {
    assert.equal(formatToolTitle('read_file'), 'Read a file');
    assert.equal(formatToolTitle('sandbox_exec', ''), 'Ran a command');
    assert.equal(formatToolTitle('sandbox_exec', '   '), 'Ran a command');
    assert.equal(formatToolTitle('list_issues'), 'Fetched an issue list');
    assert.equal(formatToolTitle('totally_made_up_tool'), 'totally_made_up_tool');
    assert.equal(formatToolTitle(''), 'Used a tool');
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

  it('summarizes homogeneous and mixed tool groups in first-seen order', () => {
    // Aliases fold into one bucket: read_file + sandbox_read_file are one verb.
    assert.equal(
      formatToolGroupSummary([
        { toolName: 'read_file', target: 'a.ts' },
        { toolName: 'sandbox_read_file', target: 'b.ts' },
      ]),
      'Read 2 files',
    );
    // Was 'Read 2 files, Ran 1 command'. A bucket of one now renders through
    // `formatToolTitle` rather than being counted — "1 command" is a count of
    // one, which summarizes nothing, and with a target present it actively
    // discarded it ("Ran 1 command" for a known "pnpm test").
    assert.equal(
      formatToolGroupSummary([
        { toolName: 'read_file' },
        { toolName: 'sandbox_exec' },
        { toolName: 'read_file' },
      ]),
      'Read 2 files, Ran a command',
    );
  });

  it('keeps a single grouped call concrete and tolerates an empty group', () => {
    assert.equal(
      formatToolGroupSummary([{ toolName: 'read_file', target: 'README.md' }]),
      'Read README.md',
    );
    assert.equal(formatToolGroupSummary([]), '');
  });
});

describe('tool-display covers every tool the CLI will name', () => {
  // The guard that did not exist. `VERB_BY_TOOL` (cli/tui-verbs.ts) and
  // `TOOL_VERB_NOUN` (lib/tool-display.ts) are ONE vocabulary in two tenses:
  // the first names a tool while it runs ("reading"), the second once it has
  // settled ("Read a file"). A tool in one and not the other is a tool the UI
  // has an opinion about in the present and none in the past.
  //
  // It had drifted to 23 of 78 — `write_file`, `edit_file`, `git_commit`,
  // `git_diff`, `list_dir`, `grep` and more all rendered "Used <target>",
  // because the display table was built from the sandbox/web tool names and the
  // CLI-native ones were never added (they are deliberately absent from
  // TOOL_SPECS, so `resolveToolName` returns null and the lookup falls to the
  // `default` entry). Every existing test passed: they spot-checked names that
  // happened to be present.
  it('has a display entry for every tool with a live verb', () => {
    const missing = Object.keys(VERB_BY_TOOL).filter(
      (name) => getToolVerbNoun(name) === TOOL_VERB_NOUN.default,
    );
    assert.deepEqual(
      missing,
      [],
      `${missing.length} tool(s) have a live verb but no settled display entry, so they ` +
        `render as "Used …": ${missing.join(', ')}. Add them to TOOL_VERB_NOUN.`,
    );
  });
});

describe('tool targets — the salient argument, not the first one that matches', () => {
  it('names what a search looked FOR, not where it looked', () => {
    // `search_files` takes {pattern, path?}. The path is the haystack; reporting
    // it drops the term and answers a question nobody asked. This is the actual
    // cause of "Searched a search": the pattern was never extracted, so the
    // title had no target and fell through to the article form.
    assert.equal(getToolTargetDetail('search_files', { pattern: 'gateway' }), 'gateway');
    assert.equal(
      getToolTargetDetail('search_files', { pattern: 'gateway', path: 'src/' }),
      'gateway',
      'the optional path outranked the pattern',
    );
    assert.equal(getToolTargetDetail('grep', { pattern: 'foo' }), 'foo');
    assert.equal(getToolTargetDetail('web_search', { query: 'silvery' }), 'silvery');
  });

  it('extracts the CLI-native tools the web-shaped extractor never knew about', () => {
    assert.equal(getToolTargetDetail('exec_start', { command: 'pnpm dev' }), 'pnpm dev');
    assert.equal(getToolTargetDetail('git_commit', { message: 'feat: thing' }), 'feat: thing');
    assert.equal(getToolTargetDetail('git_create_branch', { name: 'feat/x' }), 'feat/x');
    assert.equal(getToolTargetDetail('fetch_url', { url: 'https://x.dev' }), 'https://x.dev');
  });

  it('renders the screenshot regressions correctly end to end', () => {
    // Each of these was observed in a real TUI transcript.
    const title = (tool, args) => formatToolTitle(tool, getToolTargetDetail(tool, args));
    assert.equal(title('list_dir', { path: '.kilo' }), 'Listed .kilo');
    assert.equal(title('search_files', { pattern: 'gateway' }), 'Searched gateway');
    assert.equal(title('read_file', { path: '.kilo/package.json' }), 'Read .kilo/package.json');
    assert.equal(title('write_file', { path: 'src/a.ts' }), 'Wrote src/a.ts');
    assert.equal(title('git_commit', { message: 'feat: thing' }), 'Committed feat: thing');
  });
});

describe('tool group summary — a count of one is not a summary', () => {
  it('renders a singleton bucket concretely instead of counting it', () => {
    // The row from a real transcript, which read
    // "Listed 1 directory, Read 1 file, Searched 1 search" — three counts of
    // one, each discarding a target the group was already holding.
    assert.equal(
      formatToolGroupSummary([
        { toolName: 'list_dir', target: '.kilo' },
        { toolName: 'read_file', target: '.kilo/package.json' },
        { toolName: 'search_files', target: 'gateway' },
      ]),
      'Listed .kilo, Read .kilo/package.json, Searched gateway',
    );
    assert.equal(
      formatToolGroupSummary([
        { toolName: 'sandbox_exec', target: 'pnpm test' },
        { toolName: 'list_dir', target: 'src' },
      ]),
      'Ran pnpm test, Listed src',
    );
  });

  it('still counts a bucket that actually aggregates, and mixes both forms', () => {
    assert.equal(
      formatToolGroupSummary([
        { toolName: 'read_file', target: 'a.ts' },
        { toolName: 'read_file', target: 'b.ts' },
      ]),
      'Read 2 files',
    );
    // Counted where it aggregates, concrete where it doesn't — in one row.
    assert.equal(
      formatToolGroupSummary([
        { toolName: 'read_file', target: 'a.ts' },
        { toolName: 'read_file', target: 'b.ts' },
        { toolName: 'sandbox_exec', target: 'pnpm test' },
      ]),
      'Read 2 files, Ran pnpm test',
    );
  });

  it('falls back to the noun when a singleton bucket has no target', () => {
    assert.equal(
      formatToolGroupSummary([{ toolName: 'read_file' }, { toolName: 'sandbox_exec' }]),
      'Read a file, Ran a command',
    );
  });
});
