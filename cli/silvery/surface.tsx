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
import { getCuratedModels } from '../model-catalog.js';
import { getProviderList } from '../provider.js';
import { createTabCompleter } from '../tui-completer.js';
import { FocusStack } from '../tui-focus.js';
import { getListNavigationAction } from '../tui-modal-input.js';
import { isReducedMotion } from '../tui-spinner.js';
import { estimateTokens, formatElapsed, formatTokenCount } from '../tui-status.js';
import { detectUnicode } from '../tui-theme.js';
import type { SilveryController, SilverySnapshot, SilveryTranscriptItem } from './controller.js';
import { PushThemeProvider } from './theme.js';
import {
  breathingHex,
  countUserTurns,
  densityMeter,
  diffLineColor,
  footerKeybinds,
  MOTION_TICKS,
  modeLabel,
  resolveGlyphs,
  shortenPath,
  streamMark,
  VL_COLOR,
  type FooterScope,
  type StreamMarkKind,
} from './visual-language.js';

const COMMANDS = [
  { id: 'clear', label: 'Clear transcript', hint: 'hide the current display' },
  { id: 'cancel', label: 'Cancel turn', hint: 'abort the active round loop' },
  { id: 'quit', label: 'Quit', hint: 'return to the terminal' },
] as const;

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

function Message({ item }: { item: SilveryTranscriptItem }) {
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
  return (
    <Box
      flexDirection="column"
      onClick={item.kind === 'review' ? () => setExpanded((value) => !value) : undefined}
    >
      <Text bold={mark.bold} color={mark.color}>
        {mark.glyph} {label}
        {item.live ? ' · live' : ''}
      </Text>
      <Text color={bodyColor}>
        {item.kind === 'review' && !expanded ? item.text.split('\n')[0] : item.text}
      </Text>
      {item.kind === 'review' ? (
        <Text color={VL_COLOR.muted}>click to {expanded ? 'collapse' : 'expand'} review</Text>
      ) : null}
    </Box>
  );
}

