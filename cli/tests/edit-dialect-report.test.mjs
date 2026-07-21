import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildEditDialectReport,
  EDIT_DIALECT_PROTOCOL_MARKER,
  extractFirstJsonObject,
  formatEditDialectReport,
} from '../edit-dialect-report.ts';

async function writeSession(root, id, { model = 'glm-5.1', dialect = false, results = [] }) {
  const dir = path.join(root, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ sessionId: id, model }));
  const messages = [
    {
      role: 'system',
      content: `TOOLS\n${dialect ? EDIT_DIALECT_PROTOCOL_MARKER : 'edit_file(path, edits)'}`,
    },
    ...results.map((result) => ({
      role: 'user',
      content: `[TOOL_RESULT]\n${JSON.stringify(result, null, 2)}\n[meta] {"round":2}\n[/TOOL_RESULT]`,
    })),
  ];
  await fs.writeFile(
    path.join(dir, 'messages.jsonl'),
    `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`,
  );
}

describe('edit dialect rollout report', () => {
  it('extracts the tool result without consuming the trailing meta object', () => {
    assert.deepEqual(
      extractFirstJsonObject('[TOOL_RESULT]\n{"tool":"edit_file","ok":true}\n[meta] {"round":2}'),
      { tool: 'edit_file', ok: true },
    );
  });

  it('cohorts by protocol marker and waits for an equal-size after sample', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-edit-dialect-report-'));
    try {
      await writeSession(root, 'before', {
        results: [
          {
            tool: 'edit_file',
            ok: false,
            output: 'Tool error: Invalid ref "2"',
            structuredError: { message: 'Invalid ref "2"' },
          },
          { tool: 'edit_file', ok: true, output: 'Applied edit' },
        ],
      });
      await writeSession(root, 'after', {
        dialect: true,
        results: [{ tool: 'edit_file', ok: true, output: 'Applied search/replace edit' }],
      });
      await writeSession(root, 'other-model', {
        model: 'kimi-k3',
        dialect: true,
        results: [{ tool: 'edit_file', ok: false, output: 'ignored' }],
      });

      const report = await buildEditDialectReport({
        sessionRoot: root,
        minimumAfterEditCalls: 2,
        generatedAt: '2026-07-21T00:00:00.000Z',
      });
      assert.equal(report.scannedSessions, 3);
      assert.equal(report.matchingSessions, 2);
      assert.deepEqual(report.before, {
        sessions: 1,
        editCalls: 2,
        errors: 1,
        invalidRefErrors: 1,
        errorRate: 0.5,
      });
      assert.equal(report.after.editCalls, 1);
      assert.deepEqual(report.verdict, { status: 'pending', remainingEditCalls: 1 });
      assert.match(formatEditDialectReport(report), /Before: 1\/2 edit errors \(50\.0%\)/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reports the absolute and relative change once the after cohort is large enough', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-edit-dialect-ready-'));
    try {
      await writeSession(root, 'before', {
        results: [
          { tool: 'edit_file', ok: false, output: 'failed' },
          { tool: 'edit_file', ok: true, output: 'ok' },
        ],
      });
      await writeSession(root, 'after', {
        dialect: true,
        results: [
          { tool: 'edit_file', ok: true, output: 'ok' },
          { tool: 'edit_file', ok: true, output: 'ok' },
        ],
      });
      const report = await buildEditDialectReport({ sessionRoot: root, minimumAfterEditCalls: 2 });
      assert.deepEqual(report.verdict, {
        status: 'ready',
        errorRateDelta: -0.5,
        relativeErrorReduction: 1,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
