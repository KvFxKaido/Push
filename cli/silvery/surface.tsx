import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  Box,
  countVisualLines,
  ListView,
  ModalDialog,
  Screen,
  Text,
  TextArea,
  TextInput,
  useApp,
  useInput,
  useStdout,
} from 'silvery';

import { getTranscriptRoleLabel } from '../../lib/role-display.js';
import { formatToolTitle } from '../../lib/tool-display.js';
import { resolveContextWindow } from '../../lib/context-budget.js';
import { formatToolCard } from '../tool-card-format.js';
import { getCuratedModels } from '../model-catalog.js';
import { getProviderList } from '../provider.js';
import { createTabCompleter, type CompletionState } from '../tui-completer.js';
import { FocusStack } from '../tui-focus.js';
import { getListNavigationAction } from '../tui-modal-input.js';
import { isReducedMotion, verbForActivity, type StatusActivity } from '../tui-verbs.js';
import { estimateTokens, formatElapsed, formatTokenCount } from '../tui-status.js';
import { detectUnicode } from '../tui-theme.js';
import type { SilveryController, SilverySnapshot, SilveryTranscriptItem } from './controller.js';
import { MarkdownBody } from './markdown.js';
import { PushThemeProvider } from './theme.js';
import {
  groupSilveryTranscriptRows,
  type SilveryTranscriptToolGroup,
} from './transcript-groups.js';
import {
  countUserTurns,
  densityMeter,
  diffLineColor,
  footerKeybinds,
  createModalMotionState,
  formatTurnTimestamp,
  brandShimmerColors,
  headerSegments,
  livenessHex,
  MOTION_TICKS,
  modalFadeAmount,
  modeLabel,
  PUSH_BRAND_ART_COLS,
  pushBrandArt,
  reduceModalMotion,
  resolveGlyphs,
  shortenPath,
  streamMark,
  verbShimmerColors,
  VL_COLOR,
  type FooterScope,
  type ModalMotionState,
  type StreamMarkKind,
} from './visual-language.js';

const COMMANDS = [
  { id: 'config', label: 'Open config', hint: 'edit API keys in a masked field' },
  { id: 'resume', label: 'Resume session', hint: 'browse saved conversations' },
  { id: 'model', label: 'Switch model', hint: 'pick a curated model' },
  { id: 'provider', label: 'Switch provider', hint: 'pick a provider' },
  { id: 'copy', label: 'Copy last response', hint: 'yank to clipboard · Ctrl+O' },
  { id: 'clear', label: 'Clear transcript', hint: 'hide the current display' },
  { id: 'cancel', label: 'Cancel turn', hint: 'abort the active round loop' },
  { id: 'quit', label: 'Quit', hint: 'return to the terminal' },
] as const;

/**
 * Shortcuts advertised on the empty launch screen. These are REAL bindings —
 * `resolveComposerShortcut` / `changeComposerInput` / `handleTuiInterrupt` back
 * every one — not a decorative menu. The Phase 0 surface tests pin each entry to
 * its resolver so the screen can never advertise a chord the composer doesn't
 * honor (honest surfaces: the launch panel must not lie about what a key does).
 *
 * `action` is the resolver verb the drift test checks; `keys`/`label` are what
 * the user reads. Kept short and launch-relevant on purpose — the full surface
 * lives in the command palette (Ctrl+K), which is itself one of these rows.
 */
export const LAUNCH_SHORTCUTS: readonly {
  label: string;
  keys: string;
  action: 'session' | 'palette' | 'help' | 'quit';
}[] = [
  { label: 'Resume session', keys: 'ctrl+r', action: 'session' },
  { label: 'Command palette', keys: 'ctrl+k', action: 'palette' },
  { label: 'Help', keys: '?', action: 'help' },
  { label: 'Quit', keys: 'ctrl+c', action: 'quit' },
];

/** Widest label + a two-space gutter + widest key, with a little headroom. The
 *  launch screen only draws the shortcut panel when the viewport clears this. */
const LAUNCH_SHORTCUT_WIDTH = 26;

const PICKER_MAX_VISIBLE = 12;

/**
 * Catch secret-setting commands before their value can become composer state.
 * The caller clears the composer and opens the password-style config field;
 * any pasted tail is deliberately discarded and must be pasted again there.
 */
export function resolveSensitiveConfigComposerTarget(
  value: string,
  currentProvider: string,
  providerIds: readonly string[] = getProviderList().map((provider) => provider.id),
): string | null {
  const match = value.match(/^\/config\s+(key|tavily)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  if (match[1]?.toLowerCase() === 'tavily') return 'tavily';
  const candidate = match[2]?.trim().split(/\s+/)[0]?.toLowerCase();
  return candidate && providerIds.includes(candidate) ? candidate : currentProvider;
}

/** Window a long option list around the cursor, keeping the selection visible. */
export function pickerWindow(
  count: number,
  cursor: number,
  max: number = PICKER_MAX_VISIBLE,
): { start: number; end: number } {
  if (count <= max) return { start: 0, end: count };
  const half = Math.floor(max / 2);
  const start = Math.max(0, Math.min(cursor - half, count - max));
  return { start, end: start + max };
}

export function formatPickerRelativeTime(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'unknown';
  const seconds = Math.floor(Math.max(0, now - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toISOString().slice(0, 10);
}

function truncatePickerText(value: string, width: number): string {
  const safe = value
    // biome-ignore lint/suspicious/noControlCharactersInRegex: session metadata is user-controlled
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip OSC hyperlinks/window titles
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: remaining terminal controls become spaces
    .replace(/[\x00-\x1f\x7f]/g, ' ');
  const flat = safe.replace(/\s+/g, ' ').trim();
  if (flat.length <= width) return flat;
  return `${flat.slice(0, Math.max(0, width - 1))}…`;
}

export function tailWindow(
  items: readonly SilveryTranscriptItem[],
  width: number,
  height: number,
): SilveryTranscriptItem[] {
  const visible: SilveryTranscriptItem[] = [];
  let rows = 0;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!item) continue;
    const itemRows =
      1 +
      Math.max(1, countVisualLines(item.text || ' ', Math.max(1, width - 2))) +
      (visible.length ? 1 : 0);
    if (rows + itemRows > height && visible.length) break;
    visible.unshift(item);
    rows += itemRows;
  }
  return visible;
}

function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout?.columns || 80, rows: stdout?.rows || 24 });
  useEffect(() => {
    if (!stdout) return;
    const update = () => setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on?.('resize', update);
    return () => {
      stdout.off?.('resize', update);
    };
  }, [stdout]);
  return size;
}

function useSharedClock(active: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((value) => value + 1), MOTION_TICKS.clockMs);
    return () => clearInterval(timer);
  }, [active]);
  return tick;
}

function useModalMotion(
  open: boolean,
  tick: number,
  targetFade: number,
  reducedMotion: boolean,
  onAnimatingChange: (animating: boolean) => void,
): { visible: boolean; interactive: boolean; fade: number; phase: ModalMotionState['phase'] } {
  const [motion, setMotion] = useState(() =>
    createModalMotionState(open, tick, targetFade, reducedMotion),
  );

  useEffect(() => {
    setMotion((current) => reduceModalMotion(current, open, tick, targetFade, reducedMotion));
  }, [open, reducedMotion, targetFade, tick]);

  const animating = motion.phase === 'entering' || motion.phase === 'exiting';
  useEffect(() => onAnimatingChange(animating), [animating, onAnimatingChange]);

  return {
    visible: reducedMotion ? open : open || motion.phase !== 'closed',
    interactive: open && motion.phase !== 'exiting',
    fade: modalFadeAmount(motion, tick, targetFade),
    phase: motion.phase,
  };
}

