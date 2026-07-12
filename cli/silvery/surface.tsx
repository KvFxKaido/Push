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
import { estimateTokens, formatElapsed, formatTokenCount } from '../tui-status.js';
import type { SilveryController, SilverySnapshot, SilveryTranscriptItem } from './controller.js';

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

function Message({ item }: { item: SilveryTranscriptItem }) {
  const label = getTranscriptRoleLabel(item.role);
  const color =
    item.role === 'user'
      ? '$fg-accent'
      : item.role === 'coder'
        ? 'green'
        : item.role === 'explorer'
          ? 'cyan'
          : item.role === 'status'
            ? '$fg-muted'
            : undefined;
  return (
    <Box flexDirection="column">
      <Text bold color={color}>
        {label}
        {item.live ? ' · live' : ''}
      </Text>
      <Text color={item.role === 'status' ? '$fg-muted' : undefined}>{item.text}</Text>
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
        footer="↑↓/jk move · ↵ run · esc close"
        onClose={onClose}
        fade={0.35}
      >
        <Box flexDirection="column">
          {COMMANDS.map((command, index) => (
            <Box key={command.id} onClick={() => onRun(command.id)}>
              <Text color={index === selected ? '$fg-accent' : undefined} bold={index === selected}>
                {`${index === selected ? '❯ ' : '  '}${command.label.padEnd(20)}${command.hint}`}
              </Text>
            </Box>
          ))}
        </Box>
      </ModalDialog>
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
  const [, setClock] = useState(0);

  useEffect(() => {
    if (!snapshot.running) return;
    const timer = setInterval(() => setClock((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, [snapshot.running]);

  const submit = useCallback(
    async (text: string) => {
      if (!text.trim() || snapshot.running) return;
      setInput('');
      await controller.submit(text);
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

  const focusStack = useMemo(
    () =>
      new FocusStack().register({
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
      if (!paletteOpen && key.ctrl && inputKey === 'k') setPaletteOpen(true);
    },
    { isActive: !paletteOpen },
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

  const transcriptHeight = Math.max(3, rows - 6);
  const branch = snapshot.gitStatus?.branch || '—';
  const tokens = useMemo(
    () => estimateTokens(snapshot.rows.map((row) => ({ content: row.text }))),
    [snapshot.rows],
  );
  const elapsed =
    snapshot.startedAt === null ? '' : ` · ${formatElapsed(Date.now() - snapshot.startedAt)}`;

  return (
    <Screen flexDirection="column">
      <Box width={columns}>
        <Text bold color="$fg-accent">
          Push{' '}
        </Text>
        <Text color="$fg-muted">
          {branch} · {snapshot.provider}/{snapshot.model}
        </Text>
        <Box flexGrow={1} />
        <Text color="$fg-muted">Ctrl+K commands</Text>
      </Box>
      <Transcript
        snapshot={snapshot}
        width={columns}
        height={transcriptHeight}
        active={!paletteOpen}
      />
      {snapshot.error ? <Text color="red">{snapshot.error}</Text> : null}
      <Box width={columns}>
        <Text color={snapshot.running ? '$fg-accent' : '$fg-muted'}>
          {snapshot.running ? `live${elapsed}` : 'ready'} ·{' '}
          {snapshot.daemonConnected ? 'daemon' : 'inline'} · {formatTokenCount(tokens)} tokens
        </Text>
        <Box flexGrow={1} />
        <Text color="$fg-muted">
          {snapshot.gitStatus?.dirty ? `+${snapshot.gitStatus.dirty} ` : ''}
          {snapshot.cwd}
        </Text>
      </Box>
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
      {completer.getHint() ? <Text color="$fg-muted">{completer.getHint()}</Text> : null}
      {paletteOpen ? (
        <Palette width={columns} onClose={() => setPaletteOpen(false)} onRun={runCommand} />
      ) : null}
    </Screen>
  );
}