function InteractionModal({
  snapshot,
  controller,
  width,
}: {
  snapshot: SilverySnapshot;
  controller: SilveryController;
  width: number;
}) {
  const interaction = snapshot.interaction!;
  const [answer, setAnswer] = useState('');
  const glyphs = useMemo(() => resolveGlyphs(detectUnicode()), []);
  const respond = useCallback(
    (value: boolean | string) => controller.respondToInteraction(interaction.id, value),
    [controller, interaction.id],
  );
  useInput((input, key) => {
    if (key.escape) respond(interaction.kind === 'approval' ? false : '');
    else if (interaction.kind === 'approval' && !key.ctrl && !key.meta) {
      if (input.toLowerCase() === 'y') respond(true);
      if (input.toLowerCase() === 'n') respond(false);
    }
  });
  const modalWidth = Math.max(40, Math.min(68, width - 4));
  return (
    <Box position="absolute" marginLeft={2} marginTop={1} width={modalWidth}>
      <ModalDialog
        title={`${glyphs.hexActive} ${interaction.title}`}
        width={modalWidth}
        footer={
          interaction.kind === 'approval' ? footerKeybinds('approval') : footerKeybinds('question')
        }
        fade={0.4}
      >
        <Box flexDirection="column" gap={1}>
          <Text>{interaction.detail}</Text>
          {interaction.kind === 'approval' ? (
            <Box gap={2}>
              <Box onClick={() => respond(true)}>
                <Text bold color={VL_COLOR.accent}>
                  [ Approve ]
                </Text>
              </Box>
              <Box onClick={() => respond(false)}>
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
              isActive
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
  // Silvery 0.21.1 provides visual-row-aware follow="end". `tailWindow`
  // remains exported as the measured fallback if a future cache backend
  // regresses pinning; its behavior is pinned by the Phase 1 test.
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
      tailReserveRows="auto"
      cache={{ mode: 'virtual', isCacheable: (_item, index) => index < shown.length - 1 }}
      virtualization="measured"
      estimateHeight={(index) => {
        const item = shown[index];
        return item ? 1 + countVisualLines(item.text || ' ', Math.max(1, width - 2)) : 2;
      }}
      overflowIndicator
      scrollbarVisibility="always"
      getKey={(item) => item.id}
      renderItem={(item) => <Message item={item} />}
    />
  );
}

function Palette({
  onClose,
  onRun,
  width,
}: {
  onClose: () => void;
  onRun: (id: (typeof COMMANDS)[number]['id']) => void;
  width: number;
}) {
  const [selected, setSelected] = useState(0);
  useInput((input, key) => {
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
  });
  const modalWidth = Math.max(36, Math.min(58, width - 4));
  return (
    <Box position="absolute" marginLeft={2} marginTop={1} width={modalWidth}>
      <ModalDialog
        title="Command Palette"
        width={modalWidth}
        footer={footerKeybinds('palette')}
        onClose={onClose}
        fade={0.35}
      >
        <Box flexDirection="column">
          {COMMANDS.map((command, index) => (
            <Box key={command.id} onClick={() => onRun(command.id)}>
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

function HeaderBar({
  snapshot,
  tick,
  columns,
}: {
  snapshot: SilverySnapshot;
  tick: number;
  columns: number;
}) {
  const glyphs = useMemo(() => resolveGlyphs(detectUnicode()), []);
  const reduced = isReducedMotion();
  const phase = snapshot.running ? 'working' : 'idle';
  const live = breathingHex(tick, phase, glyphs, reduced);
  const branch = snapshot.gitStatus?.branch || '—';
  const dirty =
    snapshot.gitStatus?.dirty && snapshot.gitStatus.dirty > 0
      ? ` +${snapshot.gitStatus.dirty}`
      : '';
  const tokens = useMemo(
    () => estimateTokens(snapshot.rows.map((row) => ({ content: row.text }))),
    [snapshot.rows],
  );
  // Soft ceiling for the density meter — 200k is a common long-context floor;
  // the number is presentation only (not a hard budget).
  const meter = densityMeter(Math.min(1, tokens / 200_000), 8, glyphs);
  const path = shortenPath(snapshot.cwd, Math.max(12, Math.min(28, Math.floor(columns / 4))));
  const turns = countUserTurns(snapshot.rows);
  const turnLabel = turns > 0 ? `t${turns}` : '';

  return (
    <Box width={columns}>
      <Text bold color={live.bright ? VL_COLOR.accent : VL_COLOR.muted}>
        {live.glyph}
      </Text>
      <Text color={VL_COLOR.muted}>
        {' '}
        · {branch}
        {dirty} · {path} · {meter} {formatTokenCount(tokens)}
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

export interface PushSurfaceHook {
  getState?: () => { paletteOpen: boolean; inputActive: boolean; rowCount: number };
  openPalette?: () => void;
  submit?: (text: string) => Promise<void>;
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
  const paletteOpenRef = useRef(false);
  paletteOpenRef.current = paletteOpen;
  const [input, setInput] = useState('');
  // One shared clock for all motion (law 8). Idle freezes (law 6 / 8).
  const tick = useSharedClock(snapshot.running);

  const submit = useCallback(
    async (text: string) => {
      if (!text.trim() || snapshot.running) return;
      setInput('');
      await controller.submit(text);
      // /editor parks the composed draft on the controller for the TextArea.
      const draft = controller.takePendingComposerText();
      if (draft !== null) setInput(draft);
    },
    [controller, snapshot.running],
  );

  const runCommand = useCallback(
    (id: (typeof COMMANDS)[number]['id']) => {
      setPaletteOpen(false);
      if (id === 'clear') controller.clearDisplay();
      else if (id === 'cancel') controller.cancel();
      else exit();
    },
    [controller, exit],
  );

  const interactionOpenRef = useRef(false);
  interactionOpenRef.current = Boolean(snapshot.interaction);
  const focusStack = useMemo(
    () =>
      new FocusStack()
        .register({
          id: 'interaction',
          isActive: () => interactionOpenRef.current,
          handleKey: () => true,
        })
        .register({
          id: 'command-palette',
          isActive: () => paletteOpenRef.current,
          handleKey: () => true,
        }),
    [],
  );
  const inputActive = focusStack.activeScope() === null && !snapshot.running;
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

  useInput(
    (inputKey, key) => {
      if (!paletteOpen && !snapshot.interaction && key.ctrl && inputKey === 'k')
        setPaletteOpen(true);
    },
    { isActive: !paletteOpen && !snapshot.interaction },
  );

  useEffect(() => {
    if (!hook) return;
    hook.getState = () => ({
      paletteOpen,
      inputActive,
      rowCount: snapshot.rows.length,
    });
    hook.openPalette = () => setPaletteOpen(true);
    hook.submit = submit;
  });

  // Frame chrome = header + composer rule + footer + optional error line ≈ 4–5 rows.
  const transcriptHeight = Math.max(3, rows - 6);
  const elapsed =
    snapshot.startedAt === null ? '' : ` · ${formatElapsed(Date.now() - snapshot.startedAt)}`;

  let scope: FooterScope = 'composer';
  if (snapshot.interaction?.kind === 'approval') scope = 'approval';
  else if (snapshot.interaction?.kind === 'question') scope = 'question';
  else if (paletteOpen) scope = 'palette';
  else if (snapshot.running) scope = 'running';

  return (
    <PushThemeProvider themeName={snapshot.theme}>
      <Screen flexDirection="column">
        <HeaderBar snapshot={snapshot} tick={tick} columns={columns} />
        <Transcript
          snapshot={snapshot}
          width={columns}
          height={transcriptHeight}
          active={!paletteOpen && !snapshot.interaction}
        />
        {snapshot.error ? (
          <Text color={VL_COLOR.fault} bold>
            {resolveGlyphs(detectUnicode()).hexActive} {snapshot.error}
          </Text>
        ) : null}
        <TextArea
          value={input}
          onChange={(value) => {
            setInput(value);
            completer.suggest(value);
          }}
          onSubmit={submit}
          submitKey="enter"
          minRows={1}
          maxRows={3}
          placeholder={snapshot.running ? 'Push is working…' : 'message Push…'}
          isActive={inputActive}
          disabled={snapshot.running}
        />
        {completer.getHint() ? <Text color={VL_COLOR.muted}>{completer.getHint()}</Text> : null}
        <FooterBar snapshot={snapshot} scope={scope} columns={columns} elapsed={elapsed} />
        {snapshot.interaction ? (
          <InteractionModal snapshot={snapshot} controller={controller} width={columns} />
        ) : paletteOpen ? (
          <Palette width={columns} onClose={() => setPaletteOpen(false)} onRun={runCommand} />
        ) : null}
      </Screen>
    </PushThemeProvider>
  );
}