function DiffCard({ item }: { item: SilveryTranscriptItem }) {
  const [expanded, setExpanded] = useState(false);
  const diff = item.diff!;
  const lines = expanded ? diff.lines : diff.lines.slice(0, 8);
  return (
    <Box flexDirection="column" onClick={() => setExpanded((value) => !value)}>
      <Text bold>
        {diff.path} · +{diff.adds} -{diff.dels}
      </Text>
      {lines.map((line, index) => {
        const number = line.kind === 'del' ? line.oldLine : (line.newLine ?? line.oldLine);
        const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
        const color = diffLineColor(line.kind === 'add' || line.kind === 'del' ? line.kind : 'ctx');
        return (
          <Text key={`${number ?? 0}-${index}`} color={color} bold={line.kind === 'add'}>
            {`${String(number ?? '').padStart(4)} ${marker} ${line.text}${line.textTruncated ? '…' : ''}`}
          </Text>
        );
      })}
      {diff.lines.length > lines.length || diff.truncated ? (
        <Text color={VL_COLOR.muted}>click to {expanded ? 'collapse' : 'expand'} diff</Text>
      ) : null}
    </Box>
  );
}

function toolMarkKind(item: SilveryTranscriptItem): StreamMarkKind {
  if (item.isError) return 'tool_error';
  if (item.pending) return 'tool_pending';
  return 'tool_ok';
}

function ToolCard({ item }: { item: SilveryTranscriptItem }) {
  const [expanded, setExpanded] = useState(false);
  const glyphs = useMemo(() => resolveGlyphs(detectUnicode()), []);
  const mark = streamMark(toolMarkKind(item), glyphs);
  // Semantic compact title ("Read README.md" / "Ran a command") from the shared
  // vocabulary, using the runtime `target` when present. The raw tool name is
  // the fallback for anything the vocabulary doesn't cover.
  const title = formatToolTitle(item.toolName ?? item.text, item.target);
  // File mutations carry both the cross-surface `diff-preview` card and the
  // CLI-native line-numbered EditDiff. Prefer the richer local renderer while
  // still keeping the declared card on the event for other consumers.
  const formatted =
    item.card?.type === 'diff-preview' && item.diff
      ? null
      : item.card
        ? formatToolCard(item.card)
        : null;
  // A card that reduces to nothing — no title, no rows, no body — is the absence
  // of a card, so drop the element entirely rather than rely on an empty <Box>
  // happening to be zero-height. A clean silent command (`formatCommandCard`
  // returns exactly this shape) then renders as its header row alone.
  const card =
    formatted && (formatted.title || formatted.rows.length || formatted.bodyLines?.length)
      ? formatted
      : null;
  const cardBodyLines = card?.bodyLines ?? [];
  const visibleCardBodyLines = expanded ? cardBodyLines : cardBodyLines.slice(0, 8);
  // A declared card / diff is already the structured representation, even when
  // its formatter intentionally reduces it to no visible card (a clean silent
  // command). Only an unstructured raw preview folds to its first line by
  // default, expanding on click. `…` marks a row that has more behind it.
  const previewOnly = !item.card && !item.diff && Boolean(item.resultPreview);
  const previewLines = item.resultPreview ? item.resultPreview.split('\n') : [];
  const previewHasMore = previewOnly && previewLines.length > 1;
  return (
    <Box flexDirection="column" onClick={() => setExpanded((value) => !value)}>
      <Text bold={mark.bold} color={mark.color}>
        {mark.glyph} {title}
        {typeof item.durationMs === 'number' ? ` · ${item.durationMs}ms` : ''}
        {previewHasMore && !expanded ? ' …' : ''}
      </Text>
      {card ? (
        <Box flexDirection="column">
          {/* `formatCommandCard` sets `title: ''` (the header row already names
              the command). Silvery collapses an empty <Text> to zero height, so
              this guard is for intent, not to suppress a visible blank line —
              the card's content shouldn't depend on that collapse behavior. */}
          {card.title ? (
            <Text color={card.known ? VL_COLOR.primary : VL_COLOR.muted}>{card.title}</Text>
          ) : null}
          {card.rows.map((row, index) => (
            <Text key={`${row.label}-${index}`} color={VL_COLOR.muted}>
              {row.label}: {row.value}
            </Text>
          ))}
          {visibleCardBodyLines.map((line, index) => (
            <Text
              key={`${line.tone}-${index}`}
              color={
                line.tone === 'add'
                  ? diffLineColor('add')
                  : line.tone === 'delete'
                    ? diffLineColor('del')
                    : VL_COLOR.muted
              }
              bold={line.tone === 'add'}
            >
              {line.text}
            </Text>
          ))}
          {cardBodyLines.length > visibleCardBodyLines.length ? (
            <Text color={VL_COLOR.muted}>click to expand details</Text>
          ) : null}
        </Box>
      ) : null}
      {item.diff ? <DiffCard item={item} /> : null}
      {previewOnly ? (
        <Text color={VL_COLOR.muted}>{expanded ? item.resultPreview : previewLines[0]}</Text>
      ) : null}
    </Box>
  );
}

