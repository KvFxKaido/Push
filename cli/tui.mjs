/**
 * tui.mjs — Push TUI full-screen terminal interface.
 * Zero dependencies beyond Node built-ins and sibling modules.
 *
 * Entry point: runTUI(options)
 * Reuses the existing engine, session store, and provider system.
 */

import process from 'node:process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { createTheme } from './tui-theme.mjs';
import { parseKey, createKeybindMap, createComposer, createInputHistory } from './tui-input.mjs';
import {
  ESC, getTermSize, visibleWidth, truncate, wordWrap, padTo,
  drawBox, drawDivider, createScreenBuffer, createRenderScheduler, computeLayout,
} from './tui-renderer.mjs';
import { PROVIDER_CONFIGS, resolveApiKey, getProviderList } from './provider.mjs';
import { getCuratedModels, fetchModels } from './model-catalog.mjs';
import { makeSessionId, saveSessionState, appendSessionEvent, loadSessionState, listSessions, deleteSession } from './session-store.mjs';
import { buildSystemPromptBase, ensureSystemPromptReady, runAssistantLoop, DEFAULT_MAX_ROUNDS } from './engine.mjs';
import { loadConfig, applyConfigToEnv, saveConfig, maskSecret } from './config-store.mjs';
import { loadSkills, interpolateSkill, getSkillPromptTemplate } from './skill-loader.mjs';
import { matchingRiskPatternIndex } from './tools.mjs';
import { createTabCompleter } from './tui-completer.mjs';
import { appendUserMessageWithFileReferences } from './file-references.mjs';
import { compactContext } from './context-manager.mjs';

// ── TUI state ───────────────────────────────────────────────────────

const MAX_TRANSCRIPT = 2000;   // max lines in transcript buffer
const MAX_TOOL_FEED = 200;     // max items in tool feed

function createTUIState() {
  return {
    // Run state machine: idle | running | awaiting_approval | awaiting_user_question
    runState: 'idle',
    // Transcript: array of { role, text, timestamp }
    transcript: [],
    // Streaming token accumulator (for in-progress assistant response)
    streamBuf: '',
    // Tool feed: array of { type: 'call'|'result', name, args?, duration?, error?, preview?, timestamp }
    toolFeed: [],
    // Approval prompt (when awaiting_approval)
    approval: null,    // { kind, summary, details }
    // User question prompt (when awaiting_user_question)
    userQuestion: null,  // { question: string, choices?: string[] }
    // UI toggles
    toolPaneOpen: false,
    reasoningModalOpen: false,
    reasoningBuf: '',
    lastReasoning: '',
    reasoningStreaming: false,
    providerModalOpen: false,
    providerModalCursor: 0,
    resumeModalOpen: false,
    resumeModalState: null,  // { loading, rows[], cursor, error, confirmDeleteId, mode, renameTargetId, renameBuf, renameCursor }
    modelModalOpen: false,
    modelModalState: null,   // { providerId, models[], cursor, loading, source, error }
    configModalOpen: false,
    configModalState: null,  // { mode: 'list'|'edit', cursor: 0, editTarget: '', editBuf: '', editCursor: 0 }
    // Scrollback offset (0 = pinned to bottom, positive = scrolled up by N lines)
    scrollOffset: 0,
    // Dirty flags for selective re-render
    dirty: new Set(['all']),
  };
}

// ── Transcript management ───────────────────────────────────────────

const DEFAULT_COMPACT_TURNS = 6;

function addTranscriptEntry(tuiState, role, text) {
  tuiState.transcript.push({ role, text, timestamp: Date.now() });
  if (tuiState.transcript.length > MAX_TRANSCRIPT) {
    tuiState.transcript.splice(0, tuiState.transcript.length - MAX_TRANSCRIPT);
  }
  tuiState.scrollOffset = 0; // auto-scroll to bottom on new content
  tuiState.dirty.add('transcript');
}

function addToolFeedEntry(tuiState, entry) {
  tuiState.toolFeed.push({ ...entry, timestamp: Date.now() });
  if (tuiState.toolFeed.length > MAX_TOOL_FEED) {
    tuiState.toolFeed.splice(0, tuiState.toolFeed.length - MAX_TOOL_FEED);
  }
  tuiState.dirty.add('tools');
}

// ── Pane renderers ──────────────────────────────────────────────────

function renderHeader(buf, layout, theme, { provider, model, session, cwd, runState, branch }) {
  const { glyphs } = theme;
  const { top, left, width } = layout.header;

  // Line 1: product name + provider badge
  const providerBadge = theme.style('fg.secondary', `[${provider}]`);
  const stateDot = runState === 'running'
    ? theme.style('state.warn', glyphs.statusDot)
    : runState === 'awaiting_approval'
      ? theme.style('state.error', glyphs.statusDot)
      : theme.style('state.success', glyphs.statusDot);

  const line1 = `${theme.bold(theme.style('fg.primary', 'Push'))} ${providerBadge} ${stateDot} ${theme.style('fg.dim', runState)}`;
  buf.writeLine(top, left, padTo(line1, width));

  // Line 2: model
  const modelLabel = theme.style('fg.muted', 'model:');
  const modelValue = theme.style('fg.primary', ` ${model}`);
  buf.writeLine(top + 1, left, padTo(`${modelLabel}${modelValue}`, width));

  // Line 3: directory + branch
  const dirLabel = theme.style('fg.muted', 'dir:');
  const dirValue = theme.style('fg.secondary', ` ${truncate(cwd, width - 20)}`);
  const branchStr = branch ? `  ${theme.style('fg.dim', 'branch:')} ${theme.style('accent.link', branch)}` : '';
  buf.writeLine(top + 2, left, padTo(`${dirLabel}${dirValue}${branchStr}`, width));

  // Line 4: session id + hint
  const sessLabel = theme.style('fg.dim', `session: ${session}`);
  const hint = theme.style('accent.link', '/model');
  buf.writeLine(top + 3, left, padTo(`${sessLabel}  ${hint}`, width));
}

function renderTranscript(buf, layout, theme, tuiState) {
  const { top, left, width, height } = layout.transcript;
  const { glyphs } = theme;

  // Build visible lines from transcript (bottom-aligned)
  const visibleLines = [];

  for (const entry of tuiState.transcript) {
    if (entry.role === 'user') {
      const prefix = theme.style('accent.primary', glyphs.prompt + ' ');
      const wrapped = wordWrap(entry.text, width - 2);
      for (let i = 0; i < wrapped.length; i++) {
        visibleLines.push(i === 0 ? prefix + theme.style('fg.primary', wrapped[i]) : '  ' + theme.style('fg.primary', wrapped[i]));
      }
    } else if (entry.role === 'assistant') {
      const wrapped = wordWrap(entry.text, width);
      for (const line of wrapped) {
        visibleLines.push(theme.style('fg.primary', line));
      }
    } else if (entry.role === 'tool_call') {
      const ok = !entry.error;
      const status = ok
        ? theme.style('state.success', 'OK')
        : theme.style('state.error', 'ERR');
      const dur = entry.duration ? theme.style('fg.dim', ` ${entry.duration}ms`) : '';
      visibleLines.push(
        theme.style('fg.muted', `  ${glyphs.horizontal} `) +
        theme.style('fg.secondary', entry.text) +
        ` ${status}${dur}`
      );
    } else if (entry.role === 'status') {
      for (const line of wordWrap(entry.text, width - 2)) {
        visibleLines.push(theme.style('fg.dim', '  ' + line));
      }
    } else if (entry.role === 'error') {
      const errLines = wordWrap(entry.text, width - 10);
      for (let i = 0; i < errLines.length; i++) {
        const prefix = i === 0 ? '  ERROR: ' : '         ';
        visibleLines.push(theme.style('state.error', prefix + errLines[i]));
      }
    } else if (entry.role === 'warning') {
      const warnLines = wordWrap(entry.text, width - 9);
      for (let i = 0; i < warnLines.length; i++) {
        const prefix = i === 0 ? '  WARN: ' : '        ';
        visibleLines.push(theme.style('state.warn', prefix + warnLines[i]));
      }
    }
  }

  // Add streaming buffer if assistant is currently streaming
  if (tuiState.streamBuf) {
    const wrapped = wordWrap(tuiState.streamBuf, width);
    for (const line of wrapped) {
      visibleLines.push(theme.style('fg.primary', line));
    }
  }

  // Take the last `height` lines (scroll to bottom), adjusted by scrollOffset
  const maxScroll = Math.max(0, visibleLines.length - height);
  const effectiveOffset = Math.min(tuiState.scrollOffset, maxScroll);
  const startIdx = Math.max(0, maxScroll - effectiveOffset);
  const slice = visibleLines.slice(startIdx, startIdx + height);

  // Render
  for (let r = 0; r < height; r++) {
    const line = r < slice.length ? slice[r] : '';
    buf.writeLine(top + r, left, padTo(line, width));
  }

  // Scroll indicator when not at bottom
  if (effectiveOffset > 0) {
    const indicator = theme.style('fg.dim', `[+${effectiveOffset} lines]`);
    buf.writeLine(top + height - 1, left + width - visibleWidth(indicator) - 1, indicator);
  }
}

function renderToolPane(buf, layout, theme, tuiState) {
  if (!layout.toolPane) return;
  const { top, left, width, height } = layout.toolPane;
  const { glyphs } = theme;

  // Title
  const title = theme.style('fg.secondary', ' Tools ');
  buf.writeLine(top, left, padTo(title, width));

  // Tool feed entries (bottom-aligned)
  const lines = [];
  for (const entry of tuiState.toolFeed) {
    if (entry.type === 'call') {
      const argsPreview = entry.args
        ? truncate(JSON.stringify(entry.args), width - entry.name.length - 6)
        : '';
      lines.push(
        theme.style('accent.secondary', glyphs.prompt) + ' ' +
        theme.style('fg.primary', entry.name) +
        (argsPreview ? ' ' + theme.style('fg.dim', argsPreview) : '')
      );
    } else if (entry.type === 'result') {
      const ok = !entry.error;
      const status = ok
        ? theme.style('state.success', glyphs.check || 'OK')
        : theme.style('state.error', glyphs.cross_mark || 'ERR');
      const dur = entry.duration ? theme.style('fg.dim', `${entry.duration}ms`) : '';
      const preview = entry.preview
        ? ' ' + theme.style('fg.dim', truncate(entry.preview, width - 20))
        : '';
      lines.push(`  ${status} ${theme.style('fg.secondary', entry.name)} ${dur}${preview}`);
    }
  }

  const startIdx = Math.max(0, lines.length - (height - 1));
  const slice = lines.slice(startIdx, startIdx + height - 1);

  for (let r = 0; r < height - 1; r++) {
    const line = r < slice.length ? slice[r] : '';
    buf.writeLine(top + 1 + r, left, padTo(line, width));
  }
}

function renderComposer(buf, layout, theme, composer, tuiState, tabState) {
  const { top, left, width, height } = layout.composer;
  const { glyphs } = theme;

  // Top border with label
  const stateLabel = tuiState.runState === 'running'
    ? theme.style('state.warn', ' streaming... ')
    : tuiState.runState === 'awaiting_approval'
      ? theme.style('state.error', ' approval required ')
      : tuiState.runState === 'awaiting_user_question'
        ? theme.style('accent.primary', ' ? question ')
        : theme.style('fg.muted', ' message ');
  const tabHint = tabState ? tabState.hint : null;
  const label = tabHint
    ? stateLabel + theme.style('accent.primary', ` ${tabHint} `)
    : stateLabel;

  const borderChar = glyphs.horizontal;
  const labelWidth = visibleWidth(label);
  const borderLeft = borderChar.repeat(2);
  const borderRight = borderChar.repeat(Math.max(0, width - 2 - labelWidth - 2));
  const topBorder = theme.style('border.default', borderLeft) + label + theme.style('border.default', borderRight);
  buf.writeLine(top, left, topBorder);

  // Candidates bar (when tab completion is active — preview or cycling)
  let candidateRowUsed = false;
  if (tabState && tabState.candidates) {
    const { items, index } = tabState.candidates;
    const previewing = index < 0; // no selection yet, just showing options
    let candidateLine = '  ';
    let lineWidth = 2;
    for (let i = 0; i < items.length; i++) {
      const label = truncate(items[i], 30);
      const sep = i > 0 ? '  ' : '';
      const needed = visibleWidth(sep + label);
      if (lineWidth + needed > width - 1) break; // don't overflow
      candidateLine += sep;
      if (previewing) {
        candidateLine += theme.style('fg.secondary', label);
      } else {
        candidateLine += i === index
          ? theme.style('accent.primary', label)
          : theme.style('fg.dim', label);
      }
      lineWidth += needed;
    }
    buf.writeLine(top + 1, left, padTo(candidateLine, width));
    candidateRowUsed = true;
  }

  // Composer content lines
  const lines = composer.getLines();
  const contentTop = top + 1 + (candidateRowUsed ? 1 : 0);
  const innerHeight = height - 1 - (candidateRowUsed ? 1 : 0); // -1 for border, -1 if candidates shown
  for (let r = 0; r < innerHeight; r++) {
    if (r < lines.length) {
      const prefix = r === 0 ? theme.style('accent.primary', glyphs.prompt + ' ') : '  ';
      const content = lines[r];
      buf.writeLine(contentTop + r, left, padTo(prefix + theme.style('fg.primary', content), width));
    } else {
      buf.writeLine(contentTop + r, left, ' '.repeat(width));
    }
  }
}

