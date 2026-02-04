Scratchpad Implementation Plan

Feature: Turn-based collaborative workspace for pasting code, errors, and notes to share with Kimi

Design Principle: Explicit user control. You decide when to share, Kimi can suggest updates, you decide when to accept.


---

Overview

Add a scratchpad button to ChatInput that opens a slide-up panel for drafting content before sharing with Kimi. This replaces the need for real-time collaborative canvases with a simpler, turn-based model that fits mobile UX better.

Invariant: The scratchpad is a draft buffer, not conversation state. Cards are the only canonical shared artifact.

Key Behaviors:

Scratchpad is private until you explicitly share it

Content persists locally across app sessions

Sharing creates a ScratchpadCard in the chat

Kimi can suggest updated versions via scratchpad_suggest tool

You can edit Kimi's suggestions before accepting



---

Architecture

Component Tree

ChatContainer
├── MessageBubble
│   └── ScratchpadCard (read-only display in chat)
├── ChatInput
│   ├── ScratchpadButton (opens panel)
│   └── SendButton
└── ScratchpadPanel (modal overlay)
    ├── ScratchpadEditor (textarea or Monaco)
    ├── ModeSelector (text/code/diagram)
    └── ActionButtons (Send/Cancel/Clear)

State Management

// New hook: useScratchpad.ts
interface ScratchpadState {
  isOpen: boolean;
  content: string;
  mode: 'text' | 'code' | 'diagram';
  syntaxLanguage?: string; // for code mode
  lastEdited: Date;
}

// Persisted to localStorage (web) or Room DB (Android)
const STORAGE_KEY = 'diff-scratchpad-state';

Card Data Type

// Add to types/cards.ts
export interface ScratchpadCard {
  type: 'scratchpad';
  id: string;
  title?: string; // optional label
  content: string;
  mode: 'text' | 'code' | 'diagram';
  syntaxLanguage?: string;
  source: 'user' | 'assistant'; // who created this card
  timestamp: Date;
}


---

Tool Protocol Additions

1. scratchpad_suggest

Kimi uses this to propose updated/fixed versions of content you shared.

{
  "tool": "scratchpad_suggest",
  "title": "Fixed version",
  "content": "corrected code here...",
  "mode": "code",
  "syntax_language": "typescript"
}

Execution:

Client detects tool in LLM response

Creates ScratchpadCard with source: 'assistant'

Renders in chat with "Edit" and "Copy" actions


2. Context Injection (No Tool Needed)

When user shares scratchpad content, inject the immutable card, not the live scratchpad, in the next user message:

[SCRATCHPAD_CARD]
id: <card-id>
version: <v1|v2|v3>
mode: <text|code|diagram>
content: <exact card content>
[/SCRATCHPAD_CARD]

User's question about the content...

Rationale:

Deterministic replay and debugging

No ambiguity if the scratchpad changes after send

Version tagging allows Orchestrator to reason about iteration order


This keeps the protocol simple—no new tool for user sharing, just automatic context wrapping.


---

Component Specifications

ScratchpadButton

Location: ChatInput, left of the SendButton (or as FAB on mobile)

// components/chat/ScratchpadButton.tsx
interface ScratchpadButtonProps {
  onClick: () => void;
  hasContent: boolean; // show indicator dot if scratchpad has content
}

// Icon: clipboard or notepad icon
// Badge: small dot if content exists (visual reminder)
// Touch target: 44px minimum

ScratchpadPanel

Behavior: Modal overlay, slides up from bottom on mobile, centered dialog on desktop

// components/chat/ScratchpadPanel.tsx
interface ScratchpadPanelProps {
  isOpen: boolean;
  content: string;
  mode: 'text' | 'code' | 'diagram';
  onContentChange: (content: string) => void;
  onModeChange: (mode: 'text' | 'code' | 'diagram') => void;
  onSend: () => void;
  onClose: () => void;
  onClear: () => void;
}

// Mobile: slides up from bottom, covers 80% of viewport
// Desktop: centered modal, 60% width, 70% height
// Gesture: swipe down to close (mobile only)
// Keyboard: Cmd+Enter to send, Esc to close

Layout:

┌─────────────────────────────────┐
│ Scratchpad          [Mode ▾]  × │  <- Header
├─────────────────────────────────┤
│                                 │
│  <textarea> or <Monaco>         │  <- Editor
│                                 │
│  (expands to fill available     │
│   space, min 10 rows)           │
│                                 │
├─────────────────────────────────┤
│  [Clear]     [Cancel] [Send →]  │  <- Actions
└─────────────────────────────────┘

ScratchpadEditor

Phase 1: Simple textarea

<textarea
  value={content}
  onChange={(e) => onContentChange(e.target.value)}
  placeholder="Paste code, error logs, notes..."
  className="font-mono resize-none"
  rows={15}
/>

Phase 2: Monaco editor (code mode only)

Syntax highlighting based on detected or selected language

Auto-detect language from content (common patterns)

Language selector in mode dropdown

Mobile: ensure keyboard doesn't obscure editor


Phase 3: Mode-specific editors

Text: Tiptap for rich text formatting

Code: Monaco with language detection

Diagram: Mermaid preview with live rendering


ScratchpadCard

Appears in chat when content is shared (by user or Kimi).

Deletion semantics:

Delete removes the card from the UI only

It does not retroactively alter model context or history

It does not affect replay or prior turns


// components/cards/ScratchpadCard.tsx
interface ScratchpadCardProps {
  card: ScratchpadCard;
  onEdit?: () => void;    // loads content into scratchpad panel
  onCopy?: () => void;    // copies to clipboard
}

// Render:
// - Title (if provided)
// - Content preview (syntax highlighted if code)
// - Expand button (full-screen modal for long content)
// - Actions:
//   - User cards: Edit, Copy, Delete
//   - Assistant cards: Edit, Copy, Apply to File

Visual Design:

┌─────────────────────────────────┐
│ 📋 Scratchpad: Fixed version    │  <- Title (optional)
├─────────────────────────────────┤
│ const buggyFunction = () => {   │
│   // fixed code here...         │  <- Content preview
│   return result;                │     (truncated if long)
│ }                                │
├─────────────────────────────────┤
│ [Edit] [Copy] [Expand ↗]        │  <- Actions
└─────────────────────────────────┘


---

Implementation Phases

Phase 1: MVP (1-2 days)

Goal: Basic scratchpad with text-only sharing

Deliverables:

[ ] useScratchpad hook with localStorage persistence

[ ] ScratchpadButton component

[ ] ScratchpadPanel with textarea editor

[ ] ScratchpadCard component (read-only display)

[ ] User sharing flow (Send → creates card in chat)

[ ] Context injection for shared scratchpad content

[ ] Clear/Cancel actions

[ ] Mobile slide-up animation

[ ] Keyboard handling (Enter to send, Esc to close)


Skipped for Phase 1:

Kimi suggestions (no scratchpad_suggest tool yet)

Syntax highlighting

Mode selector

Edit action on cards


Phase 2: Kimi Suggestions (1 day)

Goal: Kimi can propose updated versions

Deliverables:

[ ] Add scratchpad_suggest to tool protocol

[ ] Tool detection in tool-dispatch.ts

[ ] Execute scratchpad_suggest → create assistant ScratchpadCard

[ ] Optional silent pre-audit by Auditor (non-blocking)

[ ] "Edit" action on ScratchpadCard (opens panel with card content)

[ ] "Copy" action (clipboard API)

[ ] Source badge on ScratchpadCard ("You" vs "Kimi")

[ ] Update Orchestrator prompt to mention scratchpad_suggest capability


Phase 3: Syntax Highlighting (1 day)

Goal: Better code readability

Deliverables:

[ ] Mode selector in ScratchpadPanel header (Text / Code / Diagram)

[ ] Auto-detect language from code content (simple heuristics)

[ ] Syntax highlighting in ScratchpadCard (using Shiki or Prism)

[ ] Optional: Monaco editor for code mode in panel

[ ] Language override dropdown (if auto-detection fails)


Phase 4: Rich Modes (2-3 days)

Goal: Specialized editors for different content types

Deliverables:

[ ] Text mode: Tiptap integration for formatted text

[ ] Diagram mode: Mermaid preview with live rendering