function ToolGroup({ group }: { group: SilveryTranscriptToolGroup }) {
  const [expanded, setExpanded] = useState(false);
  const glyphs = useMemo(() => resolveGlyphs(detectUnicode()), []);
  const mark = streamMark('tool_ok', glyphs);
  return (
    <Box flexDirection="column">
      <Box onClick={() => setExpanded((value) => !value)}>
        <Text bold={mark.bold} color={mark.color}>
          {mark.glyph} {group.summary}
          {expanded ? '' : ' …'}
        </Text>
      </Box>
      {expanded ? (
        <Box flexDirection="column" paddingLeft={2}>
          {group.items.map((item) => (
            <ToolCard key={item.id} item={item} />
          ))}
          <Text color={VL_COLOR.muted}>click summary to collapse group</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function messageMarkKind(item: SilveryTranscriptItem): StreamMarkKind {
  if (item.isError) return 'error';
  if (item.role === 'user') return 'user';
  if (item.role === 'reviewer') return 'reviewer';
  if (item.role === 'auditor') return 'auditor';
  if (item.role === 'status') return 'status';
  if (item.role === 'coder' || item.role === 'explorer') {
    // Activity from delegated phases still rides the dot spine, not a color.
    return item.pending || item.live ? 'tool_pending' : 'tool_ok';
  }
  return 'assistant';
}

function Message({ item, tinted = false }: { item: SilveryTranscriptItem; tinted?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const glyphs = useMemo(() => resolveGlyphs(detectUnicode()), []);
  if (item.kind === 'tool') return <ToolCard item={item} />;
  const label = getTranscriptRoleLabel(item.role);
  // The lead agent (hexagon) and the human (❯) are self-evident from their
  // glyph alone — drop the generic "Assistant"/"You" text. Named voices
  // (Reviewer/Auditor, delegated phases, status) keep their label.
  const showLabel = item.role !== 'user' && item.role !== 'assistant';
  const mark = streamMark(messageMarkKind(item), glyphs);
  const bodyColor = item.isError
    ? VL_COLOR.fault
    : item.role === 'status' || item.kind === 'tool_prose'
      ? VL_COLOR.muted
      : undefined;
  const bodyText = item.kind === 'review' && !expanded ? item.text.split('\n')[0] : item.text;
  const timestamp = formatTurnTimestamp(item.timestampMs);
  // Markdown is for machine-generated prose only. User turns stay literal —
  // a pasted `**bold**` or emoji must echo back faithfully, not get restyled or
  // stripped. Fault (law 3) and status bodies also stay plain so the fault color
  // never mixes with accent link/code spans.
  const renderMarkdown = !item.isError && item.role !== 'status' && item.role !== 'user';
  return (
    <Box
      flexDirection="column"
      width="100%"
      paddingX={1}
      backgroundColor={tinted ? '$bg-surface-subtle' : undefined}
      onClick={item.kind === 'review' ? () => setExpanded((value) => !value) : undefined}
    >
      <Box width="100%">
        <Text bold={mark.bold} color={mark.color}>
          {mark.glyph}
          {showLabel ? ` ${label}` : ''}
          {item.live ? ' · live' : ''}
        </Text>
        {timestamp ? (
          <>
            <Box flexGrow={1} />
            <Text color={VL_COLOR.muted}>{timestamp}</Text>
          </>
        ) : null}
      </Box>
      {renderMarkdown ? (
        <MarkdownBody text={bodyText} base={bodyColor} />
      ) : (
        <Text color={bodyColor}>{bodyText}</Text>
      )}
      {item.kind === 'review' ? (
        <Text color={VL_COLOR.muted}>click to {expanded ? 'collapse' : 'expand'} review</Text>
      ) : null}
    </Box>
  );
}

function InteractionModal({
  interaction,
  controller,
  width,
  fade,
  active,
}: {
  interaction: NonNullable<SilverySnapshot['interaction']>;
  controller: SilveryController;
  width: number;
  fade: number;
  active: boolean;
}) {
  const [answer, setAnswer] = useState('');
  const glyphs = useMemo(() => resolveGlyphs(detectUnicode()), []);
  const respond = useCallback(
    (value: boolean | string) => controller.respondToInteraction(interaction.id, value),
    [controller, interaction.id],
  );
  useInput(
    (input, key) => {
      if (key.escape) respond(interaction.kind === 'approval' ? false : '');
      else if (interaction.kind === 'approval' && !key.ctrl && !key.meta) {
        if (input.toLowerCase() === 'y') respond(true);
        if (input.toLowerCase() === 'n') respond(false);
      }
    },
    { isActive: active },
  );
  const modalWidth = Math.max(40, Math.min(68, width - 4));
  return (
    <Box position="absolute" marginLeft={2} marginTop={1} width={modalWidth}>
      <ModalDialog
        title={`${glyphs.hexActive} ${interaction.title}`}
        width={modalWidth}
        footer={
          interaction.kind === 'approval' ? footerKeybinds('approval') : footerKeybinds('question')
        }
        fade={fade}
      >
        <Box flexDirection="column" gap={1}>
          <Text>{interaction.detail}</Text>
          {interaction.kind === 'approval' ? (
            <Box gap={2}>
              <Box onClick={active ? () => respond(true) : undefined}>
                <Text bold color={VL_COLOR.accent}>
                  [ Approve ]
                </Text>
              </Box>
              <Box onClick={active ? () => respond(false) : undefined}>
                <Text bold color={VL_COLOR.fault}>
                  [ Deny ]
                </Text>
              </Box>
            </Box>
          ) : (
            <TextArea
              value={answer}
              onChange={setAnswer}
              onSubmit={(value) => respond(value)}
              submitKey="enter"
              minRows={1}
              maxRows={4}
              placeholder="type your answer…"
              isActive={active}
            />
          )}
        </Box>
      </ModalDialog>
    </Box>
  );
}

/**
 * One raster row of the launch mark, painted as a single `<Text>` with nested
 * per-column color spans. It stays ONE measured node on purpose: the surface
 * block-centers the mark with `alignItems="center"`, which centers each line by
 * its own width — splitting the row into per-cell flex items would let
 * shrink-to-fit eat the trailing spaces and shear the hexagon (the same trap
 * `StatusVerb` documents). Nested spans keep the width fixed at the raster width.
 */
function BrandMarkLine({ line, colors }: { line: string; colors: readonly string[] }) {
  const cells = [...line];
  return (
    <Text>
      {cells.map((ch, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-width raster — the column IS the identity
        <Text key={index} color={colors[index]}>
          {ch}
        </Text>
      ))}
    </Text>
  );
}

/**
 * The empty-transcript launch screen: the slow-shimmering Push mark over a panel
 * of real shortcuts. Degrades by viewport — mark + shortcuts when both fit, mark
 * alone when the shortcut panel doesn't, and nothing at all when even the mark is
 * too tall/narrow. The panel is additionally gated on composer ownership: a
 * shortcut hidden by a draft, modal, or running turn cannot promise an
 * unavailable action. `animate` drives the shimmer: the surface sets it only
 * while the launch screen is genuinely foreground and not reduced-motion, so the
 * mark is the idle state's single live animation (law 8) and rests at the flat
 * muted trough otherwise (law 10) — including behind a modal or above a draft.
 */
export function LaunchScreen({
  width,
  height,
  showShortcuts,
  tick,
  animate,
}: {
  width: number;
  height: number;
  showShortcuts: boolean;
  tick: number;
  animate: boolean;
}) {
  const art = pushBrandArt(detectUnicode());
  const fitsLogo = height >= art.length && width >= PUSH_BRAND_ART_COLS;
  const fitsShortcuts =
    showShortcuts &&
    fitsLogo &&
    width >= LAUNCH_SHORTCUT_WIDTH &&
    height >= art.length + 1 + LAUNCH_SHORTCUTS.length;
  const panelWidth = Math.min(LAUNCH_SHORTCUT_WIDTH, Math.max(0, width - 2));
  return (
    <Box
      width={width}
      height={height}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
    >
      {fitsLogo
        ? art.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed raster, row order is stable identity
            <BrandMarkLine
              key={index}
              line={line}
              colors={brandShimmerColors(line, tick, !animate)}
            />
          ))
        : null}
      {fitsShortcuts ? (
        <Box marginTop={1} flexDirection="column" width={panelWidth}>
          {LAUNCH_SHORTCUTS.map((shortcut) => (
            <Box key={shortcut.label} width={panelWidth}>
              <Text color={VL_COLOR.primary} bold>
                {shortcut.label}
              </Text>
              <Box flexGrow={1} />
              <Text color={VL_COLOR.muted}>{shortcut.keys}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function Transcript({
  snapshot,
  width,
  height,
  active,
  showLaunchShortcuts,
  tick,
  shimmerActive,
}: {
  snapshot: SilverySnapshot;
  width: number;
  height: number;
  active: boolean;
  showLaunchShortcuts: boolean;
  tick: number;
  shimmerActive: boolean;
}) {
  // follow="end" measures the visible window and pins the streaming tail there.
  // Three props shipped in P1 broke that pinning — together they were the "message
  // jumps to the top and disappears on activity" bug. Do NOT re-add any of them:
  //
  //  - custom `estimateHeight` (returned ~2 rows for a 1-row tool card) AND the
  //    `cache` config: either one inflates the phantom scroll extent so follow="end"
  //    scrolls PAST the real content — only the last row survives, pinned to the TOP
  //    of a blank viewport. `virtualization="measured"` itself is FINE and stays: it
  //    measures the VISIBLE window (so the tail is exact and long transcripts don't
  //    render every row); silvery's default off-screen estimate is accurate enough.
  //  - `overflowIndicator`: reserved the bottom viewport row for its "▼N" hint,
  //    which follow="end" did not subtract, so the newest row sat one line BELOW
  //    the fold. `scrollbarVisibility="always"` already signals off-screen content.
  //
  // (`tailReserveRows`/`maintainVisibleContentPosition` were tried and cleared — not
  // the cause.) `tailWindow` stays exported as the measured fallback, pinned by the
  // Phase 1 test; the render test's `real row 13/14/15` window guards this config.
  const shown = useMemo(() => groupSilveryTranscriptRows(snapshot.rows), [snapshot.rows]);
  if (shown.length === 0) {
    return (
      <LaunchScreen
        width={width}
        height={height}
        showShortcuts={showLaunchShortcuts}
        tick={tick}
        animate={shimmerActive}
      />
    );
  }
  return (
    <ListView
      items={shown}
      height={height}
      width={width}
      gap={1}
      nav
      active={active}
      follow="end"
      virtualization="measured"
      scrollbarVisibility="always"
      getKey={(item) => item.id}
      renderItem={(item) =>
        item.kind === 'tool_group' ? (
          <ToolGroup group={item} />
        ) : (
          <Message item={item} tinted={item.kind === 'message' && item.role === 'user'} />
        )
      }
    />
  );
}

function Palette({
  onClose,
  onRun,
  width,
  fade,
  active,
}: {
  onClose: () => void;
  onRun: (id: (typeof COMMANDS)[number]['id']) => void;
  width: number;
  fade: number;
  active: boolean;
}) {
  const [selected, setSelected] = useState(0);
  useInput(
    (input, key) => {
      const action = getListNavigationAction(
        {
          ch: input,
          name: key.escape
            ? 'escape'
            : key.upArrow
              ? 'up'
              : key.downArrow
                ? 'down'
                : key.return
                  ? 'return'
                  : input,
          ctrl: key.ctrl,
          meta: key.meta,
        },
        { allowNumbers: false, allowVim: true },
      );
      if (action?.type === 'cancel') onClose();
      else if (action?.type === 'move')
        setSelected((value) => (value + action.delta + COMMANDS.length) % COMMANDS.length);
      else if (action?.type === 'confirm') onRun(COMMANDS[selected]!.id);
    },
    { isActive: active },
  );
  const modalWidth = Math.max(36, Math.min(58, width - 4));
  return (
    <Box position="absolute" marginLeft={2} marginTop={1} width={modalWidth}>
      <ModalDialog
        title="Command Palette"
        width={modalWidth}
        footer={footerKeybinds('palette')}
        onClose={onClose}
        fade={fade}
      >
        <Box flexDirection="column">
          {COMMANDS.map((command, index) => (
            <Box key={command.id} onClick={active ? () => onRun(command.id) : undefined}>
              <Text
                color={index === selected ? VL_COLOR.accent : undefined}
                bold={index === selected}
              >
                {`${index === selected ? '❯ ' : '  '}${command.label.padEnd(20)}${command.hint}`}
              </Text>
            </Box>
          ))}
        </Box>
      </ModalDialog>
    </Box>
  );
}

function SessionPreviewPane({
  picker,
  option,
  width,
}: {
  picker: NonNullable<SilverySnapshot['picker']>;
  option: NonNullable<SilverySnapshot['picker']>['options'][number] | undefined;
  width: number;
}) {
  const session = option?.session;
  const preview = option && picker.preview?.optionId === option.id ? picker.preview : null;
  const contentWidth = Math.max(12, width - 4);
  return (
    <Box
      width={width}
      minHeight={12}
      flexDirection="column"
      borderStyle="single"
      borderColor={VL_COLOR.muted}
      paddingX={1}
    >
      <Text bold>Preview</Text>
      {!option ? (
        <Text color={VL_COLOR.muted}>
          {picker.loading ? 'Loading sessions…' : 'Select a session to preview'}
        </Text>
      ) : !preview || preview.loading ? (
        <Text color={VL_COLOR.muted}>Loading preview…</Text>
      ) : preview.error ? (
        <Text color={VL_COLOR.fault}>{preview.error}</Text>
      ) : preview.messages.length === 0 ? (
        <Text color={VL_COLOR.muted}>No messages in session</Text>
      ) : (
        preview.messages.slice(-4).map((message, index) => (
          <Text key={`${message.role}-${index}`}>
            <Text color={message.role === 'user' ? VL_COLOR.accent : VL_COLOR.primary} bold>
              {message.role === 'user' ? 'You: ' : 'AI:  '}
            </Text>
            <Text color={VL_COLOR.muted}>
              {truncatePickerText(message.content, Math.max(8, contentWidth - 5))}
            </Text>
          </Text>
        ))
      )}
      {session ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={VL_COLOR.muted}>Session</Text>
          <Text>{`ID: ${truncatePickerText(session.sessionId, contentWidth)}`}</Text>
          {session.sessionName ? (
            <Text>{`Name: ${truncatePickerText(session.sessionName, contentWidth)}`}</Text>
          ) : null}
          <Text>{`Path: ${truncatePickerText(session.cwd || '.', contentWidth)}`}</Text>
          <Text>{`Model: ${truncatePickerText(`${session.provider}/${session.model}`, contentWidth)}`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function PickerModal({
  picker,
  controller,
  width,
  fade,
  active,
}: {
  picker: NonNullable<SilverySnapshot['picker']>;
  controller: SilveryController;
  width: number;
  fade: number;
  active: boolean;
}) {
  const count = picker.options.length;
  const [selected, setSelected] = useState(picker.initialIndex);
  // The option set can shrink between renders (rare, but keep the cursor valid).
  const cursor = Math.min(Math.max(0, selected), Math.max(0, count - 1));
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  useInput(
    (input, key) => {
      if (picker.kind === 'session' && !key.ctrl && !key.meta && input.toLowerCase() === 'a') {
        controller.toggleSessionPickerScope();
        return;
      }
      const action = getListNavigationAction(
        {
          ch: input,
          name: key.escape
            ? 'escape'
            : key.upArrow
              ? 'up'
              : key.downArrow
                ? 'down'
                : key.return
                  ? 'return'
                  : input,
          ctrl: key.ctrl,
          meta: key.meta,
        },
        { allowNumbers: false, allowVim: true },
      );
      if (action?.type === 'cancel') controller.closePicker();
      else if (action?.type === 'move' && count > 0) {
        const next = (Math.min(cursorRef.current, count - 1) + action.delta + count) % count;
        cursorRef.current = next;
        setSelected(next);
        if (picker.kind === 'session') {
          const option = picker.options[next];
          if (option) controller.previewPickerOption(option.id);
        }
      } else if (action?.type === 'confirm') {
        const option = picker.options[cursor];
        if (option) controller.selectPickerOption(option.id);
      }
    },
    { isActive: active },
  );
  const isSessionPicker = picker.kind === 'session';
  const modalWidth = Math.max(40, Math.min(isSessionPicker ? 112 : 64, width - 4));
  const labelWidth = Math.max(
    ...picker.options.map((option) => option.label.length),
    picker.kind === 'model' ? 12 : 8,
  );
  const { start, end } = pickerWindow(count, cursor, isSessionPicker ? 7 : PICKER_MAX_VISIBLE);
  const visible = picker.options.slice(start, end);
  const selectedOption = picker.options[cursor];
  const sessionSideBySide = isSessionPicker && modalWidth >= 62;
  const sessionListWidth = sessionSideBySide
    ? Math.max(28, Math.floor((modalWidth - 5) * 0.5))
    : modalWidth - 4;
  const sessionPreviewWidth = sessionSideBySide
    ? Math.max(26, modalWidth - sessionListWidth - 5)
    : modalWidth - 4;
  const scopeLabel =
    picker.scope === 'workspace'
      ? `this workspace${picker.scopedOutCount ? ` · ${picker.scopedOutCount} elsewhere` : ''}`
      : 'all workspaces';
  const optionsView = (
    <Box flexDirection="column" width={isSessionPicker ? sessionListWidth : undefined}>
      {isSessionPicker ? <Text color={VL_COLOR.muted}>{scopeLabel}</Text> : null}
      {picker.loading ? <Text color={VL_COLOR.muted}>Loading sessions…</Text> : null}
      {picker.error ? <Text color={VL_COLOR.fault}>{picker.error}</Text> : null}
      {!picker.loading && !picker.error && count === 0 ? (
        <Text color={VL_COLOR.muted}>No saved sessions</Text>
      ) : null}
      {start > 0 ? <Text color={VL_COLOR.muted}>{`  ↑ ${start} more`}</Text> : null}
      {visible.map((option, index) => {
        const optionIndex = start + index;
        const isCursor = optionIndex === cursor;
        const badge = option.current ? ' ·current' : '';
        const color = option.disabled ? VL_COLOR.muted : isCursor ? VL_COLOR.accent : undefined;
        if (isSessionPicker && option.session) {
          const rowWidth = Math.max(12, sessionListWidth - 3);
          return (
            <Box
              key={option.id}
              flexDirection="column"
              onClick={active ? () => controller.selectPickerOption(option.id) : undefined}
            >
              <Text color={color} bold={isCursor && !option.disabled}>
                {`${isCursor ? '❯ ' : '  '}${truncatePickerText(option.label, rowWidth - badge.length)}${badge}`}
              </Text>
              <Text color={VL_COLOR.muted}>
                {`    ${truncatePickerText(
                  `${option.hint ?? ''} · ${formatPickerRelativeTime(option.session.updatedAt)}`,
                  Math.max(8, rowWidth - 2),
                )}`}
              </Text>
            </Box>
          );
        }
        const label = option.label.padEnd(labelWidth);
        const hint = option.hint ? `  ${option.hint}` : '';
        return (
          <Box
            key={option.id}
            onClick={active ? () => controller.selectPickerOption(option.id) : undefined}
          >
            <Text color={color} bold={isCursor && !option.disabled}>
              {`${isCursor ? '❯ ' : '  '}${label}${badge}${hint}`}
            </Text>
          </Box>
        );
      })}
      {end < count ? <Text color={VL_COLOR.muted}>{`  ↓ ${count - end} more`}</Text> : null}
    </Box>
  );
  return (
    <Box position="absolute" marginLeft={2} marginTop={1} width={modalWidth}>
      <ModalDialog
        title={picker.title}
        width={modalWidth}
        footer={
          isSessionPicker ? '↑↓ move · ↵ resume · a scope · esc close' : footerKeybinds('picker')
        }
        onClose={() => controller.closePicker()}
        fade={fade}
      >
        {isSessionPicker ? (
          <Box flexDirection={sessionSideBySide ? 'row' : 'column'} gap={1}>
            {optionsView}
            <SessionPreviewPane
              picker={picker}
              option={selectedOption}
              width={sessionPreviewWidth}
            />
          </Box>
        ) : (
          optionsView
        )}
      </ModalDialog>
    </Box>
  );
}

function ConfigEditorModal({
  editor,
  controller,
  width,
  fade,
  active,
}: {
  editor: NonNullable<SilverySnapshot['configEditor']>;
  controller: SilveryController;
  width: number;
  fade: number;
  active: boolean;
}) {
  const count = editor.items.length;
  const [selected, setSelected] = useState(editor.initialIndex);
  const [editTarget, setEditTarget] = useState<string | null>(editor.initialEditTarget ?? null);
  const [choiceTarget, setChoiceTarget] = useState<string | null>(null);
  const [choiceSelected, setChoiceSelected] = useState(0);
  const [secret, setSecret] = useState('');
  const cursor = Math.min(Math.max(0, selected), Math.max(0, count - 1));
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const selectedItem = editor.items[cursor];
  const editItem = editTarget
    ? (editor.items.find((item) => item.id === editTarget) ?? selectedItem)
    : undefined;
  const choiceItem = choiceTarget
    ? editor.items.find((item) => item.id === choiceTarget)
    : undefined;
  const choiceOptions = choiceItem?.options ?? [];
  const choiceCursor = Math.min(Math.max(0, choiceSelected), Math.max(0, choiceOptions.length - 1));
  const choiceCursorRef = useRef(choiceCursor);
  choiceCursorRef.current = choiceCursor;
  const openItem = useCallback((target: string) => {
    setSecret('');
    setEditTarget(target);
  }, []);
  const openChoice = useCallback((item: (typeof editor.items)[number]) => {
    const currentIndex = item.options?.findIndex((option) => option.value === item.value) ?? -1;
    setChoiceSelected(Math.max(0, currentIndex));
    setChoiceTarget(item.id);
  }, []);
  const cancelEdit = useCallback(() => {
    setSecret('');
    setEditTarget(null);
  }, []);
  const cancelChoice = useCallback(() => setChoiceTarget(null), []);
  const activateItem = useCallback(
    (item: (typeof editor.items)[number]) => {
      if (item.kind === 'secret') openItem(item.id);
      else if (item.kind === 'select') openChoice(item);
      else {
        const next =
          item.id === 'daemon'
            ? item.value === 'auto'
              ? 'off'
              : 'auto'
            : item.value === 'on'
              ? 'off'
              : 'on';
        void controller.saveConfigPreference(item.id, next);
      }
    },
    [controller, openChoice, openItem],
  );

  useInput(
    (input, key) => {
      const action = getListNavigationAction(
        {
          ch: input,
          name: key.escape
            ? 'escape'
            : key.upArrow
              ? 'up'
              : key.downArrow
                ? 'down'
                : key.return
                  ? 'return'
                  : input,
          ctrl: key.ctrl,
          meta: key.meta,
        },
        { allowNumbers: false, allowVim: true },
      );
      if (action?.type === 'cancel') controller.closeConfigEditor();
      else if (action?.type === 'move' && count > 0) {
        const next = (Math.min(cursorRef.current, count - 1) + action.delta + count) % count;
        cursorRef.current = next;
        setSelected(next);
      } else if (action?.type === 'confirm') {
        const item = editor.items[cursorRef.current];
        if (item) activateItem(item);
      }
    },
    { isActive: active && editTarget === null && choiceTarget === null && !editor.saving },
  );
  useInput(
    (_input, key) => {
      if (key.escape && !editor.saving) cancelEdit();
    },
    {
      isActive: active && editTarget !== null,
      onPaste: (text) => {
        if (!editor.saving) setSecret(text.trim());
      },
    },
  );
  useInput(
    (input, key) => {
      const action = getListNavigationAction(
        {
          ch: input,
          name: key.escape
            ? 'escape'
            : key.upArrow
              ? 'up'
              : key.downArrow
                ? 'down'
                : key.return
                  ? 'return'
                  : input,
          ctrl: key.ctrl,
          meta: key.meta,
        },
        { allowNumbers: false, allowVim: true },
      );
      if (action?.type === 'cancel') cancelChoice();
      else if (action?.type === 'move' && choiceOptions.length > 0) {
        const next =
          (choiceCursorRef.current + action.delta + choiceOptions.length) % choiceOptions.length;
        choiceCursorRef.current = next;
        setChoiceSelected(next);
      } else if (action?.type === 'confirm' && choiceItem) {
        const option = choiceOptions[choiceCursorRef.current];
        if (option) {
          void controller
            .saveConfigPreference(choiceItem.id, option.value)
            .then((saved) => saved && cancelChoice());
        }
      }
    },
    { isActive: active && choiceTarget !== null && !editor.saving },
  );

  const modalWidth = Math.max(42, Math.min(72, width - 4));
  const { start, end } = pickerWindow(count, cursor, 11);
  const visible = editor.items.slice(start, end);
  const submitSecret = useCallback(
    async (value: string) => {
      if (!editTarget || editor.saving) return;
      if (await controller.saveConfigSecret(editTarget, value)) cancelEdit();
    },
    [cancelEdit, controller, editTarget, editor.saving],
  );

  return (
    <Box position="absolute" marginLeft={2} marginTop={1} width={modalWidth}>
      <ModalDialog
        title={editItem ? `API key · ${editItem.label}` : choiceItem ? choiceItem.label : 'Config'}
        width={modalWidth}
        footer={
          editItem
            ? 'paste key · ↵ save · esc cancel'
            : choiceItem
              ? '↑↓ select · ↵ save · esc cancel'
              : '↑↓ move · ↵ edit/toggle · esc close'
        }
        onClose={
          editItem ? cancelEdit : choiceItem ? cancelChoice : () => controller.closeConfigEditor()
        }
        fade={fade}
      >
        {editItem ? (
          <Box flexDirection="column" gap={1}>
            <Text color={VL_COLOR.muted}>
              Current: <Text color={VL_COLOR.primary}>{editItem.value}</Text>
            </Text>
            <TextInput
              value={secret}
              onChange={setSecret}
              onSubmit={(value) => void submitSecret(value)}
              placeholder="paste API key"
              prompt="❯ "
              promptColor={VL_COLOR.accent}
              mask="•"
              showUnderline
              underlineWidth={Math.max(24, modalWidth - 12)}
              isActive={active && !editor.saving}
              readOnly={editor.saving}
            />
            <Text color={VL_COLOR.muted}>
              {editor.saving ? 'Saving…' : 'The key is masked and never enters the composer.'}
            </Text>
            {editor.error ? <Text color={VL_COLOR.fault}>{editor.error}</Text> : null}
          </Box>
        ) : choiceItem ? (
          <Box flexDirection="column">
            {choiceOptions.map((option, index) => {
              const isCursor = index === choiceCursor;
              const current = option.value === choiceItem.value ? ' ·current' : '';
              return (
                <Box key={option.value}>
                  <Text color={isCursor ? VL_COLOR.accent : undefined} bold={isCursor}>
                    {`${isCursor ? '❯ ' : '  '}${option.label}${current}`}
                  </Text>
                  <Text color={VL_COLOR.muted}>{` · ${option.detail}`}</Text>
                </Box>
              );
            })}
            {editor.saving ? <Text color={VL_COLOR.muted}>Saving…</Text> : null}
            {editor.error ? <Text color={VL_COLOR.fault}>{editor.error}</Text> : null}
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text color={VL_COLOR.muted}>Provider keys</Text>
            {start > 0 ? <Text color={VL_COLOR.muted}>{`  ↑ ${start} more`}</Text> : null}
            {visible.map((item, index) => {
              const itemIndex = start + index;
              const isCursor = itemIndex === cursor;
              const badge = item.current ? ' ·current' : '';
              const rowWidth = Math.max(18, modalWidth - 6);
              const label = truncatePickerText(`${item.label}${badge}`, Math.floor(rowWidth * 0.4));
              const detail = item.detail ? ` · ${item.detail}` : '';
              return (
                <Box
                  key={item.id}
                  onClick={active && !editor.saving ? () => activateItem(item) : undefined}
                >
                  <Text color={isCursor ? VL_COLOR.accent : undefined} bold={isCursor}>
                    {`${isCursor ? '❯ ' : '  '}${label.padEnd(Math.floor(rowWidth * 0.4))}`}
                  </Text>
                  <Text color={VL_COLOR.muted}>
                    {truncatePickerText(`${item.value}${detail}`, Math.ceil(rowWidth * 0.6))}
                  </Text>
                </Box>
              );
            })}
            {end < count ? <Text color={VL_COLOR.muted}>{`  ↓ ${count - end} more`}</Text> : null}
            {editor.saving ? <Text color={VL_COLOR.muted}>Saving…</Text> : null}
            {editor.error ? <Text color={VL_COLOR.fault}>{editor.error}</Text> : null}
          </Box>
        )}
      </ModalDialog>
    </Box>
  );
}

function HeaderBar({
  snapshot,
  tick,
  columns,
  attention,
  freezeMotion,
}: {
  snapshot: SilverySnapshot;
  tick: number;
  columns: number;
  attention: boolean;
  freezeMotion: boolean;
}) {
  const glyphs = useMemo(() => resolveGlyphs(detectUnicode()), []);
  const phase = attention ? 'attention' : snapshot.running ? 'working' : 'idle';
  const live = livenessHex(phase, glyphs);
  const branch = snapshot.gitStatus?.branch || '—';
  const dirty =
    snapshot.gitStatus?.dirty && snapshot.gitStatus.dirty > 0
      ? ` +${snapshot.gitStatus.dirty}`
      : '';
  const tokens = useMemo(
    () => estimateTokens(snapshot.rows.map((row) => ({ content: row.text }))),
    [snapshot.rows],
  );
  const contextWindow = resolveContextWindow(snapshot.provider, snapshot.model);
  const meter = densityMeter(contextWindow ? tokens / contextWindow : 0, 8, glyphs);
  const contextLabel = contextWindow
    ? `${formatTokenCount(tokens)} / ${formatTokenCount(contextWindow)}`
    : `${formatTokenCount(tokens)} / ?`;
  const path = shortenPath(snapshot.cwd, Math.max(12, Math.min(28, Math.floor(columns / 4))));
  const turns = countUserTurns(snapshot.rows);
  const facts = headerSegments({
    branch: `${branch}${dirty}`,
    path,
    context: `${meter} ${contextLabel}`,
    turn: turns > 0 ? `turn ${turns}` : '',
  });

  // ONE row, always (law 1: the header is a fact strip, not a paragraph). The
  // facts truncate; the mark and the verb never shrink.
  //
  // Silvery's default `wrap` is word-wrap, so before this the header silently
  // became two rows on a narrow terminal — the fact strip spilling into the
  // space `transcriptHeight` (rows - 6) had already promised the transcript.
  // It went unnoticed because the wrap point sat below the usual width; the
  // verb moved it ~10 columns wider and made it easy to hit. Facts are ordered
  // most- to least-durable (branch, path, context, turn), so an `end` truncation
  // drops the least useful first.
  return (
    <Box width={columns} flexWrap="nowrap">
      <Text bold flexShrink={0} color={live.bright ? VL_COLOR.accent : VL_COLOR.muted}>
        {live.glyph}
      </Text>
      <StatusVerb
        activity={snapshot.activity}
        sessionId={snapshot.sessionId}
        tick={tick}
        freezeMotion={freezeMotion}
      />
      <Text color={VL_COLOR.muted} wrap="truncate-end">
        {` · ${facts.join(' · ')}`}
      </Text>
    </Box>
  );
}

/**
 * The live status verb — what Push is doing, and the frame's one animation.
 *
 * Renders nothing at all when idle (including no leading space), so an idle
 * header is byte-identical to what it was before the verb existed.
 *
 * One `<Text>` per character is the cost of a per-character gradient in a
 * retained tree; the verbs are ≤10 chars by construction (`MOOD_VERBS` and
 * `VERB_BY_TOOL` both cap themselves for exactly this row), so the fan-out is
 * bounded at ~10 nodes and only exists while a turn runs.
 */
function StatusVerb({
  activity,
  sessionId,
  tick,
  freezeMotion,
}: {
  activity: StatusActivity;
  sessionId: string;
  tick: number;
  freezeMotion: boolean;
}) {
  const verb = verbForActivity(activity, sessionId);
  if (!verb) return null;
  // A modal is up: the verb still says what it says, it just stops moving.
  // Same contract as reduced motion, which `verbShimmerColors` handles.
  const colors = verbShimmerColors(verb, tick, freezeMotion || isReducedMotion());
  const chars = [...verb];
  // The separating space rides the FIRST character's node rather than a node of
  // its own. A lone `<Text> </Text>` is a flex item one cell wide and the first
  // thing shrink-to-fit eats, so on a tight row the header painted `⬢testing…`
  // with the mark jammed against the verb. A space carried inside a sibling
  // that must exist anyway cannot be dropped on its own. (Coloring it is free —
  // a space has no foreground.)
  //
  // `flexShrink={0}` throughout: the verb is the row's most perishable content
  // and the least willing to lose a character. Facts truncate instead.
  return (
    <>
      {chars.map((ch, i) => (
        // Index as key: a fixed-length gradient over a stable string, where the
        // position IS the identity — and the character is not unique ('editing'
        // has two 'i's), so the char would be the wrong key.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <Text key={i} flexShrink={0} color={colors[i]}>
          {i === 0 ? ` ${ch}` : ch}
        </Text>
      ))}
      <Text flexShrink={0} color={VL_COLOR.muted}>
        …
      </Text>
    </>
  );
}

function FooterBar({
  snapshot,
  scope,
  columns,
  elapsed,
}: {
  snapshot: SilverySnapshot;
  scope: FooterScope;
  columns: number;
  elapsed: string;
}) {
  const keys = footerKeybinds(scope);
  const mode = modeLabel(snapshot.execMode);
  const right = `${mode} · ${snapshot.provider} · ${snapshot.model}${elapsed}`;
  // Prefer keys on the left; trim the right if the row is tight.
  const maxRight = Math.max(12, columns - keys.length - 3);
  const rightShown =
    right.length > maxRight ? `${right.slice(0, Math.max(0, maxRight - 1))}…` : right;
  return (
    <Box width={columns}>
      <Text color={VL_COLOR.muted}>{keys}</Text>
      <Box flexGrow={1} />
      <Text color={VL_COLOR.muted}>{rightShown}</Text>
    </Box>
  );
}

function truncateCompletionLabel(label: string, max: number): string {
  if (label.length <= max) return label;
  return `${label.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Old-TUI completion behavior, translated into the v2 one-accent language:
 * preview candidates stay muted; Tab's active candidate gets both the human
 * caret and the accent so selection never depends on color alone.
 */
function CompletionRail({ state, columns }: { state: CompletionState; columns: number }) {
  const maxVisible = Math.max(1, Math.floor((columns - 15) / 16));
  const cursor = state.index >= 0 ? state.index : 0;
  const { start, end } = pickerWindow(state.items.length, cursor, maxVisible);
  const visible = state.items.slice(start, end);
  const prefix = state.index >= 0 ? `tab ${state.index + 1}/${state.items.length}` : 'tab complete';
  const glyphs = resolveGlyphs(detectUnicode());

  return (
    <Box width={columns}>
      <Text color={VL_COLOR.muted}>{prefix} · </Text>
      {visible.map((item, offset) => {
        const index = start + offset;
        const selected = index === state.index;
        return (
          <React.Fragment key={`${index}-${item}`}>
            {offset > 0 ? <Text color={VL_COLOR.muted}> </Text> : null}
            <Text color={selected ? VL_COLOR.accent : VL_COLOR.muted} bold={selected}>
              {selected ? `${glyphs.human} ` : ''}
              {truncateCompletionLabel(item, 14)}
            </Text>
          </React.Fragment>
        );
      })}
    </Box>
  );
}

export interface PushSurfaceHook {
  getState?: () => {
    paletteOpen: boolean;
    pickerOpen: boolean;
    inputActive: boolean;
    rowCount: number;
  };
  getMotionState?: () => {
    palettePhase: ModalMotionState['phase'];
    paletteFade: number;
    interactionPhase: ModalMotionState['phase'];
    interactionFade: number;
    pickerPhase: ModalMotionState['phase'];
    pickerFade: number;
    attention: boolean;
  };
  openPalette?: () => void;
  closePalette?: () => void;
  submit?: (text: string) => Promise<void>;
  setComposerInput?: (text: string) => void;
  changeComposerInput?: (text: string) => void;
  complete?: (reverse?: boolean) => void;
  getComposerState?: () => { input: string; completion: CompletionState | null };
}

/**
 * Whether the launch mark should be shimmering right now. The shimmer means
 * "idle identity", so it runs ONLY when the empty transcript is genuinely in the
 * foreground: not reduced-motion, no turn running, no modal open, and an empty
 * composer. The moment a modal opens over the mark or the user starts a draft,
 * the screen is no longer idle — the shortcuts already hide, and the mark must
 * stop breathing behind the modal / above the draft rather than keep the clock
 * (and the repaint) alive on `rows.length === 0` alone. Codex P2 on #1539.
 *
 * Exported and pure so the gate is unit-tested directly rather than only through
 * the full-surface render.
 */
export function isLaunchShimmerActive(state: {
  emptyTranscript: boolean;
  reducedMotion: boolean;
  running: boolean;
  modalOpen: boolean;
  draftLength: number;
}): boolean {
  return (
    state.emptyTranscript &&
    !state.reducedMotion &&
    !state.running &&
    !state.modalOpen &&
    state.draftLength === 0
  );
}

export function handleTuiInterrupt(running: boolean, cancel: () => void, exit: () => void): void {
  if (running) cancel();
  else exit();
}

export type ComposerShortcut =
  | 'complete'
  | 'palette'
  | 'clear'
  | 'provider'
  | 'session'
  | 'copy'
  | null;

/**
 * Ctrl+O for copy, not the mnemonic Ctrl+Y: readline already owns Ctrl+Y for
 * yank-paste in the composer (see `/help`), and the root handler and the
 * TextArea both see every key — so binding a claimed chord here would fire
 * BOTH actions on one press. Ctrl+A/E, Ctrl+U/W, Ctrl+Y and Alt+B/F are
 * spoken for; Ctrl+O is not.
 */
export function resolveComposerShortcut(
  inputKey: string,
  key: { ctrl?: boolean; tab?: boolean },
): ComposerShortcut {
  if (key.tab) return 'complete';
  if (!key.ctrl) return null;
  if (inputKey === 'k') return 'palette';
  if (inputKey === 'l') return 'clear';
  if (inputKey === 'p') return 'provider';
  if (inputKey === 'r') return 'session';
  if (inputKey === 'o') return 'copy';
  return null;
}

export function PushSurface({
  controller,
  hook,
}: {
  controller: SilveryController;
  hook?: PushSurfaceHook;
}) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const { columns, rows } = useTerminalSize();
  const { exit } = useApp();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [input, setInput] = useState('');
  const [, setCompletionRevision] = useState(0);
  const [paletteAnimating, setPaletteAnimating] = useState(false);
  const [interactionAnimating, setInteractionAnimating] = useState(false);
  const [pickerAnimating, setPickerAnimating] = useState(false);
  const [configAnimating, setConfigAnimating] = useState(false);
  const reducedMotion = isReducedMotion();
  // The empty launch screen shimmers its mark (the idle state's single live
  // animation, law 8), so the clock keeps ticking there — the ONE idle exception
  // to "idle freezes" (law 6 / 8). Gated on the launch being genuinely foreground
  // (no modal, no draft, not running): the mark must not breathe behind an open
  // modal or above a draft, and reduced motion opts out entirely, keeping the
  // terminal fully quiescent at rest.
  const launchShimmerActive = isLaunchShimmerActive({
    emptyTranscript: snapshot.rows.length === 0,
    reducedMotion,
    running: snapshot.running,
    modalOpen:
      paletteOpen ||
      Boolean(snapshot.interaction) ||
      Boolean(snapshot.picker) ||
      Boolean(snapshot.configEditor),
    draftLength: input.length,
  });
  const tick = useSharedClock(
    snapshot.running ||
      paletteAnimating ||
      interactionAnimating ||
      pickerAnimating ||
      configAnimating ||
      launchShimmerActive,
  );
  const paletteMotion = useModalMotion(paletteOpen, tick, 0.35, reducedMotion, setPaletteAnimating);
  const interactionMotion = useModalMotion(
    Boolean(snapshot.interaction),
    tick,
    0.4,
    reducedMotion,
    setInteractionAnimating,
  );
  const pickerMotion = useModalMotion(
    Boolean(snapshot.picker),
    tick,
    0.35,
    reducedMotion,
    setPickerAnimating,
  );
  const configMotion = useModalMotion(
    Boolean(snapshot.configEditor),
    tick,
    0.35,
    reducedMotion,
    setConfigAnimating,
  );
  const retainedInteraction = useRef(snapshot.interaction);
  if (snapshot.interaction) retainedInteraction.current = snapshot.interaction;
  const retainedPicker = useRef(snapshot.picker);
  if (snapshot.picker) retainedPicker.current = snapshot.picker;
  const retainedConfigEditor = useRef(snapshot.configEditor);
  if (snapshot.configEditor) retainedConfigEditor.current = snapshot.configEditor;
  const paletteOpenRef = useRef(false);
  paletteOpenRef.current = paletteMotion.visible;
  const interactionOpenRef = useRef(false);
  interactionOpenRef.current = interactionMotion.visible;
  const pickerOpenRef = useRef(false);
  pickerOpenRef.current = pickerMotion.visible;
  const configOpenRef = useRef(false);
  configOpenRef.current = configMotion.visible;
  const lastAttentionInteractionId = useRef<string | null>(null);
  const [attentionTick, setAttentionTick] = useState<number | null>(null);
  const completer = useMemo(
    () =>
      createTabCompleter({
        ctx: { providerConfig: { id: snapshot.provider } },
        skills: new Map(),
        getCuratedModels: (providerId) => [...getCuratedModels(providerId)],
        getProviderList,
        workspaceRoot: snapshot.cwd,
      }),
    [snapshot.cwd, snapshot.provider],
  );

  const setComposerInput = useCallback(
    (value: string) => {
      setInput(value);
      completer.reset();
      completer.suggest(value);
      setCompletionRevision((revision) => revision + 1);
    },
    [completer],
  );

  const complete = useCallback(
    (reverse = false) => {
      const result = completer.tab(input, reverse);
      if (!result) return;
      setInput(result.text);
      setCompletionRevision((revision) => revision + 1);
    },
    [completer, input],
  );

  useEffect(() => {
    const interaction = snapshot.interaction;
    if (interaction?.kind === 'approval' && interaction.id !== lastAttentionInteractionId.current) {
      lastAttentionInteractionId.current = interaction.id;
      setAttentionTick(tick);
    }
  }, [snapshot.interaction, tick]);
  const attention = !reducedMotion && attentionTick !== null && tick - attentionTick < 1;

  const submit = useCallback(
    async (text: string) => {
      if (!text.trim() || snapshot.running) return;
      setInput('');
      completer.reset();
      setCompletionRevision((revision) => revision + 1);
      await controller.submit(text);
      // /editor parks the composed draft on the controller for the TextArea.
      const draft = controller.takePendingComposerText();
      if (draft !== null) setComposerInput(draft);
    },
    [completer, controller, setComposerInput, snapshot.running],
  );

  const changeComposerInput = useCallback(
    (value: string) => {
      if (input.length === 0 && value === '?') {
        void submit('/help');
        return;
      }
      const configTarget = resolveSensitiveConfigComposerTarget(value, snapshot.provider);
      if (configTarget) {
        setComposerInput('');
        controller.openConfigEditor(configTarget);
        return;
      }
      setComposerInput(value);
    },
    [controller, input.length, setComposerInput, snapshot.provider, submit],
  );

  const runCommand = useCallback(
    (id: (typeof COMMANDS)[number]['id']) => {
      setPaletteOpen(false);
      if (id === 'config') controller.openConfigEditor();
      else if (id === 'resume') controller.openPicker('session');
      else if (id === 'model') controller.openPicker('model');
      else if (id === 'provider') controller.openPicker('provider');
      else if (id === 'copy') controller.copyLastResponse();
      else if (id === 'clear') controller.clearDisplay();
      else if (id === 'cancel') controller.cancel();
      else exit();
    },
    [controller, exit],
  );

  const focusStack = useMemo(
    () =>
      new FocusStack()
        .register({
          id: 'interaction',
          isActive: () => interactionOpenRef.current,
          handleKey: () => true,
        })
        .register({
          id: 'picker',
          isActive: () => pickerOpenRef.current,
          handleKey: () => true,
        })
        .register({
          id: 'config',
          isActive: () => configOpenRef.current,
          handleKey: () => true,
        })
        .register({
          id: 'command-palette',
          isActive: () => paletteOpenRef.current,
          handleKey: () => true,
        }),
    [],
  );
  // The composer is live only when no scope owns the keys and no run/modal is
  // holding them. `focusStack` already includes an `interaction` scope, so this
  // is belt-and-suspenders on the modal case — but hidden-but-interactive is a
  // repeat defect class (CLAUDE.md self-review), and the focusStack path is a
  // 4-hop indirection a refactor could sever silently. Keep the modal guard
  // local, and expose the same value through the hook so test/introspection
  // state matches what the TextArea actually does.
  const inputActive =
    focusStack.activeScope() === null &&
    !snapshot.running &&
    !interactionMotion.visible &&
    !pickerMotion.visible &&
    !configMotion.visible;
  useInput(
    (inputKey, key) => {
      if (key.ctrl && inputKey === 'c') {
        handleTuiInterrupt(snapshot.running, controller.cancel, exit);
        return;
      }
      if (!inputActive) return;
      const shortcut = resolveComposerShortcut(inputKey, key);
      if (shortcut === 'complete') {
        complete(key.shift);
        return;
      }
      if (shortcut === 'palette') {
        setPaletteOpen(true);
        return;
      }
      if (shortcut === 'clear') {
        controller.clearDisplay();
        return;
      }
      if (shortcut === 'copy') {
        controller.copyLastResponse();
        return;
      }
      if (shortcut === 'session') {
        controller.openPicker('session');
        return;
      }
      if (shortcut === 'provider') controller.openPicker('provider');
    },
    {
      isActive:
        !paletteMotion.visible &&
        !interactionMotion.visible &&
        !pickerMotion.visible &&
        !configMotion.visible,
    },
  );

  useEffect(() => {
    if (!hook) return;
    hook.getState = () => ({
      paletteOpen: paletteMotion.visible,
      pickerOpen: pickerMotion.visible,
      inputActive,
      rowCount: snapshot.rows.length,
    });
    hook.getMotionState = () => ({
      palettePhase: paletteMotion.phase,
      paletteFade: paletteMotion.fade,
      interactionPhase: interactionMotion.phase,
      interactionFade: interactionMotion.fade,
      pickerPhase: pickerMotion.phase,
      pickerFade: pickerMotion.fade,
      attention,
    });
    hook.openPalette = () => setPaletteOpen(true);
    hook.closePalette = () => setPaletteOpen(false);
    hook.submit = submit;
    hook.setComposerInput = setComposerInput;
    hook.changeComposerInput = changeComposerInput;
    // The entry bridge bypasses Silvery's swallowed Tab event, so keep the
    // same focus gate here that the normal `useInput` path enforces.
    hook.complete = (reverse) => {
      if (inputActive) complete(reverse);
    };
    hook.getComposerState = () => ({ input, completion: completer.getState() });
  });

  // Frame chrome = header + composer rule + footer + optional error line ≈ 4–5 rows.
  const completionState = inputActive ? completer.getState() : null;
  const transcriptHeight = Math.max(3, rows - 6 - (completionState ? 1 : 0));
  const elapsedMs =
    snapshot.startedAt === null
      ? 0
      : Math.floor((Date.now() - snapshot.startedAt) / MOTION_TICKS.elapsedMs) *
        MOTION_TICKS.elapsedMs;
  const elapsed = snapshot.startedAt === null ? '' : ` · ${formatElapsed(elapsedMs)}`;

  let scope: FooterScope = 'composer';
  if (retainedInteraction.current?.kind === 'approval' && interactionMotion.visible)
    scope = 'approval';
  else if (retainedInteraction.current?.kind === 'question' && interactionMotion.visible)
    scope = 'question';
  else if (configMotion.visible) scope = 'picker';
  else if (pickerMotion.visible) scope = 'picker';
  else if (paletteMotion.visible) scope = 'palette';
  else if (snapshot.running) scope = 'running';

  return (
    <PushThemeProvider themeName={snapshot.theme}>
      <Screen flexDirection="column">
        <HeaderBar
          snapshot={snapshot}
          tick={tick}
          columns={columns}
          attention={attention}
          freezeMotion={
            paletteMotion.visible ||
            interactionMotion.visible ||
            pickerMotion.visible ||
            configMotion.visible
          }
        />
        <Transcript
          snapshot={snapshot}
          width={columns}
          height={transcriptHeight}
          active={
            !paletteMotion.visible &&
            !interactionMotion.visible &&
            !pickerMotion.visible &&
            !configMotion.visible
          }
          showLaunchShortcuts={inputActive && input.length === 0}
          tick={tick}
          shimmerActive={launchShimmerActive}
        />
        {snapshot.error ? (
          <Text color={VL_COLOR.fault} bold>
            {resolveGlyphs(detectUnicode()).hexActive} {snapshot.error}
          </Text>
        ) : null}
        <TextArea
          value={input}
          onChange={changeComposerInput}
          onSubmit={submit}
          submitKey="enter"
          minRows={1}
          maxRows={3}
          placeholder={snapshot.running ? 'Push is working…' : 'message Push…'}
          isActive={inputActive}
          disabled={snapshot.running}
        />
        {completionState ? <CompletionRail state={completionState} columns={columns} /> : null}
        <FooterBar snapshot={snapshot} scope={scope} columns={columns} elapsed={elapsed} />
        {interactionMotion.visible && retainedInteraction.current ? (
          <InteractionModal
            interaction={retainedInteraction.current}
            controller={controller}
            width={columns}
            fade={interactionMotion.fade}
            active={interactionMotion.interactive}
          />
        ) : configMotion.visible && retainedConfigEditor.current ? (
          <ConfigEditorModal
            key={retainedConfigEditor.current.token}
            editor={retainedConfigEditor.current}
            controller={controller}
            width={columns}
            fade={configMotion.fade}
            active={configMotion.interactive}
          />
        ) : pickerMotion.visible && retainedPicker.current ? (
          <PickerModal
            key={retainedPicker.current.token}
            picker={retainedPicker.current}
            controller={controller}
            width={columns}
            fade={pickerMotion.fade}
            active={pickerMotion.interactive}
          />
        ) : paletteMotion.visible ? (
          <Palette
            width={columns}
            fade={paletteMotion.fade}
            active={paletteMotion.interactive}
            onClose={() => setPaletteOpen(false)}
            onRun={runCommand}
          />
        ) : null}
      </Screen>
    </PushThemeProvider>
  );
}