function renderFooter(buf, layout, theme, tuiState, keybindHints) {
  const { top, left, width } = layout.footer;

  // Left: keybind hints
  let leftHints;
  if (tuiState.runState === 'awaiting_approval') {
    leftHints = [
      theme.style('accent.link', 'Ctrl+Y / y') + theme.style('fg.dim', ' approve'),
      theme.style('accent.link', 'a') + theme.style('fg.dim', ' always'),
      theme.style('accent.link', 'Ctrl+N / n') + theme.style('fg.dim', ' deny'),
      theme.style('accent.link', 'Esc') + theme.style('fg.dim', ' dismiss'),
    ].join('  ');
  } else if (tuiState.runState === 'awaiting_user_question') {
    leftHints = [
      theme.style('accent.link', 'Enter') + theme.style('fg.dim', ' submit answer'),
      theme.style('accent.link', 'Esc') + theme.style('fg.dim', ' skip'),
    ].join('  ');
  } else {
    leftHints = [
      theme.style('accent.link', 'Ctrl+T') + theme.style('fg.dim', ' tools'),
      theme.style('accent.link', 'Ctrl+G') + theme.style('fg.dim', ' reasoning'),
      theme.style('accent.link', 'Ctrl+C') + theme.style('fg.dim', ' cancel'),
      theme.style('accent.link', 'Ctrl+P') + theme.style('fg.dim', ' provider'),
    ].join('  ');
  }

  // Right: state indicator
  const stateLabel = tuiState.runState === 'running'
    ? theme.style('state.warn', 'running')
    : tuiState.runState === 'awaiting_approval'
      ? theme.style('state.error', 'awaiting approval')
      : tuiState.runState === 'awaiting_user_question'
        ? theme.style('accent.primary', 'awaiting answer')
        : theme.style('state.success', 'idle');

  // Layout left/right
  const rightWidth = visibleWidth(stateLabel);
  const leftWidth = width - rightWidth - 2;
  const leftStr = truncate(leftHints, leftWidth);
  const rightStr = stateLabel;

  buf.writeLine(top, left, padTo(leftStr, leftWidth) + '  ' + rightStr);
}

function renderApprovalModal(buf, theme, rows, cols, approval) {
  if (!approval) return;
  const { glyphs } = theme;

  // Modal dimensions
  const modalWidth = Math.min(60, cols - 8);
  const lines = [
    theme.bold(theme.style('state.warn', '  Approval Required')),
    '',
    `  ${theme.style('fg.secondary', 'kind:')} ${theme.style('fg.primary', approval.kind || 'exec')}`,
    `  ${theme.style('fg.secondary', 'detail:')}`,
  ];

  // Wrap the summary into the modal
  const summaryLines = wordWrap(approval.summary || '', modalWidth - 6);
  for (const sl of summaryLines) {
    lines.push(`    ${theme.style('fg.primary', sl)}`);
  }

  lines.push('');
  lines.push(
    `  ${theme.style('accent.link', 'Ctrl+Y / y')} approve  ` +
    `${theme.style('accent.link', 'a')} always  ` +
    `${theme.style('accent.link', 'Ctrl+N / n')} deny  ` +
    `${theme.style('accent.link', 'Esc')} close`
  );

  const modalHeight = lines.length + 2; // +2 for top/bottom border
  const modalTop = Math.floor((rows - modalHeight) / 2);
  const modalLeft = Math.floor((cols - modalWidth) / 2);

  // Draw box
  const boxLines = drawBox(lines, modalWidth, glyphs, theme);
  for (let i = 0; i < boxLines.length; i++) {
    buf.writeLine(modalTop + i, modalLeft, boxLines[i]);
  }
}

function renderQuestionModal(buf, theme, rows, cols, userQuestion, inputBuf) {
  if (!userQuestion) return;
  const { glyphs } = theme;

  const modalWidth = Math.min(64, cols - 8);
  const lines = [
    theme.bold(theme.style('accent.primary', '  Question')),
    '',
  ];

  // Wrap the question text
  const questionLines = wordWrap(userQuestion.question || '', modalWidth - 6);
  for (const ql of questionLines) {
    lines.push(`  ${theme.style('fg.primary', ql)}`);
  }

  // Choices (if provided)
  if (userQuestion.choices?.length) {
    lines.push('');
    lines.push(`  ${theme.style('fg.secondary', 'Choices:')} ${userQuestion.choices.map((c) => theme.style('accent.link', c)).join('  ')}`);
  }

  lines.push('');
  // Input line with cursor
  const inputDisplay = inputBuf + theme.style('fg.primary', '█');
  lines.push(`  ${theme.style('fg.dim', '›')} ${inputDisplay}`);
  lines.push('');
  lines.push(`  ${theme.style('accent.link', 'Enter')} ${theme.style('fg.dim', 'submit')}  ${theme.style('accent.link', 'Esc')} ${theme.style('fg.dim', 'skip')}`);

  const modalHeight = lines.length + 2;
  const modalTop = Math.floor((rows - modalHeight) / 2);
  const modalLeft = Math.floor((cols - modalWidth) / 2);

  const boxLines = drawBox(lines, modalWidth, glyphs, theme);
  for (let i = 0; i < boxLines.length; i++) {
    buf.writeLine(modalTop + i, modalLeft, boxLines[i]);
  }
}

function renderReasoningModal(buf, theme, rows, cols, tuiState) {
  const { glyphs } = theme;
  const modalWidth = Math.min(80, cols - 8);
  const modalHeight = Math.min(22, rows - 6);
  const bodyWidth = Math.max(10, modalWidth - 4);
  const bodyHeight = Math.max(6, modalHeight - 6);
  const modalTop = Math.floor((rows - modalHeight) / 2);
  const modalLeft = Math.floor((cols - modalWidth) / 2);

  const live = tuiState.reasoningStreaming;
  const text = tuiState.reasoningBuf || tuiState.lastReasoning || '';
  const lines = [
    theme.bold(theme.style('fg.primary', `  Reasoning ${live ? '(live)' : ''}`)),
    '',
  ];

  if (!text.trim()) {
    lines.push(`  ${theme.style('fg.dim', 'No reasoning captured yet in this TUI session.')}`);
  } else {
    const wrapped = [];
    for (const rawLine of text.split('\n')) {
      const chunks = wordWrap(rawLine, bodyWidth);
      if (chunks.length === 0) wrapped.push('');
      else wrapped.push(...chunks);
    }
    const hidden = Math.max(0, wrapped.length - bodyHeight);
    const visible = wrapped.slice(Math.max(0, wrapped.length - bodyHeight));
    if (hidden > 0) {
      lines.push(`  ${theme.style('fg.dim', `[${hidden} more lines above]`)}`);
      lines.push('');
    }
    for (const line of visible) {
      lines.push(`  ${theme.style('fg.dim', line)}`);
    }
  }

  lines.push('');
  lines.push(`  ${theme.style('accent.link', 'Ctrl+G')} toggle  ${theme.style('accent.link', 'Esc')} close`);

  const boxLines = drawBox(lines, modalWidth, glyphs, theme);
  for (let i = 0; i < boxLines.length; i++) {
    buf.writeLine(modalTop + i, modalLeft, boxLines[i]);
  }
}

function renderProviderModal(buf, theme, rows, cols, currentProvider, currentModel, cursor = 0) {
  const { glyphs } = theme;
  const providers = getProviderList();
  const modalWidth = Math.min(56, cols - 8);

  const lines = [
    theme.bold(theme.style('fg.primary', '  Provider / Model')),
    '',
  ];

  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    const isCurrent = p.id === currentProvider;
    const isCursor = i === cursor;
    const hasKey = p.hasKey ? theme.style('state.success', glyphs.check) : theme.style('fg.dim', '-');
    const marker = isCursor ? theme.style('accent.primary', glyphs.prompt) : ' ';
    let name = theme.style('fg.secondary', p.id);
    if (isCurrent) name = theme.style('fg.primary', p.id);
    if (isCursor) name = theme.style('accent.primary', p.id);
    const currentTag = isCurrent ? theme.style('fg.dim', ' (current)') : '';
    lines.push(`  ${marker} ${i + 1}. ${name}  ${hasKey}${currentTag}`);
  }

  lines.push('');

  // Current model + curated list
  const models = getCuratedModels(currentProvider);
  lines.push(`  ${theme.style('fg.muted', 'model:')} ${theme.style('fg.primary', currentModel)}`);
  if (models.length > 0) {
    const modelPreview = models.slice(0, 4).map(m => truncate(m, 30)).join(', ');
    lines.push(`  ${theme.style('fg.dim', modelPreview)}`);
  }

  lines.push('');
  lines.push(`  ${theme.style('fg.dim', '\u2191\u2193 navigate  Enter switch  Esc close  1-9 quick pick')}`);

  const modalHeight = lines.length + 2;
  const modalTop = Math.floor((rows - modalHeight) / 2);
  const modalLeft = Math.floor((cols - modalWidth) / 2);

  const boxLines = drawBox(lines, modalWidth, glyphs, theme);
  for (let i = 0; i < boxLines.length; i++) {
    buf.writeLine(modalTop + i, modalLeft, boxLines[i]);
  }
}

function renderModelModal(buf, theme, rows, cols, modalState, currentModel) {
  const { glyphs } = theme;
  const modalWidth = Math.min(80, cols - 8);
  const listHeight = Math.max(6, Math.min(14, rows - 16));

  const lines = [
    theme.bold(theme.style('fg.primary', '  Model Picker')),
    '',
    `  ${theme.style('fg.muted', 'provider:')} ${theme.style('fg.secondary', modalState.providerId)}`,
    `  ${theme.style('fg.muted', 'current:')} ${theme.style('fg.primary', currentModel)}`,
    '',
  ];

  if (modalState.models.length === 0) {
    lines.push(`  ${theme.style('fg.dim', 'No models found. Use /model <name> for custom values.')}`);
  } else {
    const count = modalState.models.length;
    let start = 0;
    if (count > listHeight) {
      start = Math.max(0, modalState.cursor - Math.floor(listHeight / 2));
      start = Math.min(start, count - listHeight);
    }
    const end = Math.min(count, start + listHeight);

    for (let i = start; i < end; i++) {
      const isCursor = i === modalState.cursor;
      const marker = isCursor ? theme.style('accent.primary', glyphs.prompt) : ' ';
      const num = padTo(`${i + 1}.`, 4);
      const modelText = truncate(modalState.models[i], modalWidth - 14);
      const model = isCursor
        ? theme.style('accent.primary', modelText)
        : theme.style('fg.secondary', modelText);
      const currentMark = modalState.models[i] === currentModel
        ? theme.style('fg.dim', ' (current)')
        : '';
      lines.push(`  ${marker} ${num} ${model}${currentMark}`);
    }

    if (end < count) {
      lines.push(`  ${theme.style('fg.dim', `... ${count - end} more`)}`);
    }
  }

  lines.push('');
  if (modalState.loading) {
    lines.push(`  ${theme.style('fg.dim', 'Fetching live model list...')}`);
  } else if (modalState.error) {
    lines.push(`  ${theme.style('fg.dim', `Live fetch failed (${modalState.error}); showing curated list`)}`);
  } else if (modalState.source === 'live') {
    lines.push(`  ${theme.style('fg.dim', `${modalState.models.length} models from provider`)}`);
  } else {
    lines.push(`  ${theme.style('fg.dim', `${modalState.models.length} curated models`)}`);
  }
  lines.push(`  ${theme.style('fg.dim', '\u2191\u2193 navigate  Enter select  Esc close  1-9 quick pick')}`);

  const modalHeight = lines.length + 2;
  const modalTop = Math.floor((rows - modalHeight) / 2);
  const modalLeft = Math.floor((cols - modalWidth) / 2);

  const boxLines = drawBox(lines, modalWidth, glyphs, theme);
  for (let i = 0; i < boxLines.length; i++) {
    buf.writeLine(modalTop + i, modalLeft, boxLines[i]);
  }
}

function formatRelativeTime(ts) {
  if (!Number.isFinite(Number(ts)) || Number(ts) <= 0) return 'unknown';
  const deltaMs = Math.max(0, Date.now() - Number(ts));
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const iso = new Date(Number(ts)).toISOString();
  return iso.slice(0, 16).replace('T', ' ');
}