[ ] Mode persistence (remember last used mode)

[ ] Mode-specific placeholders

[ ] Export actions (save as file, copy as markdown, etc.)



---

State Flow

Sharing Flow (User → Kimi)

1. User taps ScratchpadButton
   ↓
2. ScratchpadPanel opens with persisted content
   ↓
3. User pastes/edits content
   ↓
4. User taps "Send"
   ↓
5. Create ScratchpadCard with source: 'user'
   ↓
6. Inject card into chat messages
   ↓
7. Close panel (content persists in localStorage)
   ↓
8. Next user message includes [SCRATCHPAD_SHARED] wrapper
   ↓
9. Kimi sees context, responds

Suggestion Flow (Kimi → User)

1. Kimi emits scratchpad_suggest tool in response
   ↓
2. tool-dispatch detects and executes
   ↓
3. Create ScratchpadCard with source: 'assistant'
   ↓
4. Inject card into chat messages
   ↓
5. User sees card with "Edit" action
   ↓
6. User taps "Edit"
   ↓
7. ScratchpadPanel opens pre-filled with Kimi's content
   ↓
8. User modifies and sends again (or cancels)


---

Mobile UX Details

Panel Animation

/* Slide up from bottom on mobile */
@media (max-width: 768px) {
  .scratchpad-panel {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 80vh;
    transform: translateY(100%);
    transition: transform 0.3s ease-out;
  }
  
  .scratchpad-panel.open {
    transform: translateY(0);
  }
}

/* Centered modal on desktop */
@media (min-width: 769px) {
  .scratchpad-panel {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 60vw;
    height: 70vh;
    border-radius: 8px;
  }
}

Keyboard Handling

iOS: Keyboard appearance shifts panel up (avoid covering editor)

Android: Panel resizes when keyboard appears

Desktop: No special handling needed


// Auto-adjust panel height when keyboard appears
useEffect(() => {
  const handleResize = () => {
    if (isOpen && isMobile) {
      const viewportHeight = window.visualViewport?.height || window.innerHeight;
      setPanelHeight(viewportHeight * 0.8);
    }
  };
  
  window.visualViewport?.addEventListener('resize', handleResize);
  return () => window.visualViewport?.removeEventListener('resize', handleResize);
}, [isOpen]);

Touch Gestures

// Swipe down to close (mobile only)
const handleTouchStart = (e: TouchEvent) => {
  touchStartY = e.touches[0].clientY;
};

const handleTouchMove = (e: TouchEvent) => {
  const deltaY = e.touches[0].clientY - touchStartY;
  if (deltaY > 100) {
    if (isDirty) {
      confirmClose();
      return;
    }
    onClose();
  }
};

Mobile Safe Area Requirements:

Use position: fixed

Respect bottom: env(safe-area-inset-bottom)

Ensure Send button is never obscured by iOS home bar


Anti-pattern: Do not allow swipe-to-close when there are unsent changes without confirmation.

---

## Storage Schema

### localStorage (Web)

