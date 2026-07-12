# Push CLI TUI Architecture

> **Superseded (archived 2026-07-12).** This document describes the hand-rolled ANSI TUI
> (`cli/tui.ts` + `createScreenBuffer`), which was deleted when the TUI migrated to
> [silvery](https://github.com/beorn/silvery) (PRs #1426–#1430). The live decision record is
> [`docs/decisions/Retained-Mode TUI — MVU + Pure-TS Compositor.md`](../../../decisions/Retained-Mode%20TUI%20—%20MVU%20+%20Pure-TS%20Compositor.md);
> the current module map is in [`cli/architecture.md`](../../../../cli/architecture.md).
> Kept as the record of the architecture silvery replaced and the framework survey lessons
> that led to the contracts silvery was scored against.

This document describes the architecture of the Push CLI's full-screen terminal user interface (TUI), design decisions, and lessons learned from studying other TUI frameworks.

## Overview

The Push TUI is a custom-built, zero-dependency terminal interface implemented in TypeScript. It provides:

- Full-screen alternate buffer interface
- Real-time streaming content display
- Modal dialogs (provider switcher, model picker, resume picker, config editor)
- Keyboard-driven navigation with vim-style keybindings
- Live git status and context tracking
- Payload inspector for tool call inspection
- Dirty-region redraws with full-redraw fallback (resize/overlays)
- Cached, windowed transcript rendering for long sessions

## Design Philosophy

**Purpose-built over general-purpose.** The TUI is tightly coupled to Push's agent workflow rather than being a generic framework. This allows optimizations that would be difficult in a general-purpose library.

**Zero dependencies.** The only dependencies are Node.js built-ins. This eliminates:
- Supply chain risks
- Version compatibility issues
- Bundle size concerns
- Transpilation complexity

**Immediate mode rendering.** The UI is computed from current state each frame (similar to game engines and Ratatui), but practical redraw work is reduced with dirty-region rendering, layout caching, and transcript render caching.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Main Loop (tui.ts)                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │   Input     │→ │   State     │→ │   Render    │→ │   Output    │ │
│  │  Handling   │  │   Update    │  │   Pipeline  │  │   Flush     │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
         ↑                                                    ↓
         └────────────── Terminal (stdin/stdout) ←────────────┘
```

## Module Structure

### Core Modules

| Module | Responsibility | Lines |
|--------|----------------|-------|
| `tui.ts` | Main event loop, state management, modal handling | ~6,000 |
| `tui-renderer.ts` | Screen buffer, layout computation, ANSI escapes | ~710 |
| `tui-theme.ts` | Color tier detection, design tokens, styling | ~540 |
| `tui-input.ts` | Key parsing, input history, text composer | ~770 |
| `tui-status.ts` | Git status, token estimation, status bar | ~480 |
| `tui-fuzzy.ts` | Fuzzy filtering for session picker | ~210 |
| `tui-modal-input.ts` | Reusable modal list navigation + single-line edit helpers | ~200 |
| `tui-widgets.ts` | Composable modal box + list-window render helpers | ~130 |
| `tui-completer.ts` | Tab completion for commands | ~370 |
| `tui-daemon-handshake.ts` | `hello`-response evaluation + unknown-event triage (pure) | ~230 |
| `tui-daemon-reconnect.ts` | Reconnect state machine + backoff schedule (pure) | ~150 |
| `tui-daemon-errors.ts` | Spawn/crash error classification + log-tail formatter | ~270 |

### Data Flow

```
User Input
    ↓
parseKey() → Key object
    ↓
Mode router (modal? approval? normal?)
    ↓
State update (tuiState, session state)
    ↓
Scheduler.schedule() (throttled render)
    ↓
Render pipeline
    ↓
screenBuf.flush() (batched stdout write)
```

## Key Patterns

### 1. Event-Driven State Management

The TUI uses a message-passing pattern similar to Bubble Tea's Elm Architecture, adapted for JavaScript:

```javascript
// Engine events flow into the UI
function handleEngineEvent(event) {
    switch (event.type) {
        case 'assistant_token':
            tuiState.streamBuf += event.payload.text;
            tuiState.dirty.add('transcript');
            scheduler.schedule();
            break;
        case 'tool_result':
            addToolFeedEntry(tuiState, {...});
            // Refresh git status after file operations
            if (['write_file', 'edit_file', 'git_commit'].includes(event.payload.toolName)) {
                setTimeout(() => refreshGitStatus(), 300);
            }
            break;
    }
}
```

**Benefits:**
- Decouples engine from UI
- Easy to add new event types
- Event log can be replayed for debugging

### 2. Dirty Tracking & Selective Rendering

The TUI tracks which regions changed and only redraws those panes when possible, with a full-redraw fallback for resize/layout changes and modal overlays:

```javascript
const tuiState = {
    dirty: new Set(['all']),  // 'all', 'transcript', 'composer', 'footer', 'tools'
};

// After state change
tuiState.dirty.add('transcript');
scheduler.schedule();

// Render loop checks dirty flags
function render() {
    const mustFullRedraw = resized || layoutChanged || overlayVisible || tuiState.dirty.has('all');

    if (mustFullRedraw) {
        redrawEverything();
        return;
    }

    if (tuiState.dirty.has('transcript')) {
        renderTranscript(screenBuf, layout, theme, tuiState);
    }
    if (tuiState.dirty.has('composer')) {
        renderComposer(screenBuf, layout, theme, composer, tuiState, tabState);
    }
    if (tuiState.dirty.has('footer')) {
        renderStatusBar(screenBuf, layout, theme, ...);
        renderKeybindHints(screenBuf, layout, theme, tuiState);
    }
}
```

**Benefits:**
- 60fps feel even on slow terminals
- Reduced terminal bandwidth
- Lower CPU usage

### 3. Throttled Render Scheduler

Renders are throttled to ~60fps to prevent excessive terminal writes:

```javascript
const FRAME_MS = 16;

function createRenderScheduler(renderFn) {
    let pending = false;
    
    function schedule() {
        if (pending) return;
        const elapsed = Date.now() - lastRender;
        
        if (elapsed >= FRAME_MS) {
            renderFn();  // Immediate
        } else {
            pending = true;
            setTimeout(() => {
                pending = false;
                renderFn();
            }, FRAME_MS - elapsed);
        }
    }
    
    return { schedule, flush: renderFn };
}
```

### 4. Screen Buffer Abstraction

All output is collected in a buffer and flushed in one write. (This sketch is
illustrative; the real `createScreenBuffer` in `cli/tui-renderer.ts` does
per-cell diffing and accepts an injectable `writeOut` sink — defaulting to
`process.stdout` — so the TUI's headless test harness can capture frames. See
the TUI Decomposition Phase 0 seam.)

```javascript
function createScreenBuffer() {
    let buf = '';
    
    return {
        write: (text) => { buf += text; },
        writeLine: (row, col, text) => {
            buf += ESC.cursorTo(row, col) + text;
        },
        flush: () => {
            if (buf) {
                process.stdout.write(buf);  // Single syscall
                buf = '';
            }
        }
    };
}
```

**Benefits:**
- Eliminates flickering
- Minimizes system calls
- Allows cursor positioning before flush

### 5. Layout Computation

Layouts are computed from terminal size and UI state, and cached when those inputs are unchanged:

```javascript
const layoutKey = `${rows}x${cols}:${toolPaneOpen ? 1 : 0}:${composerLines}`;
let layout = layoutCache?.key === layoutKey ? layoutCache.layout : null;
if (!layout) {
    layout = computeLayout(rows, cols, { toolPaneOpen, composerLines });
    layoutCache = { key: layoutKey, layout };
}
```

**Trade-off:** Simple and predictable, but not as flexible as a constraint-based system (see Lessons from Other Libraries).

### 6. Modal State Machine

Modals are managed with an **incremental overlay modal router**. The current implementation still uses per-modal boolean fields plus modal-specific state objects, but routes render/input through a single overlay selector:

```javascript
function getActiveOverlayModal() {
    if (tuiState.configModalOpen) return 'config';
    if (tuiState.reasoningModalOpen) return 'reasoning';
    if (tuiState.payloadInspectorOpen) return 'payload_inspector';
    if (tuiState.modelModalOpen) return 'model';
    if (tuiState.providerModalOpen) return 'provider';
    if (tuiState.resumeModalOpen) return 'resume';
    return null;
}

switch (getActiveOverlayModal()) {
    case 'config': return handleConfigModalInput(key);
    case 'resume': return handleResumeModalInput(key);
    case 'model': return handleModelModalInput(key);
    // ...
}
```

**Benefits:**
- Centralized modal routing for render + input paths
- Easier to reason about mutual exclusivity
- Incremental path toward a stricter typed modal state machine later

## Component System

While not a full component framework like React/Ink, the TUI has a lightweight widget pattern:

### Widget Interface

```javascript
// A "widget" is a function: (buffer, layout, theme, state) => void
function renderTranscript(buf, layout, theme, tuiState) {
    const { top, left, width, height } = layout.transcript;
    
    // Build visible lines from state
    const visibleLines = buildLines(tuiState.transcript, width);
    
    // Write to buffer
    for (let r = 0; r < height; r++) {
        buf.writeLine(top + r, left, padTo(visibleLines[r] || '', width));
    }
}
```

### Composition Pattern

Widgets compose by calling other widget functions:

```javascript
function render() {
    if (mustFullRedraw) {
        screenBuf.write(theme.bg('bg.base'));
        screenBuf.write(ESC.clearScreen);
        renderHeader(screenBuf, layout, theme, {...});
        renderTranscript(screenBuf, layout, theme, tuiState);
        renderToolPane(screenBuf, layout, theme, tuiState);
        renderComposer(screenBuf, layout, theme, composer, tuiState, tabState);
        renderStatusBar(screenBuf, layout, theme, {...});
        renderKeybindHints(screenBuf, layout, theme, tuiState);
    } else {
        if (tuiState.dirty.has('transcript')) renderTranscript(...);
        if (tuiState.dirty.has('tools')) renderToolPane(...);
        if (tuiState.dirty.has('composer')) renderComposer(...);
        if (tuiState.dirty.has('footer')) {
            renderStatusBar(...);
            renderKeybindHints(...);
        }
    }

    switch (getVisibleOverlayKind()) {
        case 'resume':
            renderResumeModal(screenBuf, theme, rows, cols, ...);
            break;
        // ...
    }
}
```

## Input Handling

### Key Parsing Pipeline

```
Raw bytes (stdin)
    ↓
StringDecoder (handles UTF-8 across chunk boundaries)
    ↓
processInput()
    ↓
Bracketed paste detection (\x1b[200~ ... \x1b[201~])
    ↓
parseKey() → Key object { name, ch, ctrl, meta, sequence }
    ↓
Mode router → Handler
```

### Raw Input Chunk Tokenization

Some terminal/automation layers (including `terminal-mcp` `type(...)`) may write multiple keypresses in a single stdin chunk. The TUI tokenizes raw chunks before `parseKey()` so concatenated printable characters and repeated escape sequences (e.g. multiple arrows) are split into key-sized units.

Important behavior:
- non-escape text is split by Unicode code point
- concatenated CSI/SS3 escape sequences are split into separate key tokens
- incomplete escape sequences are preserved as a single chunk (not over-split)

### Key Object Structure

```javascript
{
    name: 'return' | 'escape' | 'up' | 'ctrl_c' | ...,
    ch: 'a' | '1' | null,
    ctrl: boolean,
    meta: boolean,
    shift: boolean,
    sequence: '\r' | '\x1b[A' | 'a' | ...
}
```

### Contextual Routing

```javascript
function processInput(key) {
    // Approval modal uses bare keys (y/n/a)
    if (tuiState.runState === 'awaiting_approval') {
        return handleApprovalModalInput(key);
    }

    // UI overlay modals route through a central selector
    switch (getActiveOverlayModal()) {
        case 'resume': return handleResumeModalInput(key);
        case 'config': return handleConfigModalInput(key);
        case 'model': return handleModelModalInput(key);
        // ...
    }
    
    // Normal keybind lookup
    const action = keybinds.lookup(key);
    return handleAction(action);
}
```

## Daemon Link

The TUI's default mode is **daemon-attached**: `cli/tui.ts` spawns or connects to `pushd` (the local runtime daemon) and drives the chat round through the `push.runtime.v1` envelope rather than running the engine inline. Inline mode is still the fallback, but daemon-attached is the steady state — and that means the TUI now treats the link itself as a first-class subsystem with three pure helper modules behind it.

### Hello-response evaluation — `tui-daemon-handshake.ts`

The TUI used to treat any successful `hello` reply as proof the link was good. That hid version skew: an upgraded daemon emitting `push.runtime.v2` to an older TUI would connect cleanly and then drop every event into the transcript as "unknown" with no hint why.

`evaluateHelloResponse(payload)` now reads the reply, compares its `protocolVersion` against the shared `PROTOCOL_VERSION` constant imported from `lib/protocol-schema.ts`, and returns a binary discriminated `HandshakeResult`:

- `{ accepted: true; runtimeVersion; capabilities; warnings }` — versions match. The TUI proceeds and dumps any non-fatal entries from `warnings[]` into the transcript (e.g. "daemon did not advertise a runtimeVersion — older binary"). `runtimeVersion` is captured but currently informational only; the TUI does not pin or display it.
- `{ accepted: false; reason }` — covers all hard fails: non-object payload, missing/empty `protocolVersion`, or `protocolVersion` mismatch. The TUI dumps `reason` as a `warning` transcript entry naming both expected and advertised versions, then closes the client instead of silently degrading to inline mode.

The pinned constant lives in `lib/protocol-schema.ts` so the daemon's request gate and the TUI's handshake compare against the same value by construction — bumping the version lifts both sides at once. See PR #665.

A companion helper, `shouldWarnAboutUnknownEvent`, gates the `default:` branch of `handleEngineEvent` so unrecognised event types raise a one-shot transcript warning per distinct type. `TUI_KNOWN_NOOP_EVENT_TYPES` exempts events the TUI deliberately ignores (e.g. `session_started`, `user_message`, engine round-lifecycle markers) — the deliberate friction is the point: silent drops are how protocol drift hides today.

### Reconnect state machine — `tui-daemon-reconnect.ts`

The pre-PR behavior was a one-shot regression: the moment the daemon socket closed, the TUI fell back to inline mode for the rest of the session. Every daemon hiccup looked like a permanent disconnect to the user.

The reconnect coordinator is now a pure state machine that owns *when* the next attempt fires, not the connect itself:

- `RECONNECT_BACKOFF_MS = [1s, 2s, 4s, 8s, 16s, 30s]`, capped at 30s and **retried forever** (the cap matters when the daemon binary has been replaced mid-session and the user is waiting for it to come back).
- `planNextRetry(state, nowMs)` returns the new state and the delay the TUI should arm its `setTimeout` with.
- `recordAttemptResult(state, outcome)` steps the machine forward after the attempt resolves; `secondsUntilNextRetry(state, nowMs)` powers the footer countdown (`reconnect 4s (try 3)`).

Splitting "plan" from "record" keeps the timer out of the pure layer so tests don't need fake timers. The TUI in `cli/tui.ts:attemptDaemonReconnect` wraps the real socket connect + attach around it. See PR #664.

### Spawn/crash error surfacing — `tui-daemon-errors.ts`

Daemon spawn failures used to render as raw `Could not start pushd (${err.message}).` lines, leaving users to crack open `~/.push/run/pushd.log` to diagnose anything.

`classifyDaemonSpawnError(err)` maps a spawn-path exception to `{ code, headline, hint? }`. Currently recognized codes:

| Code | Recognition | Hint |
|---|---|---|
| `EACCES` | errno | chmod ~/.push/run to mode 700 |
| `EADDRINUSE` | errno | socket already bound; check existing pushd or remove stale socket |
| `ENOENT` | errno | path missing; ensure `$HOME` is set and writable |
| `EPERM` | errno | chown ~/.push to current user |
| `EMFILE` | errno | raise `ulimit -n` |
| `TSX_LOADER_MISSING` | message substring | run `npm install` or use the built binary |
| `NODE_OOM` | message substring | raise `--max-old-space-size` |
| `UNKNOWN` | fallback | raw message preserved |

Companion helpers `readPushdLogTail(logPath)` + `formatPushdLogTail(raw)` slice the last ~12 lines of `pushd.log` into a transcript-ready block; the TUI calls them from both spawn-failure and disconnect paths so the user gets PID + exit code + log tail in one frame. The pure layer keeps the unit tests free of process spawning. See PR #667.

### Why these are pure modules

Each of the three helpers is deliberately side-effect-free. The TUI owns the actual socket connect, timer arming, and transcript rendering; the helpers decide *what* to do and *what to render*. This separation is what makes the schema-pin drift-detector tests (`cli/tests/tui-daemon-*.test.mjs` and `cli/tests/protocol-drift.test.mjs`) tractable — they exercise every branch without spawning a daemon or a TTY.

The shared `lib/protocol-schema.ts` is the single source of truth for envelope shape and protocol version; the TUI imports the version constant directly so the handshake gate and the daemon's own request validator can never silently diverge. See `docs/cli/design/Push Runtime Protocol.md` for the wire-level contract.

## Lessons from Other Libraries

### Bubble Tea (Go) - charmbracelet/bubbletea

**What they do well:**
- Formal Elm Architecture (Model, Update, View, Init)
- Type-safe message passing with Go interfaces
- Composable "bubbles" (reusable components)
- Command pattern for async operations

**What we adopted:**
- Event-driven update pattern
- Clear separation of state/render

**What we didn't adopt:**
- Command pattern (async/await is more idiomatic for Node.js)
- Full Elm Architecture (overkill for our scope)

**Implemented after studying Bubble Tea:**
- Incremental modal router (shared overlay selector for render/input)
- More reusable modal/list interaction patterns (shared helpers instead of per-modal key handling)

**Potential improvements:**
- More formalized message types with discriminated unions

### Ink (React) - vadimdemedes/ink

**What they do well:**
- React component model (familiar to many developers)
- Flexbox layout via Yoga engine
- `<Static>` component for persistent content
- Rich hooks API (useInput, useApp, useFocus)

**What we adopted:**
- Concept of hooks (implemented as simple functions)
- Clean input handling API

**What we didn't adopt:**
- React reconciler (too heavy for our needs)
- Yoga/Flexbox (overkill for our fixed layouts)
- JSX (unnecessary abstraction for terminal output)

**Implemented after studying Ink:**
- `<Static>`-like transcript render caching for stable transcript content
- Reusable modal input helpers (single-line editor + list navigation "hook-like" patterns)
- Composable modal widget helpers (centered box + list window helpers)

**Potential improvements:**
- Extract more renderer/state patterns into reusable hook-like helpers if modal complexity grows

### Ratatui (Rust) - ratatui/ratatui

**What they do well:**
- Immediate mode rendering paradigm
- Double buffering with diff rendering
- Cassowary constraint solver for layouts
- Clean widget trait system

**What we adopted:**
- Immediate mode rendering (we already had this independently)
- Screen buffer abstraction
- Widget composition pattern

**What we didn't adopt:**
- Cassowary constraint solver (overkill for our needs)
- Full double buffer diff (we use dirty tracking instead)

**Implemented after studying Ratatui:**
- Layout caching (memoized by terminal size + pane state)
- Windowed transcript assembly over cached entry blocks (virtualized composition)
- Prefix-indexed transcript block line ranges with binary-searched visible block lookup (deeper transcript virtualization step)

**Potential improvements:**
- Consider constraint-based layouts if UI complexity grows
- Lazy line materialization for very large partially visible transcript blocks

## Performance Considerations

### Current Optimizations

1. **Dirty-region redraws** - Partial pane redraws with full-redraw fallback for resize/overlays
2. **Render throttling** - ~60fps cap prevents excessive writes
3. **Screen buffering** - Single stdout.write() per frame
4. **Layout caching** - Reuse computed pane geometry when terminal/layout inputs are unchanged
5. **Transcript render caching** - Cache rendered transcript entry blocks for stable content
6. **Windowed transcript assembly** - Build only the visible transcript window (+ streaming tail) each frame
7. **Indexed transcript block ranges** - Prefix line ranges + binary search to skip scanning all transcript blocks each frame
8. **Transcript capping** - Max 2000 entries to prevent unbounded growth
9. **Tool feed capping** - Max 200 entries

### Potential Future Optimizations

1. **Line-level virtualization**
   - Current: visible window lookup is binary-searched over cached transcript block line ranges
   - Improvement: skip full line materialization for very large partially visible blocks (lazy per-block slices)

2. **Cached modal render buffers**
   - Reuse modal frame rendering for static modal states (e.g., provider list)

3. **Deeper diff rendering**
   - Current: region-level dirty redraw
   - Improvement: line-level diff writes inside panes

## Testing Strategy

The TUI is designed for testability:

### Unit Testing

```javascript
// Test pure functions
const layout = computeLayout(24, 80, { toolPaneOpen: true });
assert.equal(layout.toolPane.width, 28);

// Test widget rendering with mock buffer
const buf = createScreenBuffer();
renderHeader(buf, layout, theme, {...});
assert(buf.getContent().includes('Push'));
```

### Integration Testing

- Test input handling with synthetic key sequences
- Test state transitions (idle → running → approval)
- Test modal workflows
- Test payload inspector interactions (open, navigate, toggle, close)

### Manual Testing

- Different terminal emulators (iTerm2, kitty, Windows Terminal)
- Different color tiers (truecolor, 256, 16, none)
- Resize handling
- Unicode and CJK character handling
- Overlay transitions (approval/question vs UI overlays)

## Future Directions

### Possible Enhancements

1. **Plugin system** - Allow custom widgets via hooks
2. **Theme customization** - User-defined color schemes
3. **Mouse support** - Click to focus, scroll panes
4. **Split panes** - User-resizable regions
5. **Syntax highlighting** - Better code block rendering

### Extraction Criteria

When would we extract this into a library?

1. **Second TUI project** - Copy-paste code indicates reusability
2. **Community demand** - Others asking for the framework
3. **Dedicated maintainer** - Someone to support the open source project

Until then, **keep building Push**. The tight coupling to our workflow is a feature, not a bug.

## References

- **Bubble Tea:** https://github.com/charmbracelet/bubbletea
- **Ink:** https://github.com/vadimdemedes/ink  
- **Ratatui:** https://github.com/ratatui/ratatui
- **Elm Architecture:** https://guide.elm-lang.org/architecture/
- **Cassowary Algorithm:** https://constraints.cs.washington.edu/cassowary/
