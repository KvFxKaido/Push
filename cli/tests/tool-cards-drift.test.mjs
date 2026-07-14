/**
 * tool-cards-drift.test.mjs — the card vocabulary is single-sourced.
 *
 * The render payload is cross-surface semantics: the web `CardRenderer` and the
 * TUI dispatch on the SAME `ToolCard` union. When that vocabulary lived on one
 * surface (`app/src/types/index.ts`), the other surface had to *guess* — which
 * is exactly how the TUI ended up regex-sniffing tool output for diffs
 * (`looksLikeUnifiedDiff`) and guessing which argument mattered.
 *
 * These tests fail if the vocabulary starts to re-diverge. They are deliberately
 * source-text assertions rather than type assertions: the failure mode being
 * guarded is "someone declares a card type on a surface," which typechecks fine
 * and is invisible to every other test in the repo.
 *
 * See `docs/decisions/Tool Render Payload — Cards Are Declared, Not Sniffed.md`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIB_CARDS = readFileSync(join(ROOT, 'lib', 'tool-cards.ts'), 'utf8');
const WEB_TYPES = readFileSync(join(ROOT, 'app', 'src', 'types', 'index.ts'), 'utf8');

/**
 * The canonical union membership, pinned. Adding a card type is a deliberate
 * act that must touch this list — which is the point: a new card that no shell
 * knows how to render should be a conscious decision, not a surprise.
 */
const TOOL_CARD_TYPES = [
  'approval',
  'artifact',
  'ask-user',
  'audit-verdict',
  'branch-list',
  'ci-status',
  'coder-job',
  'coder-progress',
  'commit-files',
  'commit-list',
  'commit-review',
  'delegation-result',
  'diff-preview',
  'editor',
  'evaluation',
  'file',
  'file-list',
  'file-search',
  'pr',
  'pr-list',
  'sandbox',
  'sandbox-download',
  'sandbox-state',
  'test-results',
  'type-check',
  'web-search',
  'workflow-logs',
  'workflow-runs',
  'workspace-patch',
];

/**
 * Slice out the `ToolCard` union body. Naively cutting at the first `;` does
 * NOT work — every union member contains one (`{ type: 'pr'; data: PRCardData }`)
 * — so walk lines until one ends with `;` at brace depth 0.
 */
function toolCardUnionBody(source) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.startsWith('export type ToolCard ='));
  assert.notEqual(start, -1, 'lib/tool-cards.ts must declare `export type ToolCard`');
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    depth += (lines[i].match(/\{/g) ?? []).length - (lines[i].match(/\}/g) ?? []).length;
    if (depth === 0 && lines[i].trimEnd().endsWith(';')) {
      return lines.slice(start, i + 1).join('\n');
    }
  }
  throw new Error('unterminated ToolCard union');
}

function unionMembers(source) {
  return [...toolCardUnionBody(source).matchAll(/type:\s*'([a-z-]+)'/g)].map((m) => m[1]).sort();
}

describe('tool-card vocabulary — single source of truth', () => {
  it('ToolCard is declared in lib/, not on a surface', () => {
    assert.match(LIB_CARDS, /export type ToolCard =/);
  });

  it('the union membership matches the pin', () => {
    assert.deepEqual(unionMembers(LIB_CARDS), [...TOOL_CARD_TYPES].sort());
  });

  it('the web surface does not re-declare the union under ANY name', () => {
    // Name-agnostic on purpose. Pinning the identifier `ChatCard` would let a
    // future surface reintroduce the union under a different alias
    // (`export type CardKind = | { type: 'pr'; data: PRCardData } | ...`) and
    // walk straight past the guard. So match the *structural shape* of a union
    // member instead — `{ type: '<kebab>'; data: <Ident> }`. That shape appears
    // 29 times in lib/tool-cards.ts and zero times anywhere on the web surface,
    // so it identifies a card union regardless of what it is called.
    const members = [...WEB_TYPES.matchAll(/\{\s*type:\s*'[a-z-]+';\s*data:\s*\w+\s*\}/g)].map(
      (m) => m[0],
    );
    assert.deepEqual(
      members,
      [],
      `the card union must live in lib/tool-cards.ts, not be re-declared on a surface. Found: ${members.join(' | ')}`,
    );

    // Belt and braces: the back-compat alias must stay an alias.
    // `export type ChatCard = ToolCard` is fine; `= | { ... }` is not.
    assert.doesNotMatch(
      WEB_TYPES,
      /export type ChatCard\s*=\s*\r?\n?\s*\|/,
      'ChatCard must alias ToolCard from lib/, not redeclare the union',
    );
  });

  it('the web surface declares no *CardData shapes of its own', () => {
    const local = [...WEB_TYPES.matchAll(/export (?:interface|type) (\w*CardData)\b/g)].map(
      (m) => m[1],
    );
    assert.deepEqual(
      local,
      [],
      `card data shapes must live in lib/tool-cards.ts, not app/src/types/index.ts. Found: ${local.join(', ')}`,
    );
  });

  it('CoderWorkingMemory and AskUserCardData are not duplicated on the web surface', () => {
    // Both were previously declared in BOTH lib/ and app/src/types/index.ts, and
    // `CoderWorkingMemory` had already drifted — the web copy was missing
    // `validationCommands`. A duplicate typechecks fine and silently diverges.
    for (const name of ['CoderWorkingMemory', 'AskUserCardData']) {
      assert.doesNotMatch(
        WEB_TYPES,
        new RegExp(`export interface ${name}\\b`),
        `${name} must be imported from lib/, not re-declared on the web surface`,
      );
    }
  });

  it('every card type in the union has a data shape reachable from lib/', () => {
    const body = toolCardUnionBody(LIB_CARDS);
    const shapes = [...body.matchAll(/data:\s*(\w+)/g)].map((m) => m[1]);
    assert.equal(shapes.length, TOOL_CARD_TYPES.length, 'every member must carry a data shape');
    const preamble = LIB_CARDS.slice(0, LIB_CARDS.indexOf('export type ToolCard'));
    for (const shape of shapes) {
      const declared = new RegExp(`export (?:interface|type) ${shape}\\b`).test(LIB_CARDS);
      const imported = new RegExp(`\\b${shape}\\b`).test(preamble);
      assert.ok(
        declared || imported,
        `${shape} is neither declared nor imported in lib/tool-cards.ts`,
      );
    }
  });
});

