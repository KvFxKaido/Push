/**
 * WorkspacePatchCard.test — render coverage for the four `applyState`
 * variants. Snapshot via `renderToStaticMarkup` matches the existing
 * card-test convention (see JobCard.test.tsx).
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkspacePatchCardData } from '@/types';
import { DIFF_MAX_BYTES } from '@/lib/sandbox-client';
import { WorkspacePatchCard } from './WorkspacePatchCard';

const SAMPLE_DIFF = [
  'diff --git a/x.ts b/x.ts',
  'index 0000001..0000002 100644',
  '--- a/x.ts',
  '+++ b/x.ts',
  '@@ -1,1 +1,1 @@',
  '-old',
  '+new',
  '',
].join('\n');

function baseData(overrides: Partial<WorkspacePatchCardData> = {}): WorkspacePatchCardData {
  return {
    schemaVersion: 1,
    repoFullName: 'kvfxkaido/push',
    branch: 'feature/x',
    baseSha: 'a1b2c3',
    diffBytes: SAMPLE_DIFF,
    truncated: false,
    capturedAt: 1_712_345_678_901,
    applyState: { kind: 'pending' },
    ...overrides,
  };
}

describe('WorkspacePatchCard', () => {
  it('renders the pending state with the "will be attempted" copy', () => {
    const html = renderToStaticMarkup(<WorkspacePatchCard data={baseData()} />);
    expect(html).toContain('Pending replay');
    expect(html).toContain('Will be attempted if this sandbox is replaced.');
    // Diff preview surface composed: file count + stats present.
    expect(html).toContain('1 file');
    expect(html).toContain('+1');
    expect(html).toContain('-1');
  });

  it('renders the applied state with the "Replayed" copy', () => {
    const html = renderToStaticMarkup(
      <WorkspacePatchCard
        data={baseData({ applyState: { kind: 'applied', appliedAt: 1_712_345_679_000 } })}
      />,
    );
    expect(html).toContain('Replayed');
    expect(html).toContain('These changes were applied to the new sandbox.');
    expect(html).not.toContain('Already applied');
  });

  it('renders the applied + already-applied note with the no-op copy', () => {
    const html = renderToStaticMarkup(
      <WorkspacePatchCard
        data={baseData({
          applyState: {
            kind: 'applied',
            appliedAt: 1_712_345_679_000,
            note: 'already-applied',
          },
        })}
      />,
    );
    expect(html).toContain('Already applied');
    expect(html).toContain('nothing to replay');
  });

  describe('refused state', () => {
    it('renders calm base-mismatch copy (no "failed" language)', () => {
      const html = renderToStaticMarkup(
        <WorkspacePatchCard
          data={baseData({ applyState: { kind: 'refused', reason: 'base-mismatch' } })}
        />,
      );
      expect(html).toContain('Replay refused');
      expect(html).toContain(
        'Replay refused because the sandbox HEAD no longer matches the captured base.',
      );
      // Explicit anti-drama check — the user asked for calm copy:
      // no "failed" language in the refusal. (Don't broaden this to
      // "error" since `text-push-status-error` shows up in the diff
      // preview's deletion counter class name.)
      expect(html.toLowerCase()).not.toContain('failed');
    });

    it('renders calm truncated copy derived from the cap constant (no drift)', () => {
      const html = renderToStaticMarkup(
        <WorkspacePatchCard
          data={baseData({ applyState: { kind: 'refused', reason: 'truncated' } })}
        />,
      );
      expect(html).toContain('Replay refused');
      // The size is interpolated from DIFF_MAX_BYTES so a future bump
      // of the capture cap doesn't strand stale copy here.
      const expectedKB = `${Math.round(DIFF_MAX_BYTES / 1024)} KB`;
      expect(html).toContain(`clipped at ${expectedKB}`);
    });

    it('renders calm binary-placeholder copy', () => {
      const html = renderToStaticMarkup(
        <WorkspacePatchCard
          data={baseData({ applyState: { kind: 'refused', reason: 'binary-placeholder' } })}
        />,
      );
      expect(html).toContain('Replay refused');
      expect(html).toContain('binary changes');
    });
  });

  it('falls back gracefully for an unknown future applyState kind', () => {
    // A forward-compat card persisted by a newer client could reach
    // the renderer with a `kind` we don't know yet. The exhaustiveness
    // guard must keep the row renderable instead of throwing on
    // `undefined.title`.
    const html = renderToStaticMarkup(
      <WorkspacePatchCard
        data={baseData({
          // Bypass the union type to simulate a future variant.
          applyState: { kind: 'frobnicated' } as unknown as WorkspacePatchCardData['applyState'],
        })}
      />,
    );
    expect(html).toContain('Unknown replay state');
    expect(html).toContain('newer version of Push');
  });

  describe('conflict state', () => {
    it('renders the conflict copy and the detail block', () => {
      const html = renderToStaticMarkup(
        <WorkspacePatchCard
          data={baseData({
            applyState: { kind: 'conflict', detail: 'Applied patch x.ts with conflicts.' },
          })}
        />,
      );
      expect(html).toContain('Replay produced a conflict');
      expect(html).toContain('Files in the new sandbox carry merge markers');
      expect(html).toContain('Applied patch x.ts with conflicts.');
      // Detail not truncated → no truncation marker.
      expect(html).not.toContain('Conflict detail truncated');
    });

    it('promotes the trailing truncation suffix into an explicit marker', () => {
      // The engine appends `\n…[truncated]` to clamped conflict detail.
      // The renderer must lift that into a separate visual line rather
      // than letting the reader hunt for it at end-of-string.
      const detail = 'error: patch failed:\nerror: line 1 conflict\n…[truncated]';
      const html = renderToStaticMarkup(
        <WorkspacePatchCard data={baseData({ applyState: { kind: 'conflict', detail } })} />,
      );
      expect(html).toContain('error: patch failed');
      expect(html).toContain('Conflict detail truncated for storage.');
      // The raw suffix is stripped from the pre block — render only the body.
      // Use a structural check: the truncation marker should appear in its
      // own element, not embedded in the <pre>.
      const preMatch = html.match(/<pre[^>]*>([^]*?)<\/pre>/);
      expect(preMatch).not.toBeNull();
      if (preMatch) {
        expect(preMatch[1]).not.toContain('…[truncated]');
      }
    });
  });
});
