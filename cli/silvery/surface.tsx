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
  useApp,
  useInput,
  useStdout,
} from 'silvery';

import { getTranscriptRoleLabel } from '../../lib/role-display.js';
import { resolveContextWindow } from '../../lib/context-budget.js';
import { getCuratedModels } from '../model-catalog.js';
import { getProviderList } from '../provider.js';
import { createTabCompleter, type CompletionState } from '../tui-completer.js';
import { FocusStack } from '../tui-focus.js';
import { getListNavigationAction } from '../tui-modal-input.js';
import { isReducedMotion } from '../tui-spinner.js';
import { estimateTokens, formatElapsed, formatTokenCount } from '../tui-status.js';
import { detectUnicode } from '../tui-theme.js';
import type { SilveryController, SilverySnapshot, SilveryTranscriptItem } from './controller.js';
import { MarkdownBody } from './markdown.js';
import { PushThemeProvider } from './theme.js';
import {
  breathingHex,
  countUserTurns,
  densityMeter,
  diffLineColor,
  footerKeybinds,
  createModalMotionState,
  formatTurnTimestamp,
  MOTION_TICKS,
  modalFadeAmount,
  modeLabel,
  reduceModalMotion,
  resolveGlyphs,
  shortenPath,
  streamMark,
  VL_COLOR,
  type FooterScope,
  type ModalMotionState,
  type StreamMarkKind,
} from './visual-language.js';

const COMMANDS = [
  { id: 'model', label: 'Switch model', hint: 'pick a curated model' },
  { id: 'provider', label: 'Switch provider', hint: 'pick a provider' },
  { id: 'clear', label: 'Clear transcript', hint: 'hide the current display' },
  { id: 'cancel', label: 'Cancel turn', hint: 'abort the active round loop' },
  { id: 'quit', label: 'Quit', hint: 'return to the terminal' },
] as const;