```typescript
interface StoredScratchpad {
  content: string;
  mode: 'text' | 'code' | 'diagram';
  syntaxLanguage?: string;
  lastEdited: string; // ISO date
  version: number; // schema version for migrations
  isDirty: boolean; // unsent changes guard
  parentCardId?: string; // lineage tracking when editing a suggestion
}

// Key: 'diff-scratchpad-state'

Room DB (Android Native)

@Entity(tableName = "scratchpad")
data class ScratchpadEntity(
    @PrimaryKey val id: Int = 1, // singleton
    val content: String,
    val mode: String, // 'text' | 'code' | 'diagram'
    val syntaxLanguage: String?,
    val lastEdited: Long, // timestamp
    val version: Int
)


---

Tool Protocol Integration

Update tool-dispatch.ts

// Add to detectAnyToolCall()
if (toolCall.tool === 'scratchpad_suggest') {
  return {
    type: 'scratchpad_suggest',
    data: {
      title: toolCall.title,
      content: toolCall.content,
      mode: toolCall.mode || 'text',
      syntaxLanguage: toolCall.syntax_language
    }
  };
}

Update Orchestrator Prompt

## Scratchpad Tool

When the user shares scratchpad content, you can propose improvements:

{
  "tool": "scratchpad_suggest",
  "title": "Brief description",
  "content": "your improved version here",
  "mode": "code",
  "syntax_language": "typescript"
}

**Interpretation Rules**:
- Treat `[SCRATCHPAD_CARD]` blocks as **reference material**, not conversational turns
- Respond to the user's question *about* the card, not the card itself

**Guardrail**:
- Only emit `scratchpad_suggest` in direct response to a ScratchpadCard shared in the current turn

Use this when:
- Fixing bugs in shared code
- Improving documentation
- Reformatting content
- Adding missing details

The user will see your suggestion as a card and can accept/edit it.

markdown

Scratchpad Tool

When the user shares scratchpad content, you can propose improvements:

{ "tool": "scratchpad_suggest", "title": "Brief description", "content": "your improved version here", "mode": "code", "syntax_language": "typescript" }

Guardrail:

Only emit scratchpad_suggest in direct response to a ScratchpadCard shared in the current turn.


Use this when:

Fixing bugs in shared code

Improving documentation

Reformatting content

Adding missing details


The user will see your suggestion as a card and can accept/edit it.




---

Testing Strategy

Unit Tests

// useScratchpad.test.ts
describe('useScratchpad', () => {
  it('loads persisted content on mount', () => {});
  it('saves content to localStorage on change', () => {});
  it('clears content on clear action', () => {});
  it('preserves mode across sessions', () => {});
});

// ScratchpadPanel.test.tsx
describe('ScratchpadPanel', () => {
  it('renders with initial content', () => {});
  it('calls onSend when Send button clicked', () => {});
  it('calls onClose when Cancel clicked', () => {});
  it('updates content on textarea change', () => {});
});

// ScratchpadCard.test.tsx
describe('ScratchpadCard', () => {
  it('displays content preview', () => {});
  it('truncates long content', () => {});
  it('shows Edit action for assistant cards', () => {});
  it('copies to clipboard on Copy action', () => {});
});

Integration Tests

describe('Scratchpad E2E', () => {
  it('shares scratchpad content in chat', () => {
    // 1. Open scratchpad
    // 2. Enter content
    // 3. Click Send
    // 4. Verify ScratchpadCard appears in chat
    // 5. Verify next message includes context wrapper
  });
  
  it('edits Kimi suggestion', () => {
    // 1. Trigger scratchpad_suggest tool response
    // 2. Verify assistant ScratchpadCard appears
    // 3. Click Edit on card
    // 4. Verify panel opens with card content
    // 5. Modify content
    // 6. Send again
  });
});

Manual Testing Checklist

Mobile (iOS/Android):

[ ] Panel slides up smoothly

[ ] Keyboard doesn't obscure editor

[ ] Swipe down to close works

[ ] Touch targets are 44px minimum

[ ] Content persists after app kill

[ ] Scratchpad button badge shows when content exists


Desktop:

[ ] Panel centers properly

[ ] Keyboard shortcuts work (Cmd+Enter, Esc)

[ ] Resizing window doesn't break layout

[ ] Clicking backdrop closes panel


Cross-platform:

[ ] Content persists across sessions

[ ] Clear action works

[ ] Copy action uses clipboard API

[ ] Edit action loads card content into panel

[ ] Long content truncates in card preview

[ ] Expand action shows full content



---

Future Enhancements (Post-MVP)

Artifact Canvas (Optional, Advanced)

A Canvas is a long-lived, editable artifact layer optimized for long-form code or documents. Unlike the Scratchpad (which is a draft buffer), the Canvas represents a current working artifact.

Key distinctions:

Scratchpad → draft buffer, user-initiated, turn-based

Canvas → artifact workspace, assistant-assisted, persistent


Canvas Characteristics

Single active Canvas at a time

Full-screen slide-over editor on mobile

Persistent header icon to reopen current Canvas

Backed by local persistence (localStorage / Room DB)


Tool Integration

Introduce a client-side tool used by the Orchestrator or Coder:

{
  "tool": "update_canvas",
  "title": "Refactor: auth-hook.ts",
  "language": "typescript",
  "content": "<full file or document>",
  "type": "code"
}

Rules:

Use Canvas only for artifacts longer than ~20 lines or multi-step refactors

Canvas updates replace the active artifact; chat remains lightweight

Canvas content is never auto-applied without user confirmation


UX Flow (Mobile-first)

LLM emits update_canvas

Chat renders a lightweight Canvas indicator card

User taps indicator → CanvasView slides in full-screen

Header icon allows returning to Canvas at any time


Advanced Capabilities

Line comments: tap a line → send focused fix request to Coder

"Run in Sandbox" action embedded in Canvas

Inline diff view using existing DiffPreviewCard logic


Positioning

This keeps the system layered and legible:

Chat = conversation

Scratchpad = drafting

Canvas = working artifact



---

Success Metrics

This feature is successful if:

1. Reduces friction for sharing context with Kimi (one tap vs. copy/paste in chat)


2. Increases accuracy of Kimi's responses (better-formatted context)


3. Saves time on iterative edits (edit-in-place vs. re-typing)


4. Feels natural on mobile (no awkward keyboard issues, smooth gestures)


5. Low cognitive load (simple mental model: draft → share → edit → apply)



Anti-patterns to avoid:

Don't make it feel like a separate app (keep it lightweight)

Don't auto-share (user control is key)

Don't replace chat (scratchpad is supplementary)

Don't over-complicate modes (text/code is enough for v1)



---

Open Questions

1. Scratchpad clearing: Clear on send, or keep for next use?

Recommendation: Keep content after send (user can manually clear if needed)



2. Multiple scratchpads: Support more than one draft at a time?

Recommendation: Single scratchpad for Phase 1, named drafts in future



3. Syntax detection: Auto-detect or always manual?

Recommendation: Auto-detect with manual override option



4. Card persistence: Should ScratchpadCards stay in chat history forever?

Recommendation: Yes, same as all other cards (part of conversation)



5. Scratchpad in context: How much scratchpad content to include in Kimi's context?

Recommendation: Full content for current turn, summarize in future turns if still relevant





---

Implementation Checklist

Phase 1: MVP

Components:

[ ] Create useScratchpad hook

[ ] Create ScratchpadButton component

[ ] Create ScratchpadPanel component

[ ] Create ScratchpadCard component

[ ] Add ScratchpadButton to ChatInput

[ ] Wire panel open/close state


State Management:

[ ] Implement localStorage persistence

[ ] Add content/mode state

[ ] Handle clear/send actions

[ ] Auto-save on content change


Chat Integration:

[ ] Inject ScratchpadCard on send

[ ] Add context wrapper to next user message

[ ] Update message type definitions


Styling:

[ ] Mobile slide-up animation

[ ] Desktop centered modal

[ ] Keyboard safe area handling

[ ] Touch gesture for close


Testing:

[ ] Unit tests for useScratchpad

[ ] Component tests for panel/card

[ ] E2E test for share flow

[ ] Manual mobile testing


Phase 2: Kimi Suggestions

Tool Protocol:

[ ] Add scratchpad_suggest to tool types

[ ] Implement detection in tool-dispatch

[ ] Execute tool → create card

[ ] Update Orchestrator prompt


Card Actions:

[ ] Add Edit action to cards

[ ] Edit opens panel with card content

[ ] Add Copy action (clipboard)

[ ] Add source indicator (user vs assistant)


Testing:

[ ] E2E test for suggestion flow

[ ] Test edit action

[ ] Test copy action


Phase 3: Syntax Highlighting

UI:

[ ] Add mode selector to panel

[ ] Implement language auto-detection

[ ] Add syntax highlighting to cards

[ ] Optional: integrate Monaco editor


State:

[ ] Persist mode selection

[ ] Add syntaxLanguage to state

[ ] Update card rendering


Testing:

[ ] Test mode switching

[ ] Test language detection

[ ] Visual regression tests for syntax highlighting



---

Boring is Correct

This implementation follows the "boring is correct" philosophy:

localStorage over complex state management

Textarea over rich editors (Phase 1)

Simple turn-based over real-time sync

Explicit actions over automatic behavior

One scratchpad over multiple drafts

Card-based over separate panel UI


Keep it simple. Ship Phase 1 fast. Iterate based on usage.