function renderResumeModal(buf, theme, rows, cols, modalState, currentSessionId) {
  const { glyphs } = theme;
  const modalWidth = Math.min(92, cols - 8);
  const listHeight = Math.max(6, Math.min(12, rows - 18));

  const lines = [
    theme.bold(theme.style('fg.primary', '  Resume Session')),
    '',
  ];

    const isRenameMode = modalState?.mode === 'rename';
    if (!modalState || modalState.loading) {
    lines.push(`  ${theme.style('fg.dim', 'Loading resumable sessions...')}`);
  } else if (modalState.error) {
    lines.push(`  ${theme.style('state.error', modalState.error)}`);
  } else if (!Array.isArray(modalState.rows) || modalState.rows.length === 0) {
    lines.push(`  ${theme.style('fg.dim', 'No resumable sessions found.')}`);
  } else {
    const count = modalState.rows.length;
    let start = 0;
    if (count > listHeight) {
      start = Math.max(0, modalState.cursor - Math.floor(listHeight / 2));
      start = Math.min(start, count - listHeight);
    }
    const end = Math.min(count, start + listHeight);

    for (let i = start; i < end; i++) {
      const row = modalState.rows[i];
      const isCursor = i === modalState.cursor;
      const isCurrent = row.sessionId === currentSessionId;
      const marker = isCursor ? theme.style('accent.primary', glyphs.prompt) : ' ';
      const num = padTo(`${i + 1}.`, 4);
      const primaryRaw = row.sessionName || row.sessionId;
      const primaryText = truncate(primaryRaw, Math.max(16, modalWidth - 42));
      const primary = isCursor
        ? theme.style('accent.primary', primaryText)
        : theme.style('fg.primary', primaryText);
      const currentTag = isCurrent ? theme.style('fg.dim', ' (current)') : '';
      const deleteTag = modalState.confirmDeleteId === row.sessionId
        ? theme.style('state.warn', ' [delete?]')
        : '';
      const renameTag = modalState.mode === 'rename' && modalState.renameTargetId === row.sessionId
        ? theme.style('accent.primary', ' [rename]')
        : '';
      const meta = truncate(
        `${row.provider}/${row.model} · ${path.basename(row.cwd || '.') || '.'} · ${formatRelativeTime(row.updatedAt)}`,
        Math.max(12, modalWidth - 16),
      );
      lines.push(`  ${marker} ${num} ${primary}${currentTag}${deleteTag}${renameTag}`);
      lines.push(`      ${theme.style('fg.dim', meta)}`);
    }
    if (end < count) {
      lines.push(`  ${theme.style('fg.dim', `... ${count - end} more`)}`);
    }
    lines.push('');

    const selected = modalState.rows[modalState.cursor];
    if (selected) {
      const selectedName = selected.sessionName ? `name: ${selected.sessionName} · ` : '';
      lines.push(`  ${theme.style('fg.muted', `${selectedName}id: ${selected.sessionId}`)}`);
      lines.push(`  ${theme.style('fg.dim', truncate(selected.cwd || '.', modalWidth - 4))}`);
      if (isRenameMode && modalState.renameTargetId === selected.sessionId) {
        lines.push('');
        lines.push(`  ${theme.style('fg.muted', 'Rename (empty = clear):')}`);
        const inputWidth = modalWidth - 8;
        const inputDisplay = modalState.renameBuf || '';
        const shown = inputDisplay
          ? truncate(inputDisplay, inputWidth)
          : theme.style('fg.dim', '_'.repeat(Math.min(36, inputWidth)));
        lines.push(`  ${theme.style('accent.primary', '\u203A')} ${shown}`);
      }
    }
  }

  lines.push('');
  if (isRenameMode) {
    lines.push(`  ${theme.style('accent.primary', 'Enter')} save  ${theme.style('accent.primary', 'Esc')} cancel  ${theme.style('fg.dim', 'Backspace/Delete edit')}`);
  } else if (modalState?.confirmDeleteId) {
    lines.push(`  ${theme.style('state.warn', 'Delete selected session? Enter or D to confirm · Esc to cancel')}`);
    lines.push(`  ${theme.style('fg.dim', '\u2191\u2193 change selection (cancels delete)  1-9 quick pick')}`);
  } else {
    lines.push(`  ${theme.style('fg.dim', '\u2191\u2193 navigate  Enter resume  R rename  D delete  Esc close  1-9 quick pick')}`);
  }

  const modalHeight = lines.length + 2;
  const modalTop = Math.floor((rows - modalHeight) / 2);
  const modalLeft = Math.floor((cols - modalWidth) / 2);

  const boxLines = drawBox(lines, modalWidth, glyphs, theme);
  for (let i = 0; i < boxLines.length; i++) {
    buf.writeLine(modalTop + i, modalLeft, boxLines[i]);
  }
}

// ── Config modal ─────────────────────────────────────────────────────

/** Mask an input string: show dots except last 4 chars for verification. */
function maskInput(str) {
  if (str.length <= 4) return str;
  return '\u2022'.repeat(str.length - 4) + str.slice(-4);
}

/**
 * Build the ordered list of config items.
 * Items 0–5: providers, 6: tavily, 7: sandbox.
 */
function getConfigItems(providerList, config) {
  const items = [];
  for (const p of providerList) {
    const providerConf = config[p.id] || {};
    const cfg = PROVIDER_CONFIGS[p.id];
    let keyStatus = false;
    try {
      const k = resolveApiKey(cfg);
      if (k) keyStatus = true;
    } catch { /* no key */ }
    items.push({
      type: 'provider',
      id: p.id,
      hasKey: keyStatus,
      model: providerConf.model || cfg.defaultModel,
    });
  }
  // Tavily
  const tavilyKey = process.env.PUSH_TAVILY_API_KEY || config.tavilyApiKey || '';
  items.push({ type: 'tavily', id: 'tavily', hasKey: Boolean(tavilyKey) });
  // Sandbox
  const sandbox = process.env.PUSH_LOCAL_SANDBOX || (config.localSandbox !== undefined ? String(config.localSandbox) : 'off');
  const sandboxOn = sandbox === 'true' || sandbox === '1';
  items.push({ type: 'sandbox', id: 'sandbox', sandboxOn });
  // ExecMode
  const execMode = process.env.PUSH_EXEC_MODE || config.execMode || 'auto';
  items.push({ type: 'execMode', id: 'execMode', execMode });
  return items;
}

function renderConfigModal(buf, theme, rows, cols, modalState, config) {
  const { glyphs } = theme;
  const providers = getProviderList();
  const items = getConfigItems(providers, config);
  const modalWidth = Math.min(50, cols - 8);

  if (modalState.mode === 'list') {
    // ── List mode ──
    const lines = [
      theme.bold(theme.style('fg.primary', '  Config')),
      '',
    ];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const isCursor = i === modalState.cursor;
      const marker = isCursor ? theme.style('accent.primary', '\u203A') : ' ';
      const num = `${i + 1}.`;

      if (item.type === 'provider') {
        const keyIcon = item.hasKey
          ? theme.style('state.success', glyphs.check)
          : theme.style('fg.dim', '-');
        const modelStr = truncate(item.model, modalWidth - 28);
        const name = isCursor
          ? theme.style('accent.primary', item.id)
          : theme.style('fg.secondary', item.id);
        const nameCol = padTo(name, 14);
        lines.push(`  ${marker} ${num} ${nameCol} ${keyIcon}  ${theme.style('fg.dim', modelStr)}`);
      } else if (item.type === 'tavily') {
        const keyIcon = item.hasKey
          ? theme.style('state.success', glyphs.check)
          : theme.style('fg.dim', '-');
        const name = isCursor
          ? theme.style('accent.primary', 'tavily')
          : theme.style('fg.secondary', 'tavily');
        lines.push(`  ${marker} ${num} ${padTo(name, 14)} ${keyIcon}`);
      } else if (item.type === 'sandbox') {
        const status = item.sandboxOn
          ? theme.style('state.success', 'on')
          : theme.style('fg.dim', 'off');
        const name = isCursor
          ? theme.style('accent.primary', 'sandbox')
          : theme.style('fg.secondary', 'sandbox');
        lines.push(`  ${marker} ${num} ${padTo(name, 14)} ${status}`);
      } else if (item.type === 'execMode') {
        const modeColor = item.execMode === 'yolo' ? 'state.warning' : item.execMode === 'auto' ? 'state.success' : 'fg.secondary';
        const modeStr = theme.style(modeColor, item.execMode);
        const name = isCursor
          ? theme.style('accent.primary', 'execMode')
          : theme.style('fg.secondary', 'execMode');
        lines.push(`  ${marker} ${num} ${padTo(name, 14)} ${modeStr}`);
      }

      // Visual gap between providers and extras
      if (i === providers.length - 1) lines.push('');
    }

    lines.push('');
    lines.push(
      `  ${theme.style('fg.dim', '\u2191\u2193 navigate  Enter edit  Esc close')}`
    );

    const modalHeight = lines.length + 2;
    const modalTop = Math.floor((rows - modalHeight) / 2);
    const modalLeft = Math.floor((cols - modalWidth) / 2);

    const boxLines = drawBox(lines, modalWidth, glyphs, theme);
    for (let i = 0; i < boxLines.length; i++) {
      buf.writeLine(modalTop + i, modalLeft, boxLines[i]);
    }
  } else if (modalState.mode === 'edit') {
    // ── Edit mode ──
    const targetLabel = modalState.editTarget;
    const lines = [
      theme.bold(theme.style('fg.primary', `  API key for ${targetLabel}`)),
      '',
    ];

    // Show current key (masked)
    let currentDisplay = '(not set)';
    if (targetLabel === 'tavily') {
      const k = process.env.PUSH_TAVILY_API_KEY || config.tavilyApiKey || '';
      if (k) currentDisplay = maskSecret(k);
    } else {
      const cfg = PROVIDER_CONFIGS[targetLabel];
      if (cfg) {
        try {
          const k = resolveApiKey(cfg);
          if (k) currentDisplay = maskSecret(k);
        } catch { /* no key */ }
      }
    }
    lines.push(`  ${theme.style('fg.muted', 'Current:')} ${theme.style('fg.secondary', currentDisplay)}`);
    lines.push('');

    // Input line with masked display
    const inputDisplay = modalState.editBuf
      ? maskInput(modalState.editBuf)
      : '';
    const inputWidth = modalWidth - 8;
    const inputPad = inputDisplay
      ? truncate(inputDisplay, inputWidth)
      : theme.style('fg.dim', '_'.repeat(Math.min(36, inputWidth)));
    lines.push(`  ${theme.style('accent.primary', '\u203A')} ${inputPad}`);
    lines.push('');
    lines.push(`  ${theme.style('fg.dim', 'Paste key + Enter to save \u00B7 Esc cancel')}`);

    const modalHeight = lines.length + 2;
    const modalTop = Math.floor((rows - modalHeight) / 2);
    const modalLeft = Math.floor((cols - modalWidth) / 2);

    const boxLines = drawBox(lines, modalWidth, glyphs, theme);
    for (let i = 0; i < boxLines.length; i++) {
      buf.writeLine(modalTop + i, modalLeft, boxLines[i]);
    }
  } else if (modalState.mode === 'pick') {
    // ── Pick mode (exec mode selection) ──
    const EXEC_MODES = [
      { id: 'strict', desc: 'prompt before every exec command' },
      { id: 'auto',   desc: 'prompt only for high-risk commands' },
      { id: 'yolo',   desc: 'no exec prompts' },
    ];
    const lines = [
      theme.bold(theme.style('fg.primary', '  Exec mode')),
      '',
    ];
    for (let i = 0; i < EXEC_MODES.length; i++) {
      const m = EXEC_MODES[i];
      const isCursor = i === modalState.pickCursor;
      const marker = isCursor ? theme.style('accent.primary', '\u203A') : ' ';
      const label = isCursor ? theme.style('accent.primary', m.id) : theme.style('fg.secondary', m.id);
      lines.push(`  ${marker} ${padTo(label, 8)}  ${theme.style('fg.dim', m.desc)}`);
    }
    lines.push('');
    lines.push(`  ${theme.style('fg.dim', '\u2191\u2193 select  Enter save  Esc cancel')}`);

    const modalHeight = lines.length + 2;
    const modalTop = Math.floor((rows - modalHeight) / 2);
    const modalLeft = Math.floor((cols - modalWidth) / 2);

    const boxLines = drawBox(lines, modalWidth, glyphs, theme);
    for (let i = 0; i < boxLines.length; i++) {
      buf.writeLine(modalTop + i, modalLeft, boxLines[i]);
    }
  }
}

// ── Main TUI entry point ────────────────────────────────────────────

/**
 * Run the full-screen TUI.
 * @param {{ sessionId?, provider?, model?, cwd?, maxRounds? }} options
 */