describe('isToolCard — the untyped-boundary guard', () => {
  it('accepts a real card', async () => {
    const { isToolCard } = await import('../../lib/tool-cards.ts');
    assert.equal(isToolCard({ type: 'ci-status', data: { checks: [] } }), true);
  });

  it('rejects foreign values that would otherwise ride the run event', async () => {
    const { isToolCard } = await import('../../lib/tool-cards.ts');
    // The CLI lifts this off an UNTYPED `meta` bag (cli/tools.ts), so the guard
    // is the only thing between a stray meta field and `tool.execution_complete`.
    for (const bad of [
      null,
      undefined,
      'ci-status',
      42,
      [],
      {},
      { type: 'ci-status' }, // no data
      { type: 'not-a-card', data: {} }, // unknown discriminant
      { data: {} }, // no type
      { type: 'ci-status', data: null },
    ]) {
      assert.equal(isToolCard(bad), false, `should reject ${JSON.stringify(bad)}`);
    }
  });

  it('TOOL_CARD_TYPES matches the union pin', async () => {
    const mod = await import('../../lib/tool-cards.ts');
    assert.deepEqual([...mod.TOOL_CARD_TYPES].sort(), [...TOOL_CARD_TYPES].sort());
  });

  it('keeps an unknown future card as a renderable envelope, not a known producer card', async () => {
    const { isToolCard, isToolCardPayload } = await import('../../lib/tool-cards.ts');
    const future = { type: 'future-card', data: { version: 2 } };
    assert.equal(isToolCardPayload(future), true);
    assert.equal(isToolCard(future), false);
    assert.equal(isToolCardPayload({ type: '', data: {} }), false);
    assert.equal(isToolCardPayload({ type: 'ci-status', data: [] }), false);
  });
});

describe('the CLI lead lane actually lifts the card', () => {
  // Codex caught this on PR #1456: Slice 1 removed the CLI's *type* barrier
  // (`TCard = unknown`) but left the *data path* broken — `cli/lead-turn.ts`
  // lifted `meta.editDiff` off the untyped tool-result bag and never
  // `meta.card`. GitHub tools (pr_list, ci_status, ...) return a card under
  // `meta.card` (cli/tools.ts), so CLI lead runs emitted `tool.execution_complete`
  // with no card and the TUI stayed blind.
  //
  // A source-shape assertion, not a behavioural one: driving it end-to-end needs
  // a mocked GitHub API, and the failure being guarded is "someone deletes the
  // lift" — which is exactly what source shape catches.
  const LEAD_TURN = readFileSync(join(ROOT, 'cli', 'lead-turn.ts'), 'utf8');
  const NORMAL_TOOL_EXEC = LEAD_TURN.slice(
    LEAD_TURN.indexOf('// Synthesize the start event'),
    LEAD_TURN.indexOf('const callbacks: CoderAgentCallbacks'),
  );

  it('validates the card at the untyped meta boundary', () => {
    assert.match(
      LEAD_TURN,
      /isToolCard\(metaCard\)/,
      '`meta` is untyped — the card must go through isToolCard() before it can ride the run event',
    );
  });

  it('carries the card on BOTH executed return paths (ok and tool-reported-failure)', () => {
    const spreads = NORMAL_TOOL_EXEC.match(/\.\.\.\(card \? \{ card \} : \{\}\)/g) ?? [];
    assert.equal(
      spreads.length,
      2,
      'both `kind: executed` returns must spread the card — a failing tool still has a card to render',
    );
    // Mirrors editDiff, which proved the pattern; if that count changes, this should too.
    const diffSpreads =
      NORMAL_TOOL_EXEC.match(/\.\.\.\(editDiff \? \{ editDiff \} : \{\}\)/g) ?? [];
    assert.equal(spreads.length, diffSpreads.length, 'card must ride wherever editDiff rides');
  });
});