const PICKER_MAX_VISIBLE = 12;

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
  return (
    <Box flexDirection="column" onClick={() => setExpanded((value) => !value)}>
      <Text bold={mark.bold} color={mark.color}>
        {mark.glyph} {item.toolName ?? item.text}
        {typeof item.durationMs === 'number' ? ` · ${item.durationMs}ms` : ''}
      </Text>
      {item.diff ? <DiffCard item={item} /> : null}
      {!item.diff && item.resultPreview ? (
        <Text color={VL_COLOR.muted}>
          {expanded ? item.resultPreview : item.resultPreview.split('\n')[0]}
        </Text>
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
    // Activity from delegated phases still rides the diamond spine, not a color.
    return item.pending || item.live ? 'tool_pending' : 'tool_ok';
  }
  return 'assistant';
}

function Message({ item, tinted = false }: { item: SilveryTranscriptItem; tinted?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const glyphs = useMemo(() => resolveGlyphs(detectUnicode()), []);
  if (item.kind === 'tool') return <ToolCard item={item} />;
  const label = getTranscriptRoleLabel(item.role);
  const mark = streamMark(messageMarkKind(item), glyphs);
  const bodyColor = item.isError
    ? VL_COLOR.fault
    : item.role === 'status'
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
          {mark.glyph} {label}
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

function Transcript({
  snapshot,
  width,
  height,
  active,
}: {
  snapshot: SilverySnapshot;
  width: number;
  height: number;
  active: boolean;
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
  const shown = snapshot.rows;
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
      renderItem={(item) => (
        <Message item={item} tinted={item.kind === 'message' && item.role === 'user'} />
      )}
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
      if (action?.type === 'cancel') controller.closePicker();
      else if (action?.type === 'move')
        setSelected((value) => (Math.min(value, count - 1) + action.delta + count) % count);
      else if (action?.type === 'confirm') {
        const option = picker.options[cursor];
        if (option) controller.selectPickerOption(option.id);
      }
    },
    { isActive: active },
  );
  const modalWidth = Math.max(40, Math.min(64, width - 4));
  const labelWidth = Math.max(
    ...picker.options.map((option) => option.label.length),
    picker.kind === 'model' ? 12 : 8,
  );
  const { start, end } = pickerWindow(count, cursor);
  const visible = picker.options.slice(start, end);
  return (
    <Box position="absolute" marginLeft={2} marginTop={1} width={modalWidth}>
      <ModalDialog
        title={picker.title}
        width={modalWidth}
        footer={footerKeybinds('picker')}
        onClose={() => controller.closePicker()}
        fade={fade}
      >
        <Box flexDirection="column">
          {start > 0 ? <Text color={VL_COLOR.muted}>{`  ↑ ${start} more`}</Text> : null}
          {visible.map((option, index) => {
            const optionIndex = start + index;
            const isCursor = optionIndex === cursor;
            const label = option.label.padEnd(labelWidth);
            const badge = option.current ? ' ·current' : '';
            const hint = option.hint ? `  ${option.hint}` : '';
            const color = option.disabled ? VL_COLOR.muted : isCursor ? VL_COLOR.accent : undefined;
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
  const reduced = isReducedMotion();
  const phase = attention ? 'attention' : snapshot.running ? 'working' : 'idle';
  const live =
    freezeMotion && !attention
      ? { glyph: glyphs.hexActive, bright: false }
      : breathingHex(tick, phase, glyphs, reduced);
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
  const turnLabel = turns > 0 ? `turn ${turns}` : '';

  return (
    <Box width={columns}>
      <Text bold color={live.bright ? VL_COLOR.accent : VL_COLOR.muted}>
        {live.glyph}
      </Text>
      <Text color={VL_COLOR.muted}>
        {' '}
        · {branch}
        {dirty} · {path} · {meter} {contextLabel}
        {turnLabel ? ` · ${turnLabel}` : ''}
      </Text>
    </Box>
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

export function handleTuiInterrupt(running: boolean, cancel: () => void, exit: () => void): void {
  if (running) cancel();
  else exit();
}

export type ComposerShortcut = 'complete' | 'palette' | 'clear' | 'provider' | null;

export function resolveComposerShortcut(
  inputKey: string,
  key: { ctrl?: boolean; tab?: boolean },
): ComposerShortcut {
  if (key.tab) return 'complete';
  if (!key.ctrl) return null;
  if (inputKey === 'k') return 'palette';
  if (inputKey === 'l') return 'clear';
  if (inputKey === 'p') return 'provider';
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
  const reducedMotion = isReducedMotion();
  // One shared clock for all motion (law 8). Idle freezes (law 6 / 8).
  const tick = useSharedClock(
    snapshot.running || paletteAnimating || interactionAnimating || pickerAnimating,
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
  const retainedInteraction = useRef(snapshot.interaction);
  if (snapshot.interaction) retainedInteraction.current = snapshot.interaction;
  const retainedPicker = useRef(snapshot.picker);
  if (snapshot.picker) retainedPicker.current = snapshot.picker;
  const paletteOpenRef = useRef(false);
  paletteOpenRef.current = paletteMotion.visible;
  const interactionOpenRef = useRef(false);
  interactionOpenRef.current = interactionMotion.visible;
  const pickerOpenRef = useRef(false);
  pickerOpenRef.current = pickerMotion.visible;
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
      setComposerInput(value);
    },
    [input.length, setComposerInput, submit],
  );

  const runCommand = useCallback(
    (id: (typeof COMMANDS)[number]['id']) => {
      setPaletteOpen(false);
      if (id === 'model') controller.openPicker('model');
      else if (id === 'provider') controller.openPicker('provider');
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
    !pickerMotion.visible;
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
      if (shortcut === 'provider') controller.openPicker('provider');
    },
    { isActive: !paletteMotion.visible && !interactionMotion.visible && !pickerMotion.visible },
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
          freezeMotion={paletteMotion.visible || interactionMotion.visible || pickerMotion.visible}
        />
        <Transcript
          snapshot={snapshot}
          width={columns}
          height={transcriptHeight}
          active={!paletteMotion.visible && !interactionMotion.visible && !pickerMotion.visible}
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