export async function runTUI(options = {}) {
  const theme = createTheme();
  const tuiState = createTUIState();
  const composer = createComposer();
  const keybinds = createKeybindMap();
  const screenBuf = createScreenBuffer();
  const inputHistory = createInputHistory();

  // ── Resolve provider/session ─────────────────────────────────────

  const config = await loadConfig();
  applyConfigToEnv(config);
  const safeExecPatterns = Array.isArray(config.safeExecPatterns) ? config.safeExecPatterns : [];

  const maxRounds = options.maxRounds || DEFAULT_MAX_ROUNDS;

  async function createFreshSessionState(providerName, requestedModel, cwd) {
    const providerConfig = PROVIDER_CONFIGS[providerName];
    if (!providerConfig) throw new Error(`Unknown provider: ${providerName}`);
    const sessionId = makeSessionId();
    const now = Date.now();
    const nextState = {
      sessionId,
      createdAt: now,
      updatedAt: now,
      provider: providerName,
      model: requestedModel,
      cwd,
      rounds: 0,
      eventSeq: 0,
      workingMemory: {
        plan: '',
        openTasks: [],
        filesTouched: [],
        assumptions: [],
        errorsEncountered: [],
      },
      messages: [{ role: 'system', content: buildSystemPromptBase(cwd) }],
    };
    // Start enriching the system prompt in the background — will be
    // awaited before the first LLM call in runAssistantLoop.
    ensureSystemPromptReady(nextState);
    // Disk writes are deferred to first user message (lazy session creation).
    return nextState;
  }

  // ── Session init ─────────────────────────────────────────────────

  let state;
  if (options.sessionId) {
    state = await loadSessionState(options.sessionId);
    // Optional resume overrides
    let stateChanged = false;

    if (options.provider) {
      const overrideProvider = options.provider.toLowerCase();
      const overrideConfig = PROVIDER_CONFIGS[overrideProvider];
      if (!overrideConfig) throw new Error(`Unknown provider: ${overrideProvider}`);
      if (overrideProvider !== state.provider) {
        state.provider = overrideProvider;
        state.model = options.model || overrideConfig.defaultModel;
        stateChanged = true;
      }
    }

    if (options.model && options.model !== state.model) {
      state.model = options.model;
      stateChanged = true;
    }

    if (options.cwd) {
      const resolvedCwd = path.resolve(options.cwd);
      if (resolvedCwd !== state.cwd) {
        state.cwd = resolvedCwd;
        stateChanged = true;
      }
    }

    if (stateChanged) {
      await saveSessionState(state);
    }
  } else {
    const providerName = (options.provider || process.env.PUSH_PROVIDER || config.provider || 'ollama').toLowerCase();
    const cwd = path.resolve(options.cwd || process.cwd());
    const providerConfig = PROVIDER_CONFIGS[providerName];
    if (!providerConfig) throw new Error(`Unknown provider: ${providerName}`);
    const requestedModel = options.model || providerConfig.defaultModel;
    state = await createFreshSessionState(providerName, requestedModel, cwd);
  }

  const activeProviderConfig = PROVIDER_CONFIGS[state.provider];
  if (!activeProviderConfig) throw new Error(`Unknown provider in session: ${state.provider}`);

  // Mutable context for mid-session switching
  const ctx = {
    providerConfig: activeProviderConfig,
    apiKey: resolveApiKey(activeProviderConfig),
  };

  // ── Lazy session creation ─────────────────────────────────────────
  // Resumed sessions are already on disk; fresh sessions are persisted on first message.
  let sessionPersisted = !!options.sessionId;

  async function ensureSessionPersisted() {
    if (sessionPersisted) return;
    sessionPersisted = true;
    await appendSessionEvent(state, 'session_started', {
      sessionId: state.sessionId,
      state: 'idle',
      mode: 'tui',
      provider: state.provider,
    });
    await saveSessionState(state);
  }

  // ── Git branch (best-effort) ─────────────────────────────────────

  let branch = '';
  async function refreshBranchLabel() {
    branch = '';
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execAsync = promisify(execFile);
      const { stdout } = await execAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: state.cwd });
      branch = stdout.trim();
    } catch { /* not a git repo */ }
  }
  await refreshBranchLabel();

  // ── Abort controller ─────────────────────────────────────────────

  let runAbort = null;

  // ── Enter alternate screen ───────────────────────────────────────

  process.stdout.write(ESC.altScreenOn + ESC.cursorHide + ESC.clearScreen + ESC.bracketedPasteOn);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding(null);

  // ── Render function ──────────────────────────────────────────────

  function render() {
    const { rows, cols } = getTermSize();

    // Min terminal size guard
    if (rows < 16 || cols < 60) {
      screenBuf.clear();
      screenBuf.write(ESC.clearScreen);
      const msg = 'Terminal too small (need 60x16)';
      const msgRow = Math.max(1, Math.floor(rows / 2));
      const msgCol = Math.max(1, Math.floor((cols - msg.length) / 2) + 1);
      screenBuf.writeLine(msgRow, msgCol, msg);
      screenBuf.flush();
      return;
    }

    const layout = computeLayout(rows, cols, {
      toolPaneOpen: tuiState.toolPaneOpen,
      composerLines: composer.getLines().length,
    });

    screenBuf.clear();

    // Background fill
    screenBuf.write(theme.bg('bg.base'));
    screenBuf.write(ESC.clearScreen);

    // Panes
    renderHeader(screenBuf, layout, theme, {
      provider: state.provider,
      model: state.model,
      session: state.sessionId,
      cwd: state.cwd,
      runState: tuiState.runState,
      branch,
    });

    // Divider between header and transcript
    screenBuf.writeLine(
      layout.header.top + layout.header.height,
      layout.innerLeft,
      drawDivider(layout.innerWidth, theme.glyphs, theme)
    );

    renderTranscript(screenBuf, layout, theme, tuiState);
    renderToolPane(screenBuf, layout, theme, tuiState);
    // Live-suggest candidates from current composer text (no-op when cycling)
    tabCompleter.suggest(composer.getText());
    const tabState = tabCompleter.isActive()
      ? { hint: tabCompleter.getHint(), candidates: tabCompleter.getState() }
      : null;
    renderComposer(screenBuf, layout, theme, composer, tuiState, tabState);
    renderFooter(screenBuf, layout, theme, tuiState);

    // Modals (overlay)
    if (tuiState.runState === 'awaiting_approval' && tuiState.approval) {
      renderApprovalModal(screenBuf, theme, rows, cols, tuiState.approval);
    }
    if (tuiState.runState === 'awaiting_user_question' && tuiState.userQuestion) {
      renderQuestionModal(screenBuf, theme, rows, cols, tuiState.userQuestion, questionInputBuf);
    }
    if (tuiState.reasoningModalOpen) {
      renderReasoningModal(screenBuf, theme, rows, cols, tuiState);
    }
    if (tuiState.providerModalOpen) {
      renderProviderModal(screenBuf, theme, rows, cols, state.provider, state.model, tuiState.providerModalCursor);
    }
    if (tuiState.resumeModalOpen && tuiState.resumeModalState) {
      renderResumeModal(screenBuf, theme, rows, cols, tuiState.resumeModalState, state.sessionId);
    }
    if (tuiState.modelModalOpen && tuiState.modelModalState) {
      renderModelModal(screenBuf, theme, rows, cols, tuiState.modelModalState, state.model);
    }
    if (tuiState.configModalOpen && tuiState.configModalState) {
      renderConfigModal(screenBuf, theme, rows, cols, tuiState.configModalState, config);
    }

    // Position cursor in composer (offset by 1 if candidates bar is visible)
    const cursor = composer.getCursor();
    const candidateOffset = tabState ? 1 : 0;
    const cursorRow = layout.composer.top + 1 + candidateOffset + cursor.line;
    const cursorLine = composer.getLines()[cursor.line] || '';
    const cursorCol = layout.innerLeft + 2 + visibleWidth(cursorLine.slice(0, cursor.col)); // +2 for prompt prefix, CJK-aware
    screenBuf.write(ESC.cursorTo(cursorRow, cursorCol));

    // Show cursor only when idle
    if (tuiState.runState === 'idle') {
      screenBuf.write(ESC.cursorShow);
    } else {
      screenBuf.write(ESC.cursorHide);
    }

    screenBuf.write(theme.RESET);
    screenBuf.flush();
    tuiState.dirty.clear();
  }

  const scheduler = createRenderScheduler(render);

  // ── Engine event handler ─────────────────────────────────────────

  function handleEngineEvent(event) {
    switch (event.type) {
      case 'assistant_thinking_token':
        tuiState.reasoningBuf += event.payload.text;
        tuiState.reasoningStreaming = true;
        tuiState.dirty.add(tuiState.reasoningModalOpen ? 'all' : 'footer');
        scheduler.schedule();
        break;

      case 'assistant_thinking_done':
        tuiState.reasoningStreaming = false;
        if (tuiState.reasoningBuf.trim()) {
          tuiState.lastReasoning = tuiState.reasoningBuf;
        }
        if (tuiState.reasoningModalOpen) tuiState.dirty.add('all');
        scheduler.schedule();
        break;

      case 'assistant_token':
        tuiState.streamBuf += event.payload.text;
        tuiState.scrollOffset = 0; // auto-scroll on new tokens
        tuiState.dirty.add('transcript');
        scheduler.schedule();
        break;

      case 'assistant_done':
        if (tuiState.streamBuf) {
          addTranscriptEntry(tuiState, 'assistant', tuiState.streamBuf);
          tuiState.streamBuf = '';
        }
        tuiState.reasoningStreaming = false;
        if (tuiState.reasoningBuf.trim()) {
          tuiState.lastReasoning = tuiState.reasoningBuf;
        }
        scheduler.schedule();
        break;

      case 'tool_call':
        addToolFeedEntry(tuiState, {
          type: 'call',
          name: event.payload.toolName,
          args: event.payload.args,
        });
        addTranscriptEntry(tuiState, 'tool_call', {
          text: event.payload.toolName,
          error: false,
        });
        // Override: store as tool_call transcript entry with tool metadata
        const tc = tuiState.transcript[tuiState.transcript.length - 1];
        tc.text = event.payload.toolName;
        tc.role = 'tool_call';
        scheduler.schedule();
        break;

      case 'tool_result': {
        const isError = event.payload.isError;
        const text = event.payload.text || '';
        addToolFeedEntry(tuiState, {
          type: 'result',
          name: event.payload.toolName,
          duration: event.payload.durationMs,
          error: isError,
          preview: text.slice(0, 100),
        });
        // Update the last tool_call transcript entry with result info
        for (let i = tuiState.transcript.length - 1; i >= 0; i--) {
          if (tuiState.transcript[i].role === 'tool_call' && tuiState.transcript[i].text === event.payload.toolName) {
            tuiState.transcript[i].error = isError;
            tuiState.transcript[i].duration = event.payload.durationMs;
            break;
          }
        }
        scheduler.schedule();
        break;
      }

      case 'status':
        addTranscriptEntry(tuiState, 'status', event.payload.detail || event.payload.phase);
        scheduler.schedule();
        break;

      case 'warning':
        addTranscriptEntry(tuiState, 'warning', event.payload.message || event.payload.code);
        scheduler.schedule();
        break;

      case 'error':
        addTranscriptEntry(tuiState, 'error', event.payload.message);
        scheduler.schedule();
        break;

      case 'run_complete':
        tuiState.runState = 'idle';
        tuiState.streamBuf = '';
        tuiState.reasoningStreaming = false;
        if (tuiState.reasoningBuf.trim()) {
          tuiState.lastReasoning = tuiState.reasoningBuf;
        }
        tuiState.dirty.add('all');
        process.stdout.write('\x07'); // bell
        scheduler.schedule();
        break;
    }
  }

  // ── Approval handling ────────────────────────────────────────────

  let approvalResolve = null;
  const trustedPatterns = new Set();

  // ── Ask-user handling ─────────────────────────────────────────────

  let questionResolve = null;
  let questionInputBuf = '';

  function makeAskUserFn() {
    return (question, choices) => new Promise((resolve) => {
      questionInputBuf = '';
      questionResolve = resolve;
      tuiState.runState = 'awaiting_user_question';
      tuiState.userQuestion = { question, choices: choices ?? null };
      tuiState.dirty.add('all');
      scheduler.flush();
    });
  }

  function submitQuestionAnswer() {
    if (questionResolve) {
      const answer = questionInputBuf;
      questionResolve(answer);
      questionResolve = null;
      questionInputBuf = '';
      tuiState.userQuestion = null;
      tuiState.runState = 'running';
      tuiState.dirty.add('all');
      scheduler.schedule();
    }
  }

  function dismissQuestion() {
    if (questionResolve) {
      questionResolve('(skipped — make a reasonable assumption)');
      questionResolve = null;
      questionInputBuf = '';
      tuiState.userQuestion = null;
      tuiState.runState = 'running';
      tuiState.dirty.add('all');
      scheduler.schedule();
    }
  }

  /** Dedicated input handler for the ask_user modal — captures typed text. */
  function handleQuestionInput(key) {
    if (key.name === 'return' || key.name === 'enter') {
      submitQuestionAnswer();
      return;
    }
    if (key.name === 'escape') {
      dismissQuestion();
      return;
    }
    if (key.name === 'backspace' || key.name === 'delete') {
      if (questionInputBuf.length > 0) {
        questionInputBuf = questionInputBuf.slice(0, -1);
        tuiState.dirty.add('all');
        scheduler.schedule();
      }
      return;
    }
    // Printable character
    if (key.sequence && !key.ctrl && !key.meta && key.sequence.length === 1 && key.sequence.charCodeAt(0) >= 32) {
      questionInputBuf += key.sequence;
      tuiState.dirty.add('all');
      scheduler.schedule();
    }
  }

  function makeApprovalFn() {
    return (tool, detail) => {
      const patternIndex = matchingRiskPatternIndex(detail);

      // Session trust: auto-approve if this risk pattern was previously trusted
      if (patternIndex >= 0 && trustedPatterns.has(patternIndex)) {
        addTranscriptEntry(tuiState, 'status', `[auto-approved] ${tool}: ${detail}`);
        scheduler.schedule();
        return Promise.resolve(true);
      }

      return new Promise((resolve) => {
        tuiState.runState = 'awaiting_approval';
        tuiState.approval = { kind: tool, summary: detail, patternIndex };
        approvalResolve = resolve;
        tuiState.dirty.add('all');
        scheduler.flush();
      });
    };
  }

  // ── Skills ────────────────────────────────────────────────────────

  const skills = await loadSkills(state.cwd);

  async function reloadSkillsMap() {
    const fresh = await loadSkills(state.cwd);
    skills.clear();
    for (const [name, skill] of fresh) {
      skills.set(name, skill);
    }
    tabCompleter.reset();
    return skills.size;
  }

  function createCurrentTabCompleter() {
    return createTabCompleter({
      ctx, skills, getCuratedModels, getProviderList,
      workspaceRoot: state.cwd,
      extraCommands: ['resume', 'compact'],
    });
  }

  let tabCompleter = createCurrentTabCompleter();

  function formatError(err) {
    if (err instanceof Error && err.message) return err.message;
    return String(err);
  }

  function handleAsyncError(err, context = '') {
    const message = context ? `${context}: ${formatError(err)}` : formatError(err);
    addTranscriptEntry(tuiState, 'error', message);
    tuiState.dirty.add('all');
    scheduler.flush();
  }

  function runAsync(action, context = '') {
    try {
      const maybePromise = action();
      if (maybePromise && typeof maybePromise.then === 'function') {
        void maybePromise.catch((err) => {
          handleAsyncError(err, context);
        });
      }
    } catch (err) {
      handleAsyncError(err, context);
    }
  }

  // ── Actions ──────────────────────────────────────────────────────

  /** Run the assistant loop on a user message (or skill-expanded prompt). */
  async function runPrompt(text, options = {}) {
    tuiState.runState = 'running';
    tuiState.reasoningBuf = '';
    tuiState.reasoningStreaming = false;
    tuiState.dirty.add('all');
    scheduler.flush();

    await ensureSessionPersisted();
    await appendUserMessageWithFileReferences(state, text, state.cwd, {
      referenceSourceText: options.referenceSourceText,
    });
    await appendSessionEvent(state, 'user_message', { chars: text.length, preview: text.slice(0, 280) });

    runAbort = new AbortController();

    try {
      await runAssistantLoop(state, ctx.providerConfig, ctx.apiKey, maxRounds, {
        approvalFn: makeApprovalFn(),
        askUserFn: makeAskUserFn(),
        signal: runAbort.signal,
        emit: handleEngineEvent,
        safeExecPatterns,
        execMode: process.env.PUSH_EXEC_MODE || 'auto',
      });
      await saveSessionState(state);
    } catch (err) {
      if (err.name !== 'AbortError') {
        addTranscriptEntry(tuiState, 'error', err.message || String(err));
      }
      await saveSessionState(state);
    } finally {
      tuiState.runState = 'idle';
      runAbort = null;
      tuiState.dirty.add('all');
      scheduler.flush();
    }
  }

  async function compactSessionContext(rawArg) {
    const arg = String(rawArg || '').trim();
    let preserveTurns = DEFAULT_COMPACT_TURNS;
    if (arg) {
      if (!/^\d+$/.test(arg)) {
        addTranscriptEntry(tuiState, 'warning', 'Usage: /compact [turns] (positive integer)');
        scheduler.flush();
        return;
      }
      preserveTurns = Math.max(1, Math.min(64, Number.parseInt(arg, 10)));
    }

    const result = compactContext(state.messages, { preserveTurns });
    if (!result.compacted) {
      addTranscriptEntry(
        tuiState,
        'status',
        `Nothing to compact (turns: ${result.totalTurns}, preserve: ${result.preserveTurns}).`,
      );
      scheduler.flush();
      return;
    }

    state.messages = result.messages;
    await appendSessionEvent(state, 'context_compacted', {
      preserveTurns: result.preserveTurns,
      totalTurns: result.totalTurns,
      compactedMessages: result.compactedCount,
      removedCount: result.removedCount,
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
    });
    await saveSessionState(state);

    addTranscriptEntry(
      tuiState,
      'status',
      `Compacted context: ${result.compactedCount} messages -> 1 summary (kept last ${result.preserveTurns} turns, ~${result.beforeTokens} -> ~${result.afterTokens} tokens).`,
    );
    scheduler.flush();
  }

  async function renameCurrentSession(rawName) {
    const trimmed = typeof rawName === 'string' ? rawName.trim() : '';
    if (!trimmed) {
      addTranscriptEntry(tuiState, 'warning', 'Usage: /session rename <name> | /session rename --clear');
      scheduler.flush();
      return;
    }

    if (trimmed === '--clear') {
      delete state.sessionName;
      await appendSessionEvent(state, 'session_renamed', { name: null });
      await saveSessionState(state);
      addTranscriptEntry(tuiState, 'status', 'Session name cleared.');
      scheduler.flush();
      return;
    }

    state.sessionName = trimmed;
    await appendSessionEvent(state, 'session_renamed', { name: trimmed });
    await saveSessionState(state);
    addTranscriptEntry(tuiState, 'status', `Session renamed: ${JSON.stringify(trimmed)}`);
    scheduler.flush();
  }

  function resetTUIViewForSessionChange() {
    tuiState.runState = 'idle';
    tuiState.streamBuf = '';
    tuiState.approval = null;
    approvalResolve = null;
    tuiState.reasoningModalOpen = false;
    tuiState.reasoningBuf = '';
    tuiState.lastReasoning = '';
    tuiState.reasoningStreaming = false;
    tuiState.transcript = [];
    tuiState.toolFeed = [];
    tuiState.scrollOffset = 0;
    tuiState.providerModalOpen = false;
    tuiState.providerModalCursor = 0;
    tuiState.resumeModalOpen = false;
    tuiState.resumeModalState = null;
    tuiState.modelModalOpen = false;
    tuiState.modelModalState = null;
    tuiState.configModalOpen = false;
    tuiState.configModalState = null;
    composer.clear();
    tabCompleter = createCurrentTabCompleter();
    tabCompleter.reset();
  }

  async function switchToSessionById(targetSessionId, { closePicker = true } = {}) {
    if (!targetSessionId) return false;
    if (tuiState.runState !== 'idle') {
      addTranscriptEntry(tuiState, 'warning', 'Cannot resume another session while a run is active.');
      scheduler.flush();
      return false;
    }

    if (targetSessionId === state.sessionId) {
      if (closePicker) {
        tuiState.resumeModalOpen = false;
        tuiState.resumeModalState = null;
      }
      addTranscriptEntry(tuiState, 'status', `Already on session: ${state.sessionId}`);
      scheduler.flush();
      return true;
    }

    let nextState;
    try {
      nextState = await loadSessionState(targetSessionId);
    } catch (err) {
      addTranscriptEntry(tuiState, 'error', `Failed to load session ${targetSessionId}: ${formatError(err)}`);
      scheduler.flush();
      return false;
    }

    const nextProviderConfig = PROVIDER_CONFIGS[nextState.provider];
    if (!nextProviderConfig) {
      addTranscriptEntry(tuiState, 'error', `Cannot resume ${targetSessionId}: unknown provider "${nextState.provider}".`);
      scheduler.flush();
      return false;
    }

    let nextApiKey;
    try {
      nextApiKey = resolveApiKey(nextProviderConfig);
    } catch (err) {
      addTranscriptEntry(
        tuiState,
        'error',
        `Cannot resume ${targetSessionId}: missing API key for ${nextProviderConfig.id} (${formatError(err)}).`,
      );
      scheduler.flush();
      return false;
    }

    const previousSessionId = state.sessionId;
    await ensureSessionPersisted(); // flush any unpersisted current session before switching
    await saveSessionState(state);
    state = nextState;
    sessionPersisted = true; // resumed session is already on disk
    ctx.providerConfig = nextProviderConfig;
    ctx.apiKey = nextApiKey;

    await refreshBranchLabel();
    resetTUIViewForSessionChange();
    await reloadSkillsMap();

    const nameSuffix = state.sessionName ? ` (${JSON.stringify(state.sessionName)})` : '';
    addTranscriptEntry(
      tuiState,
      'status',
      `Resumed session: ${state.sessionId}${nameSuffix} (from ${previousSessionId}) [${state.provider}/${state.model}]`,
    );
    addTranscriptEntry(tuiState, 'status', `Workspace: ${state.cwd}`);
    tuiState.dirty.add('all');
    scheduler.flush();
    return true;
  }

  async function openResumeModal() {
    if (tuiState.runState !== 'idle') {
      addTranscriptEntry(tuiState, 'warning', 'Cannot open resume picker while a run is active.');
      scheduler.flush();
      return;
    }

    tuiState.resumeModalOpen = true;
    tuiState.resumeModalState = {
      loading: true,
      rows: [],
      cursor: 0,
      error: null,
      confirmDeleteId: null,
      mode: 'list',
      renameTargetId: null,
      renameBuf: '',
      renameCursor: 0,
    };
    tuiState.dirty.add('all');
    scheduler.flush();

    try {
      const rows = await listSessions();
      const currentIndex = rows.findIndex((row) => row.sessionId === state.sessionId);
      tuiState.resumeModalState = {
        loading: false,
        rows,
        cursor: currentIndex >= 0 ? currentIndex : 0,
        error: null,
        confirmDeleteId: null,
        mode: 'list',
        renameTargetId: null,
        renameBuf: '',
        renameCursor: 0,
      };
    } catch (err) {
      tuiState.resumeModalState = {
        loading: false,
        rows: [],
        cursor: 0,
        error: `Failed to list sessions: ${formatError(err)}`,
        confirmDeleteId: null,
        mode: 'list',
        renameTargetId: null,
        renameBuf: '',
        renameCursor: 0,
      };
    }

    tuiState.dirty.add('all');
    scheduler.flush();
  }

  async function handleResumeModalInput(key) {
    const ms = tuiState.resumeModalState;
    if (!ms) return;
    const renameRequested = key.ch && !key.ctrl && !key.meta && String(key.ch).toLowerCase() === 'r';
    const deleteRequested = (ms.mode !== 'rename') && ((key.name === 'delete')
      || (key.ch && !key.ctrl && !key.meta && ['d', 'x'].includes(String(key.ch).toLowerCase())));

    const exitRenameMode = () => {
      ms.mode = 'list';
      ms.renameTargetId = null;
      ms.renameBuf = '';
      ms.renameCursor = 0;
      ms.confirmDeleteId = null;
    };

    const rows = Array.isArray(ms.rows) ? ms.rows : [];

    async function saveRename() {
      const targetId = ms.renameTargetId;
      if (!targetId) {
        exitRenameMode();
        return;
      }
      const trimmed = ms.renameBuf.trim();
      try {
        if (targetId === state.sessionId) {
          if (trimmed) state.sessionName = trimmed;
          else delete state.sessionName;
          await appendSessionEvent(state, 'session_renamed', { name: trimmed || null });
          await saveSessionState(state);
        } else {
          const targetState = await loadSessionState(targetId);
          if (trimmed) targetState.sessionName = trimmed;
          else delete targetState.sessionName;
          await appendSessionEvent(targetState, 'session_renamed', { name: trimmed || null });
          await saveSessionState(targetState);
        }

        const nextRows = await listSessions();
        ms.rows = nextRows;
        const nextIndex = nextRows.findIndex((r) => r.sessionId === targetId);
        ms.cursor = nextIndex >= 0 ? nextIndex : Math.min(ms.cursor, Math.max(0, nextRows.length - 1));
        ms.error = null;
        exitRenameMode();

        if (trimmed) {
          addTranscriptEntry(tuiState, 'status', `Session renamed: ${JSON.stringify(trimmed)} (${targetId})`);
        } else {
          addTranscriptEntry(tuiState, 'status', `Session name cleared: ${targetId}`);
        }
      } catch (err) {
        ms.error = `Rename failed: ${formatError(err)}`;
      } finally {
        tuiState.dirty.add('all');
        scheduler.flush();
      }
    }

    if (key.name === 'escape') {
      if (ms.mode === 'rename') {
        exitRenameMode();
        ms.error = null;
        tuiState.dirty.add('all');
        scheduler.schedule();
        return;
      }
      if (ms.confirmDeleteId) {
        ms.confirmDeleteId = null;
        ms.error = null;
        tuiState.dirty.add('all');
        scheduler.schedule();
        return;
      }
      closeModal();
      return;
    }

    if (rows.length === 0 || ms.loading) {
      return;
    }

    if (ms.mode === 'rename') {
      if (key.name === 'return') {
        await saveRename();
        return;
      }
      if (key.name === 'backspace') {
        if (ms.renameCursor > 0) {
          ms.renameBuf = ms.renameBuf.slice(0, ms.renameCursor - 1) + ms.renameBuf.slice(ms.renameCursor);
          ms.renameCursor--;
        }
        tuiState.dirty.add('all');
        scheduler.schedule();
        return;
      }
      if (key.name === 'delete') {
        if (ms.renameCursor < ms.renameBuf.length) {
          ms.renameBuf = ms.renameBuf.slice(0, ms.renameCursor) + ms.renameBuf.slice(ms.renameCursor + 1);
        }
        tuiState.dirty.add('all');
        scheduler.schedule();
        return;
      }
      if (key.name === 'left') {
        if (ms.renameCursor > 0) ms.renameCursor--;
        tuiState.dirty.add('all');
        scheduler.schedule();
        return;
      }
      if (key.name === 'right') {
        if (ms.renameCursor < ms.renameBuf.length) ms.renameCursor++;
        tuiState.dirty.add('all');
        scheduler.schedule();
        return;
      }
      if (key.name === 'home') {
        ms.renameCursor = 0;
        tuiState.dirty.add('all');
        scheduler.schedule();
        return;
      }
      if (key.name === 'end') {
        ms.renameCursor = ms.renameBuf.length;
        tuiState.dirty.add('all');
        scheduler.schedule();
        return;
      }
      if (key.ctrl && key.name === 'u') {
        ms.renameBuf = '';
        ms.renameCursor = 0;
        tuiState.dirty.add('all');
        scheduler.schedule();
        return;
      }
      if (key.ch && !key.ctrl && !key.meta) {
        ms.renameBuf = ms.renameBuf.slice(0, ms.renameCursor) + key.ch + ms.renameBuf.slice(ms.renameCursor);
        ms.renameCursor += key.ch.length;
        tuiState.dirty.add('all');
        scheduler.schedule();
        return;
      }
      return;
    }

    if (key.name === 'up') {
      ms.cursor = (ms.cursor - 1 + rows.length) % rows.length;
      ms.confirmDeleteId = null;
      ms.error = null;
      tuiState.dirty.add('all');
      scheduler.schedule();
      return;
    }
    if (key.name === 'down') {
      ms.cursor = (ms.cursor + 1) % rows.length;
      ms.confirmDeleteId = null;
      ms.error = null;
      tuiState.dirty.add('all');
      scheduler.schedule();
      return;
    }
    if (key.ch >= '1' && key.ch <= '9') {
      const idx = parseInt(key.ch, 10) - 1;
      if (idx >= 0 && idx < rows.length) {
        ms.confirmDeleteId = null;
        ms.error = null;
        await switchToSessionById(rows[idx].sessionId, { closePicker: true });
      }
      return;
    }
    if (renameRequested) {
      const row = rows[ms.cursor];
      if (!row) return;
      ms.mode = 'rename';
      ms.renameTargetId = row.sessionId;
      ms.renameBuf = row.sessionName || '';
      ms.renameCursor = ms.renameBuf.length;
      ms.confirmDeleteId = null;
      ms.error = null;
      tuiState.dirty.add('all');
      scheduler.schedule();
      return;
    }
    if (deleteRequested) {
      const row = rows[ms.cursor];
      if (!row) return;
      if (row.sessionId === state.sessionId) {
        ms.error = 'Cannot delete the currently active session.';
        ms.confirmDeleteId = null;
        tuiState.dirty.add('all');
        scheduler.schedule();
        return;
      }
      if (ms.confirmDeleteId !== row.sessionId) {
        ms.confirmDeleteId = row.sessionId;
        ms.error = null;
        tuiState.dirty.add('all');
        scheduler.schedule();
        return;
      }

      try {
        const deleted = await deleteSession(row.sessionId);
        if (deleted === 0) {
          ms.error = `Session not found: ${row.sessionId}`;
        } else {
          const displayName = row.sessionName ? `${JSON.stringify(row.sessionName)} (${row.sessionId})` : row.sessionId;
          addTranscriptEntry(tuiState, 'status', `Deleted session: ${displayName}`);
          const nextRows = await listSessions();
          ms.rows = nextRows;
          ms.cursor = nextRows.length === 0 ? 0 : Math.min(ms.cursor, nextRows.length - 1);
          ms.error = null;
        }
      } catch (err) {
        ms.error = `Delete failed: ${formatError(err)}`;
      } finally {
        ms.confirmDeleteId = null;
        tuiState.dirty.add('all');
        scheduler.flush();
      }
      return;
    }
    if (key.name === 'return') {
      const row = rows[ms.cursor];
      if (row) {
        if (ms.confirmDeleteId === row.sessionId) {
          try {
            const deleted = await deleteSession(row.sessionId);
            if (deleted === 0) {
              ms.error = `Session not found: ${row.sessionId}`;
            } else {
              const displayName = row.sessionName ? `${JSON.stringify(row.sessionName)} (${row.sessionId})` : row.sessionId;
              addTranscriptEntry(tuiState, 'status', `Deleted session: ${displayName}`);
              const nextRows = await listSessions();
              ms.rows = nextRows;
              ms.cursor = nextRows.length === 0 ? 0 : Math.min(ms.cursor, nextRows.length - 1);
              ms.error = null;
            }
          } catch (err) {
            ms.error = `Delete failed: ${formatError(err)}`;
          } finally {
            ms.confirmDeleteId = null;
            tuiState.dirty.add('all');
            scheduler.flush();
          }
          return;
        }
        ms.error = null;
        await switchToSessionById(row.sessionId, { closePicker: true });
      }
      return;
    }
  }

  async function startNewSession() {
    if (tuiState.runState !== 'idle') {
      addTranscriptEntry(tuiState, 'warning', 'Cannot start a new session while a run is active.');
      scheduler.flush();
      return;
    }

    const previousSessionId = state.sessionId;
    await ensureSessionPersisted(); // flush any unpersisted current session before switching
    await saveSessionState(state);
    state = await createFreshSessionState(state.provider, state.model, state.cwd);
    sessionPersisted = false; // new session starts lazy
    await refreshBranchLabel();
    resetTUIViewForSessionChange();

    addTranscriptEntry(
      tuiState,
      'status',
      `Started new session: ${state.sessionId} (from ${previousSessionId}) [${state.provider}/${state.model}]`,
    );
    tuiState.dirty.add('all');
    scheduler.flush();
  }

  async function switchModel(target, { closePicker = false } = {}) {
    if (!target) return;

    if (target === state.model) {
      addTranscriptEntry(tuiState, 'status', `Already using model: ${target}`);
      if (closePicker) {
        closeModelModal();
      } else {
        scheduler.flush();
      }
      return;
    }

    state.model = target;
    // Persist per-provider model default (matches classic REPL behavior).
    if (!config[ctx.providerConfig.id]) config[ctx.providerConfig.id] = {};
    config[ctx.providerConfig.id].model = target;
    await saveConfig(config);
    await saveSessionState(state);
    addTranscriptEntry(tuiState, 'status', `Model switched to: ${target}`);
    if (closePicker) {
      closeModelModal();
    } else {
      tuiState.dirty.add('all');
      scheduler.flush();
    }
  }

  function closeModelModal() {
    tuiState.modelModalOpen = false;
    tuiState.modelModalState = null;
    tuiState.dirty.add('all');
    scheduler.flush();
  }

  async function openModelPicker() {
    const providerId = ctx.providerConfig.id;
    const initialModels = getCuratedModels(providerId);
    const initialCursor = Math.max(0, initialModels.indexOf(state.model));

    tuiState.modelModalOpen = true;
    tuiState.modelModalState = {
      providerId,
      models: initialModels,
      cursor: initialCursor,
      loading: true,
      source: 'curated',
      error: '',
    };
    tuiState.dirty.add('all');
    scheduler.flush();

    const { models, source, error } = await fetchModels(ctx.providerConfig, ctx.apiKey);
    const ms = tuiState.modelModalState;
    if (!ms || !tuiState.modelModalOpen || ms.providerId !== providerId) return;

    ms.models = models;
    ms.source = source;
    ms.error = error || '';
    ms.loading = false;

    const currentIndex = models.indexOf(state.model);
    if (currentIndex >= 0) {
      ms.cursor = currentIndex;
    } else if (ms.cursor >= models.length) {
      ms.cursor = Math.max(0, models.length - 1);
    }

    tuiState.dirty.add('all');
    scheduler.flush();
  }

  async function selectModelFromPicker(index) {
    const ms = tuiState.modelModalState;
    if (!ms || index < 0 || index >= ms.models.length) return;
    await switchModel(ms.models[index], { closePicker: true });
  }

  async function handleModelModalInput(key) {
    const ms = tuiState.modelModalState;
    if (!ms) return;

    if (key.name === 'escape') {
      closeModelModal();
      return;
    }
    if (key.name === 'up') {
      if (ms.models.length > 0) {
        ms.cursor = (ms.cursor - 1 + ms.models.length) % ms.models.length;
      }
      tuiState.dirty.add('all');
      scheduler.schedule();
      return;
    }
    if (key.name === 'down') {
      if (ms.models.length > 0) {
        ms.cursor = (ms.cursor + 1) % ms.models.length;
      }
      tuiState.dirty.add('all');
      scheduler.schedule();
      return;
    }
    if (key.ch >= '1' && key.ch <= '9') {
      const idx = parseInt(key.ch, 10) - 1;
      await selectModelFromPicker(idx);
      return;
    }
    if (key.name === 'return') {
      await selectModelFromPicker(ms.cursor);
      return;
    }
  }

  /** Handle /model [name|#] command. */
  async function handleModelCommand(arg) {
    if (!arg) {
      await openModelPicker();
      return;
    }

    // Switching: need the model list for numeric resolution
    const { models } = await fetchModels(ctx.providerConfig, ctx.apiKey);

    // Resolve by number or name
    let target;
    if (/^\d+$/.test(arg)) {
      const num = parseInt(arg, 10);
      if (num < 1 || num > models.length) {
        addTranscriptEntry(tuiState, 'error', `Model index out of range: ${num}`);
        scheduler.flush();
        return;
      }
      target = models[num - 1];
    } else {
      target = arg;
    }

    await switchModel(target);
  }

  /** Handle /provider [name|#] command. */
  async function handleProviderCommand(arg) {
    const providers = getProviderList();

    if (!arg) {
      openProviderSwitcher();
      return;
    }

    // Resolve by number or name
    let target;
    if (/^\d+$/.test(arg)) {
      const num = parseInt(arg, 10);
      target = (num >= 1 && num <= providers.length) ? providers[num - 1] : null;
    } else {
      target = providers.find(p => p.id === arg.toLowerCase());
    }

    if (!target) {
      addTranscriptEntry(tuiState, 'error', `Unknown provider: ${arg}`);
      scheduler.flush();
      return;
    }

    await switchProvider(providers.indexOf(target));
  }

  /** Handle /config [subcommand] [args]. */
  async function handleConfigCommand(arg) {
    if (!arg) {
      openConfigModal();
      return;
    }

    const parts = arg.split(/\s+/);
    const sub = parts[0];

    if (sub === 'key') {
      if (parts.length < 2) {
        addTranscriptEntry(tuiState, 'warning', 'Usage: /config key <secret> or /config key <provider> <secret>');
        scheduler.flush();
        return;
      }

      let targetId, secret;
      if (parts.length === 2) {
        // /config key <secret> — set for current provider
        targetId = ctx.providerConfig.id;
        secret = parts[1];
      } else {
        // /config key <provider> <secret>
        targetId = parts[1].toLowerCase();
        secret = parts[2];
      }

      if (!PROVIDER_CONFIGS[targetId]) {
        addTranscriptEntry(tuiState, 'error', `Unknown provider: ${targetId}`);
        scheduler.flush();
        return;
      }

      // Persist to config
      if (!config[targetId]) config[targetId] = {};
      config[targetId].apiKey = secret;
      await saveConfig(config);

      // Set env var so resolveApiKey() picks it up
      const envKey = `PUSH_${targetId.toUpperCase()}_API_KEY`;
      process.env[envKey] = secret;

      // Hot-reload running session if setting for current provider
      if (targetId === ctx.providerConfig.id) {
        ctx.apiKey = secret;
      }

      addTranscriptEntry(tuiState, 'status', `API key saved for ${targetId} (${maskSecret(secret)})`);
      scheduler.flush();
      return;
    }

    if (sub === 'url') {
      if (parts.length < 2) {
        addTranscriptEntry(tuiState, 'warning', 'Usage: /config url <url>');
        scheduler.flush();
        return;
      }

      const url = parts[1];
      const targetId = ctx.providerConfig.id;

      if (!config[targetId]) config[targetId] = {};
      config[targetId].url = url;
      await saveConfig(config);

      const envKey = `PUSH_${targetId.toUpperCase()}_URL`;
      process.env[envKey] = url;

      addTranscriptEntry(tuiState, 'status', `Endpoint URL saved for ${targetId}: ${url}`);
      scheduler.flush();
      return;
    }

    if (sub === 'tavily') {
      if (parts.length < 2) {
        addTranscriptEntry(tuiState, 'warning', 'Usage: /config tavily <secret>');
        scheduler.flush();
        return;
      }

      const secret = parts[1];
      config.tavilyApiKey = secret;
      await saveConfig(config);
      process.env.PUSH_TAVILY_API_KEY = secret;

      addTranscriptEntry(tuiState, 'status', `Tavily API key saved (${maskSecret(secret)})`);
      scheduler.flush();
      return;
    }

    if (sub === 'sandbox') {
      if (parts.length < 2 || (parts[1] !== 'on' && parts[1] !== 'off')) {
        addTranscriptEntry(tuiState, 'warning', 'Usage: /config sandbox on|off');
        scheduler.flush();
        return;
      }

      const enabled = parts[1] === 'on';
      config.localSandbox = enabled;
      await saveConfig(config);
      process.env.PUSH_LOCAL_SANDBOX = String(enabled);

      addTranscriptEntry(tuiState, 'status', `Local sandbox: ${enabled ? 'on' : 'off'}`);
      scheduler.flush();
      return;
    }

    addTranscriptEntry(tuiState, 'warning', `Unknown config subcommand: ${sub}. Try: key, url, tavily, sandbox`);
    scheduler.flush();
  }

  /** Dispatch slash commands. Returns true if handled. */
  async function handleSlashCommand(text) {
    if (!text.startsWith('/')) return false;

    const spaceIdx = text.indexOf(' ');
    const cmd = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx);
    const arg = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

    switch (cmd) {
      case 'exit':
      case 'quit':
        exitResolve();
        return true;

      case 'config':
        await handleConfigCommand(arg || null);
        return true;

      case 'help':
        addTranscriptEntry(tuiState, 'status', [
          'Commands:',
          '  /new                 Start a new session (same provider/model/cwd)',
          '  /model               Open navigable model picker',
          '  /model <name|#>      Switch model',
          '  /provider            Open navigable provider picker',
          '  /provider <name|#>   Switch provider',
          '  /config              Show config overview (keys masked)',
          '  /config key <secret> Set API key for current provider',
          '  /config url <url>    Set endpoint URL for current provider',
          '  /config tavily <key> Set Tavily web search API key',
          '  /config sandbox on|off  Toggle local Docker sandbox',
          '  /skills              List available skills',
          '  /skills reload       Reload workspace + Claude skills',
          `  /compact [turns]      Compact older context (default keep ${DEFAULT_COMPACT_TURNS} turns)`,
          '  /<skill> [args]      Run a skill (e.g. /commit, /review)',
          '  /resume              Open resumable session picker',
          '  /resume <session-id> Switch to a saved session',
          '  @path[:line[-end]]   Preload file refs into context',
          '  /session             Print session id',
          '  /session rename <name>  Rename current session (--clear to unset)',
          '  /exit                Exit TUI',
          '',
          'Keybinds:',
          '  Enter         Send message',
          '  Alt+Enter     New line in composer',
          '  Up/Down       Input history (single-line)',
          '  Ctrl+A/E      Start/end of line',
          '  Ctrl+U        Kill to line start',
          '  Ctrl+K        Kill to line end',
          '  Ctrl+W        Kill word backward',
          '  Ctrl+D        Delete forward / exit when empty',
          '  Ctrl+Left/Right  Word navigation',
          '  PageUp/Down   Scroll transcript',
          '  Ctrl+L        Clear viewport (preserves history)',
          '  Ctrl+T        Toggle tool pane',
          '  Ctrl+G        Toggle reasoning pane',
          '  Ctrl+C        Cancel run / exit',
          '  Ctrl+Y        Approve',
          '  Ctrl+N        Deny',
          '  Ctrl+P        Provider switcher',
        ].join('\n'));
        scheduler.flush();
        return true;

      case 'new':
        await startNewSession();
        return true;

      case 'session':
        if (!arg) {
          const nameSuffix = state.sessionName ? ` (${JSON.stringify(state.sessionName)})` : '';
          addTranscriptEntry(tuiState, 'status', `session: ${state.sessionId}${nameSuffix}`);
          scheduler.flush();
          return true;
        }
        if (arg === 'rename' || arg.startsWith('rename ')) {
          await renameCurrentSession(arg.slice('rename'.length));
          return true;
        }
        addTranscriptEntry(tuiState, 'warning', 'Usage: /session | /session rename <name> | /session rename --clear');
        scheduler.flush();
        return true;

      case 'resume':
        if (!arg) {
          await openResumeModal();
          return true;
        }
        if (!/^sess_[a-z0-9]+_[a-f0-9]{6}$/.test(arg)) {
          addTranscriptEntry(tuiState, 'warning', 'Usage: /resume | /resume <session-id>');
          scheduler.flush();
          return true;
        }
        await switchToSessionById(arg, { closePicker: false });
        return true;

      case 'model':
        await handleModelCommand(arg || null);
        return true;

      case 'provider':
        await handleProviderCommand(arg || null);
        return true;

      case 'skills':
        if (arg === 'reload') {
          const count = await reloadSkillsMap();
          addTranscriptEntry(tuiState, 'status', `Reloaded skills: ${count}`);
          scheduler.flush();
          return true;
        }
        if (arg) {
          addTranscriptEntry(tuiState, 'warning', 'Usage: /skills | /skills reload');
          scheduler.flush();
          return true;
        }
        if (skills.size === 0) {
          addTranscriptEntry(tuiState, 'status', 'No skills loaded.');
        } else {
          const lines = [];
          for (const [name, skill] of skills) {
            const tag = skill.source === 'workspace'
              ? ' (workspace)'
              : skill.source === 'claude'
                ? ' (claude)'
                : '';
            lines.push(`  /${name}  ${skill.description}${tag}`);
          }
          addTranscriptEntry(tuiState, 'status', lines.join('\n'));
        }
        scheduler.flush();
        return true;

      case 'compact':
        await compactSessionContext(arg || null);
        return true;

      default: {
        // Check if it's a skill name
        const skill = skills.get(cmd);
        if (skill) {
          const promptTemplate = await getSkillPromptTemplate(skill);
          const prompt = interpolateSkill(promptTemplate, arg);
          addTranscriptEntry(tuiState, 'user', text);
          composer.clear();
          tuiState.dirty.add('all');
          await ensureSessionPersisted();
          await appendSessionEvent(state, 'user_message', { chars: prompt.length, preview: prompt.slice(0, 280), skill: cmd });
          await runPrompt(prompt, { referenceSourceText: arg });
          return true;
        }

        addTranscriptEntry(tuiState, 'warning', `Unknown command: /${cmd}. Type /help for commands.`);
        scheduler.flush();
        return true;
      }
    }
  }

  async function sendMessage() {
    const text = composer.getText().trim();
    if (!text || tuiState.runState !== 'idle') return;

    inputHistory.push(text);
    inputHistory.reset();

    // Slash command dispatch
    if (text.startsWith('/')) {
      composer.clear();
      tuiState.dirty.add('composer');
      const handled = await handleSlashCommand(text);
      if (handled) return;
    }

    addTranscriptEntry(tuiState, 'user', text);
    composer.clear();
    tuiState.dirty.add('all');
    await runPrompt(text);
  }

  function cancelRun() {
    if (runAbort) {
      runAbort.abort();
      addTranscriptEntry(tuiState, 'status', 'Run cancelled.');
    }
  }

  function approveAction() {
    if (approvalResolve) {
      approvalResolve(true);
      approvalResolve = null;
      tuiState.approval = null;
      tuiState.runState = 'running';
      tuiState.dirty.add('all');
      scheduler.schedule();
    }
  }

  function alwaysApproveAction() {
    if (approvalResolve) {
      const patIdx = tuiState.approval?.patternIndex;
      if (typeof patIdx === 'number' && patIdx >= 0) {
        trustedPatterns.add(patIdx);
        addTranscriptEntry(tuiState, 'status', '[trusted for session]');
      }
      approvalResolve(true);
      approvalResolve = null;
      tuiState.approval = null;
      tuiState.runState = 'running';
      tuiState.dirty.add('all');
      scheduler.schedule();
    }
  }

  function denyAction() {
    if (approvalResolve) {
      approvalResolve(false);
      approvalResolve = null;
      tuiState.approval = null;
      tuiState.runState = 'running';
      tuiState.dirty.add('all');
      scheduler.schedule();
    }
  }

  /** Dedicated input handler for the approval modal — bare keys, no keybind map. */
  function handleApprovalModalInput(key) {
    if (key.name === 'y' && !key.ctrl && !key.meta) {
      approveAction();
      return;
    }
    if (key.name === 'a' && !key.ctrl && !key.meta) {
      alwaysApproveAction();
      return;
    }
    if (key.name === 'n' && !key.ctrl && !key.meta) {
      denyAction();
      return;
    }
    if (key.name === 'escape') {
      denyAction();
      return;
    }
    // Ctrl+Y and Ctrl+N still work (from keybind map fallthrough)
    if (key.ctrl && key.name === 'y') {
      approveAction();
      return;
    }
    if (key.ctrl && key.name === 'n') {
      denyAction();
      return;
    }
  }

  function toggleTools() {
    tuiState.toolPaneOpen = !tuiState.toolPaneOpen;
    tuiState.dirty.add('all');
    scheduler.flush();
  }

  function toggleReasoningModal() {
    tuiState.reasoningModalOpen = !tuiState.reasoningModalOpen;
    tuiState.dirty.add('all');
    scheduler.flush();
  }

  function handleReasoningModalInput(key) {
    if (key.name === 'escape' || (key.ctrl && key.name === 'g')) {
      toggleReasoningModal();
    }
  }

  function clearViewport() {
    process.stdout.write(ESC.clearScreen);
    tuiState.dirty.add('all');
    scheduler.flush();
  }

  function openProviderSwitcher() {
    const providers = getProviderList();
    const currentIndex = providers.findIndex((p) => p.id === state.provider);
    tuiState.providerModalCursor = currentIndex >= 0 ? currentIndex : 0;
    tuiState.providerModalOpen = true;
    tuiState.dirty.add('all');
    scheduler.flush();
  }

  function closeModal() {
    if (tuiState.configModalOpen) {
      closeConfigModal();
      return;
    }
    if (tuiState.reasoningModalOpen) {
      tuiState.reasoningModalOpen = false;
      tuiState.dirty.add('all');
      scheduler.flush();
      return;
    }
    if (tuiState.modelModalOpen) {
      closeModelModal();
      return;
    }
    if (tuiState.providerModalOpen) {
      tuiState.providerModalOpen = false;
      tuiState.providerModalCursor = 0;
      tuiState.dirty.add('all');
      scheduler.flush();
      return;
    }
    if (tuiState.resumeModalOpen) {
      tuiState.resumeModalOpen = false;
      tuiState.resumeModalState = null;
      tuiState.dirty.add('all');
      scheduler.flush();
      return;
    }
    if (tuiState.runState === 'awaiting_approval' && approvalResolve) {
      // Esc on approval = deny
      denyAction();
    }
  }

  async function switchProvider(index) {
    const providers = getProviderList();
    if (index < 0 || index >= providers.length) return;
    const target = providers[index];
    let newApiKey;
    try {
      newApiKey = resolveApiKey(PROVIDER_CONFIGS[target.id]);
    } catch {
      addTranscriptEntry(tuiState, 'error', `Cannot switch to ${target.id}: no API key.`);
      return;
    }

    const newConfig = PROVIDER_CONFIGS[target.id];

    ctx.providerConfig = newConfig;
    ctx.apiKey = newApiKey;
    state.provider = target.id;
    state.model = config[target.id]?.model || newConfig.defaultModel;

    // Persist current default provider (matches classic REPL behavior).
    config.provider = target.id;
    await saveConfig(config);
    await saveSessionState(state);
    addTranscriptEntry(tuiState, 'status', `Switched to ${target.id} | model: ${state.model}`);
    tuiState.providerModalOpen = false;
    tuiState.providerModalCursor = index;
    tuiState.modelModalOpen = false;
    tuiState.modelModalState = null;
    tuiState.dirty.add('all');
    scheduler.flush();
  }

  async function handleProviderModalInput(key) {
    const providers = getProviderList();
    if (providers.length === 0) return;

    if (key.name === 'escape') {
      closeModal();
      return;
    }
    if (key.name === 'up') {
      tuiState.providerModalCursor = (tuiState.providerModalCursor - 1 + providers.length) % providers.length;
      tuiState.dirty.add('all');
      scheduler.schedule();
      return;
    }
    if (key.name === 'down') {
      tuiState.providerModalCursor = (tuiState.providerModalCursor + 1) % providers.length;
      tuiState.dirty.add('all');
      scheduler.schedule();
      return;
    }
    if (key.ch >= '1' && key.ch <= '9') {
      const idx = parseInt(key.ch, 10) - 1;
      if (idx >= 0 && idx < providers.length) {
        await switchProvider(idx);
      }
      return;
    }
    if (key.name === 'return') {
      await switchProvider(tuiState.providerModalCursor);
      return;
    }
  }

  // ── Config modal lifecycle ────────────────────────────────────────

  function openConfigModal() {
    tuiState.configModalOpen = true;
    tuiState.configModalState = { mode: 'list', cursor: 0, editTarget: '', editBuf: '', editCursor: 0, pickCursor: 0 };
    tuiState.dirty.add('all');
    scheduler.flush();
  }

  function closeConfigModal() {
    tuiState.configModalOpen = false;
    tuiState.configModalState = null;
    tuiState.dirty.add('all');
    scheduler.flush();
  }

  /** Total config items: 6 providers + tavily + sandbox + execMode = 9. */
  const CONFIG_ITEM_COUNT = 9;

  async function handleConfigModalInput(key) {
    const ms = tuiState.configModalState;
    if (!ms) return;

    if (ms.mode === 'list') {
      // ── List mode input ──
      if (key.name === 'escape') {
        closeConfigModal();
        return;
      }
      if (key.name === 'up') {
        ms.cursor = (ms.cursor - 1 + CONFIG_ITEM_COUNT) % CONFIG_ITEM_COUNT;
        tuiState.dirty.add('all');
        scheduler.schedule();
        return;
      }
      if (key.name === 'down') {
        ms.cursor = (ms.cursor + 1) % CONFIG_ITEM_COUNT;
        tuiState.dirty.add('all');
        scheduler.schedule();
        return;
      }
      // Number keys 1–9: jump + activate
      if (key.ch >= '1' && key.ch <= '9') {
        ms.cursor = parseInt(key.ch, 10) - 1;
        await activateConfigItem(ms.cursor);
        return;
      }
      if (key.name === 'return') {
        await activateConfigItem(ms.cursor);
        return;
      }
      return;
    }

    if (ms.mode === 'edit') {
      // ── Edit mode input ──
      if (key.name === 'escape') {
        // Discard, back to list
        ms.mode = 'list';
        ms.editBuf = '';
        ms.editCursor = 0;
        tuiState.dirty.add('all');
        scheduler.schedule();
        return;
      }
      if (key.name === 'return') {
        // Save if non-empty, then return to list
        if (ms.editBuf) {
          await saveConfigKey(ms.editTarget, ms.editBuf);
        }
        ms.mode = 'list';
        ms.editBuf = '';
        ms.editCursor = 0;
        tuiState.dirty.add('all');
        scheduler.flush();
        return;
      }
      if (key.name === 'backspace') {
        if (ms.editCursor > 0) {
          ms.editBuf = ms.editBuf.slice(0, ms.editCursor - 1) + ms.editBuf.slice(ms.editCursor);
          ms.editCursor--;
        }
        tuiState.dirty.add('all');
        scheduler.schedule();
        return;
      }
      if (key.name === 'left') {
        if (ms.editCursor > 0) ms.editCursor--;
        tuiState.dirty.add('all');
        scheduler.schedule();
        return;
      }
      if (key.name === 'right') {
        if (ms.editCursor < ms.editBuf.length) ms.editCursor++;
        tuiState.dirty.add('all');
        scheduler.schedule();
        return;
      }
      // Printable characters
      if (key.ch && !key.ctrl && !key.meta) {
        ms.editBuf = ms.editBuf.slice(0, ms.editCursor) + key.ch + ms.editBuf.slice(ms.editCursor);
        ms.editCursor += key.ch.length;
        tuiState.dirty.add('all');
        scheduler.schedule();
        return;
      }
      return;
    }

    if (ms.mode === 'pick') {
      // ── Pick mode input (exec mode selection) ──
      const EXEC_MODES = ['strict', 'auto', 'yolo'];
      if (key.name === 'escape') {
        ms.mode = 'list';
        tuiState.dirty.add('all');
        scheduler.schedule();
        return;
      }
      if (key.name === 'up') {
        ms.pickCursor = (ms.pickCursor - 1 + EXEC_MODES.length) % EXEC_MODES.length;
        tuiState.dirty.add('all');
        scheduler.schedule();
        return;
      }
      if (key.name === 'down') {
        ms.pickCursor = (ms.pickCursor + 1) % EXEC_MODES.length;
        tuiState.dirty.add('all');
        scheduler.schedule();
        return;
      }
      if (key.name === 'return') {
        const chosen = EXEC_MODES[ms.pickCursor];
        config.execMode = chosen;
        await saveConfig(config);
        process.env.PUSH_EXEC_MODE = chosen;
        ms.mode = 'list';
        tuiState.dirty.add('all');
        scheduler.flush();
        return;
      }
      return;
    }
  }

  async function activateConfigItem(index) {
    const ms = tuiState.configModalState;
    const providers = getProviderList();
    if (index < providers.length) {
      // Provider → enter edit mode
      ms.mode = 'edit';
      ms.editTarget = providers[index].id;
      ms.editBuf = '';
      ms.editCursor = 0;
    } else if (index === providers.length) {
      // Tavily → enter edit mode
      ms.mode = 'edit';
      ms.editTarget = 'tavily';
      ms.editBuf = '';
      ms.editCursor = 0;
    } else if (index === providers.length + 1) {
      // Sandbox → toggle directly
      const current = process.env.PUSH_LOCAL_SANDBOX || (config.localSandbox !== undefined ? String(config.localSandbox) : 'off');
      const isOn = current === 'true' || current === '1';
      config.localSandbox = !isOn;
      await saveConfig(config);
      process.env.PUSH_LOCAL_SANDBOX = String(!isOn);
    } else if (index === providers.length + 2) {
      // ExecMode → enter pick mode
      const EXEC_MODES = ['strict', 'auto', 'yolo'];
      const current = process.env.PUSH_EXEC_MODE || config.execMode || 'auto';
      ms.mode = 'pick';
      ms.pickCursor = Math.max(0, EXEC_MODES.indexOf(current));
    }
    tuiState.dirty.add('all');
    scheduler.flush();
  }

  async function saveConfigKey(targetId, secret) {
    if (targetId === 'tavily') {
      config.tavilyApiKey = secret;
      await saveConfig(config);
      process.env.PUSH_TAVILY_API_KEY = secret;
      return;
    }

    // Provider API key
    if (!PROVIDER_CONFIGS[targetId]) return;
    if (!config[targetId]) config[targetId] = {};
    config[targetId].apiKey = secret;
    await saveConfig(config);

    const envKey = `PUSH_${targetId.toUpperCase()}_API_KEY`;
    process.env[envKey] = secret;

    // Hot-reload running session if setting for current provider
    if (targetId === ctx.providerConfig.id) {
      ctx.apiKey = secret;
    }
  }

  // ── Exit promise ─────────────────────────────────────────────────

  let exitResolve;
  const exitPromise = new Promise((resolve) => { exitResolve = resolve; });

  // ── Bracketed paste state ────────────────────────────────────────

  const PASTE_START = '\x1b[200~';
  const PASTE_END   = '\x1b[201~';
  let pasteMode = false;
  let pasteBuf = '';

  // Stream-safe decoding: StringDecoder holds incomplete UTF-8 byte
  // sequences across data events (prevents replacement characters for
  // CJK/emoji split across chunks). pendingInput holds character strings
  // that might be partial paste markers at chunk boundaries.
  const utf8Decoder = new StringDecoder('utf8');
  let pendingInput = '';

  /**
   * Check if str ends with a proper prefix of marker.
   * Returns the length of the matching suffix, or 0.
   */
  function partialMarkerSuffix(str, marker) {
    const maxLen = Math.min(str.length, marker.length - 1);
    for (let len = maxLen; len >= 1; len--) {
      if (str.endsWith(marker.slice(0, len))) {
        return len;
      }
    }
    return 0;
  }

  function insertPastedText(text) {
    if (!text) return;

    // Config edit mode is a single-line secret input; paste should target the
    // modal buffer instead of the main composer, and newlines should be dropped.
    if (tuiState.configModalOpen && tuiState.configModalState?.mode === 'edit') {
      const ms = tuiState.configModalState;
      const normalized = text.replace(/\r\n/g, '\n').replace(/[\r\n]/g, '');
      if (!normalized) return;
      ms.editBuf = ms.editBuf.slice(0, ms.editCursor) + normalized + ms.editBuf.slice(ms.editCursor);
      ms.editCursor += normalized.length;
      tuiState.dirty.add('all');
      scheduler.schedule();
      return;
    }

    // Resume modal rename mode is also a single-line text input.
    if (tuiState.resumeModalOpen && tuiState.resumeModalState?.mode === 'rename') {
      const ms = tuiState.resumeModalState;
      const normalized = text.replace(/\r\n/g, '\n').replace(/[\r\n]/g, '');
      if (!normalized) return;
      ms.renameBuf = ms.renameBuf.slice(0, ms.renameCursor) + normalized + ms.renameBuf.slice(ms.renameCursor);
      ms.renameCursor += normalized.length;
      tuiState.dirty.add('all');
      scheduler.schedule();
      return;
    }

    // For non-text modals, ignore paste rather than mutating the hidden composer.
    if (
      tuiState.configModalOpen ||
      tuiState.reasoningModalOpen ||
      tuiState.modelModalOpen ||
      tuiState.providerModalOpen ||
      tuiState.resumeModalOpen ||
      (tuiState.runState === 'awaiting_approval' && tuiState.approval)
    ) {
      return;
    }

    tabCompleter.reset();
    composer.insertText(text);
    tuiState.dirty.add('composer');
    scheduler.schedule();
  }

  // ── Input handler ────────────────────────────────────────────────

  function onData(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const decoded = utf8Decoder.write(buf);
    if (!decoded) return; // Incomplete UTF-8 sequence, wait for more bytes
    const str = pendingInput + decoded;
    pendingInput = '';
    processInput(str);
  }

  function processInput(str) {
    // ── Bracketed paste handling (before parseKey) ──
    if (pasteMode) {
      const endIdx = str.indexOf(PASTE_END);
      if (endIdx === -1) {
        // No end marker found. Hold a potential partial marker at the tail
        // so we can match it if the rest arrives in the next chunk.
        const held = partialMarkerSuffix(str, PASTE_END);
        if (held > 0) {
          pasteBuf += str.slice(0, -held);
          pendingInput = str.slice(-held);
        } else {
          pasteBuf += str;
        }
        return;
      }
      // End of paste
      pasteBuf += str.slice(0, endIdx);
      insertPastedText(pasteBuf);
      pasteBuf = '';
      pasteMode = false;
      // Process any data after the paste end marker
      const after = str.slice(endIdx + PASTE_END.length);
      if (after.length > 0) processInput(after);
      return;
    }

    // Check for paste start marker (may appear mid-chunk)
    const startIdx = str.indexOf(PASTE_START);
    if (startIdx !== -1) {
      // Process data before paste marker
      const before = str.slice(0, startIdx);
      if (before.length > 0) processInput(before);
      // Enter paste mode
      pasteMode = true;
      pasteBuf = '';
      // Process data after paste start marker (may contain paste end too)
      const after = str.slice(startIdx + PASTE_START.length);
      if (after.length > 0) processInput(after);
      return;
    }

    // Normal key input
    const keyBuf = Buffer.from(str);
    const key = parseKey(keyBuf);

    // Approval modal: dedicated handler with bare y/a/n keys
    if (tuiState.runState === 'awaiting_approval' && tuiState.approval) {
      handleApprovalModalInput(key);
      return;
    }

    // Ask-user modal: captures typed text
    if (tuiState.runState === 'awaiting_user_question' && tuiState.userQuestion) {
      handleQuestionInput(key);
      return;
    }

    // Config modal: swallow all keys
    if (tuiState.configModalOpen) {
      runAsync(() => handleConfigModalInput(key), 'config input failed');
      return;
    }

    if (tuiState.reasoningModalOpen) {
      handleReasoningModalInput(key);
      return;
    }

    // Model modal: navigable list
    if (tuiState.modelModalOpen) {
      runAsync(() => handleModelModalInput(key), 'model picker input failed');
      return;
    }

    // Provider modal: navigable list + number quick-pick
    if (tuiState.providerModalOpen) {
      runAsync(() => handleProviderModalInput(key), 'provider switch failed');
      return;
    }
    if (tuiState.resumeModalOpen) {
      runAsync(() => handleResumeModalInput(key), 'resume picker input failed');
      return;
    }

    // Tab completion — intercept before keybind map
    if (key.name === 'tab' && tuiState.runState === 'idle') {
      const result = tabCompleter.tab(composer.getText(), key.shift);
      if (result) {
        composer.setText(result.text);
        tuiState.dirty.add('composer');
        scheduler.schedule();
      }
      return;
    }

    // Reset tab completion on any non-Tab keystroke
    if (key.name !== 'tab') {
      tabCompleter.reset();
    }

    // Check keybinds
    const action = keybinds.lookup(key);

    switch (action) {
      case 'send':
        runAsync(() => sendMessage(), 'send failed');
        return;
      case 'newline':
        composer.insertNewline();
        tuiState.dirty.add('composer');
        scheduler.schedule();
        return;
      case 'cancel_or_exit':
        if (tuiState.runState === 'running') {
          cancelRun();
        } else {
          exitResolve();
        }
        return;
      case 'toggle_tools':
        toggleTools();
        return;
      case 'toggle_reasoning':
        toggleReasoningModal();
        return;
      case 'clear_viewport':
        clearViewport();
        return;
      case 'reattach':
        // Phase 1: no-op placeholder for Ctrl+R
        addTranscriptEntry(tuiState, 'status', 'Re-attach not yet implemented.');
        scheduler.schedule();
        return;
      case 'approve':
        approveAction();
        return;
      case 'deny':
        denyAction();
        return;
      case 'provider_switcher':
        openProviderSwitcher();
        return;
      case 'close_modal':
        closeModal();
        return;
      case 'line_start':
        composer.moveHome();
        tuiState.dirty.add('composer');
        scheduler.schedule();
        return;
      case 'line_end':
        composer.moveEnd();
        tuiState.dirty.add('composer');
        scheduler.schedule();
        return;
      case 'kill_line_backward':
        composer.killLineBackward();
        tuiState.dirty.add('composer');
        scheduler.schedule();
        return;
      case 'kill_line_forward':
        composer.killLineForward();
        tuiState.dirty.add('composer');
        scheduler.schedule();
        return;
      case 'kill_word_backward':
        composer.killWordBackward();
        tuiState.dirty.add('composer');
        scheduler.schedule();
        return;
      case 'delete_or_exit':
        if (composer.isEmpty() && tuiState.runState === 'idle') {
          exitResolve();
        } else {
          composer.deleteForward();
          tuiState.dirty.add('composer');
          scheduler.schedule();
        }
        return;
      case 'word_left':
        composer.moveWordLeft();
        tuiState.dirty.add('composer');
        scheduler.schedule();
        return;
      case 'word_right':
        composer.moveWordRight();
        tuiState.dirty.add('composer');
        scheduler.schedule();
        return;
      case 'scroll_up': {
        const { rows } = getTermSize();
        const step = Math.max(1, Math.floor(rows / 3));
        tuiState.scrollOffset += step;
        tuiState.dirty.add('transcript');
        scheduler.schedule();
        return;
      }
      case 'scroll_down': {
        const { rows } = getTermSize();
        const step = Math.max(1, Math.floor(rows / 3));
        tuiState.scrollOffset = Math.max(0, tuiState.scrollOffset - step);
        tuiState.dirty.add('transcript');
        scheduler.schedule();
        return;
      }
    }

    // If idle and it's a printable char, feed to composer
    if (key.ch && !key.ctrl && !key.meta) {
      composer.insertChar(key.ch);
      tuiState.dirty.add('composer');
      scheduler.schedule();
      return;
    }

    // Editing keys (not bound to actions)
    if (key.name === 'backspace') {
      composer.backspace();
      tuiState.dirty.add('composer');
      scheduler.schedule();
      return;
    }
    if (key.name === 'delete') {
      composer.deleteForward();
      tuiState.dirty.add('composer');
      scheduler.schedule();
      return;
    }
    if (key.name === 'left') {
      composer.moveLeft();
      tuiState.dirty.add('composer');
      scheduler.schedule();
      return;
    }
    if (key.name === 'right') {
      composer.moveRight();
      tuiState.dirty.add('composer');
      scheduler.schedule();
      return;
    }
    if (key.name === 'up') {
      // Input history: recall older entry when on first line with single-line content
      if (composer.getLines().length === 1 && composer.getCursor().line === 0) {
        const recalled = inputHistory.up(composer.getText());
        if (recalled !== null) {
          composer.setText(recalled);
          tuiState.dirty.add('composer');
          scheduler.schedule();
          return;
        }
      }
      composer.moveUp();
      tuiState.dirty.add('composer');
      scheduler.schedule();
      return;
    }
    if (key.name === 'down') {
      // Input history: recall newer entry when navigating
      if (inputHistory.isNavigating()) {
        const recalled = inputHistory.down(composer.getText());
        if (recalled !== null) {
          composer.setText(recalled);
          tuiState.dirty.add('composer');
          scheduler.schedule();
          return;
        }
      }
      composer.moveDown();
      tuiState.dirty.add('composer');
      scheduler.schedule();
      return;
    }
    if (key.name === 'home') {
      composer.moveHome();
      tuiState.dirty.add('composer');
      scheduler.schedule();
      return;
    }
    if (key.name === 'end') {
      composer.moveEnd();
      tuiState.dirty.add('composer');
      scheduler.schedule();
      return;
    }
  }

  process.stdin.on('data', onData);

  // ── Signal handling ─────────────────────────────────────────────

  function dumpSessionTranscript(sessionState) {
    try {
      const messages = sessionState?.messages ?? [];
      const userAndAssistant = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
      if (userAndAssistant.length === 0) return;
      process.stdout.write('\n─── Session transcript ───\n\n');
      for (const msg of userAndAssistant) {
        if (msg.role === 'user') {
          const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          // Skip synthetic system-injected messages (e.g. [SESSION_RESUMED])
          if (text.startsWith('[') && text.includes(']')) continue;
          process.stdout.write(`> ${text.slice(0, 500)}\n\n`);
        } else if (msg.role === 'assistant') {
          const raw = typeof msg.content === 'string' ? msg.content : '';
          // Strip JSON tool call fences, keeping only prose
          const cleaned = raw
            .replace(/```(?:json)?\s*\n?\{[\s\S]*?\}\s*\n?```/g, '')
            .trim();
          if (cleaned) process.stdout.write(`${cleaned.slice(0, 800)}\n\n`);
        }
      }
      process.stdout.write('─────────────────────────\n\n');
    } catch { /* best-effort */ }
  }

  function emergencyCleanup() {
    try {
      if (sessionPersisted) dumpSessionTranscript(state);
    } catch { /* best-effort */ }
    try {
      process.stdout.write(ESC.bracketedPasteOff + ESC.cursorShow + ESC.altScreenOff + ESC.reset);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch { /* best-effort */ }
  }

  function onSignal(sig) {
    emergencyCleanup();
    process.exit(128 + (sig === 'SIGTERM' ? 15 : sig === 'SIGHUP' ? 1 : 2));
  }

  function onUncaughtException(err) {
    emergencyCleanup();
    process.stderr.write(`\nPush TUI fatal: ${err?.message || err}\n`);
    process.exit(1);
  }

  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  process.on('uncaughtException', onUncaughtException);

  // ── Resize handler ───────────────────────────────────────────────

  function onResize() {
    tuiState.dirty.add('all');
    scheduler.flush();
  }
  process.stdout.on('resize', onResize);

  // ── Initial render ───────────────────────────────────────────────

  addTranscriptEntry(tuiState, 'status',
    `Session started. Provider: ${state.provider}, Model: ${state.model}`
  );
  scheduler.flush();

  // ── Wait for exit ────────────────────────────────────────────────

  try {
    await exitPromise;
  } finally {
    // ── Cleanup ──────────────────────────────────────────────────
    scheduler.destroy();
    process.stdin.removeListener('data', onData);
    process.stdout.removeListener('resize', onResize);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGHUP', onSignal);
    process.removeListener('uncaughtException', onUncaughtException);

    if (runAbort) runAbort.abort();

    process.stdout.write(ESC.bracketedPasteOff + ESC.cursorShow + ESC.altScreenOff + ESC.reset);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();

    if (sessionPersisted) {
      dumpSessionTranscript(state);
      await saveSessionState(state);
    }
  }

  return 0;
}
