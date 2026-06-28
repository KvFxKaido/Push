// Neumorphic chrome. Chrome surfaces are a solid step over the canvas with a
// clean 1px border, but they now carry dark-neumorphic *depth*: raised controls
// lift with a lit top edge (`shadow-push-raised`) and press in on `:active`
// (`shadow-push-inset`), while input-shaped chrome sinks into the surface as a
// recessed well. The base surface itself stays depth-free so each consumer opts
// into the raise or the recess explicitly (two `shadow-*` utilities on one
// element would collide on source order). Dense *content* cards remain flat —
// the depth tokens are chrome- and recess-only. See DESIGN.md → Shadows.
const HUB_MATERIAL_SURFACE_BASE_CLASS =
  'relative overflow-hidden border border-push-edge bg-push-surface-raised';

// The depth-free chrome surface. Buttons compose `shadow-push-raised` on top;
// inputs compose `shadow-push-inset`. (Formerly this added `backdrop-blur-xl`
// over the base; flat chrome has no blur, so the two collapsed into one.)
export const HUB_MATERIAL_SURFACE_CLASS = HUB_MATERIAL_SURFACE_BASE_CLASS;

// Raised + pressable: a stronger lift on hover and a press-to-recess on
// `:active`, so a hub button reads as a physical key rather than a flat chip.
// Keyboard focus adds an *offset* 3px light-Sky ring (`ring-ring/50`) sitting in
// a gap of the surface's own fill, so it clears the raised drop shadow + lit
// edge instead of being swallowed by them. `focus-visible` keeps it keyboard-
// only — a pointer press recesses via `:active` and never paints the ring.
// See DESIGN.md → Shadows → "Focus-visible on raised chrome".
export const HUB_MATERIAL_INTERACTIVE_CLASS =
  'transition-all duration-200 hover:border-push-edge-hover hover:text-push-fg hover:brightness-110 hover:shadow-push-raised-hover active:shadow-push-inset focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-push-surface-raised';

const HUB_MATERIAL_PILL_LAYOUT_CLASS =
  'inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-push-xs text-push-fg-dim disabled:opacity-50';

export const HUB_MATERIAL_BUTTON_CLASS = `${HUB_MATERIAL_SURFACE_CLASS} shadow-push-raised ${HUB_MATERIAL_INTERACTIVE_CLASS}`;

export const HUB_MATERIAL_PILL_BUTTON_CLASS = `${HUB_MATERIAL_BUTTON_CLASS} ${HUB_MATERIAL_PILL_LAYOUT_CLASS}`;

export const HUB_MATERIAL_ROUND_BUTTON_CLASS = `${HUB_MATERIAL_BUTTON_CLASS} inline-flex h-8 w-8 items-center justify-center rounded-full text-push-fg-dim disabled:opacity-50`;

// Input chrome recesses (inset) instead of lifting — a field reads as carved
// into the surface, the neumorphic counterpart to the raised button.
export const HUB_MATERIAL_INPUT_CLASS = `${HUB_MATERIAL_SURFACE_CLASS} shadow-push-inset h-8 rounded-full px-3 text-xs text-push-fg-secondary outline-none transition-all placeholder:text-push-fg-dim focus:border-push-sky/50 disabled:opacity-50`;

// Top-level panel: a solid surface one clear step above the canvas, lifted with
// the raised depth so it floats over the page.
export const HUB_PANEL_SURFACE_CLASS =
  'rounded-[20px] border border-push-edge bg-push-surface-raised shadow-push-raised';

// Nested panel: recesses below its parent (inset fill + inset shadow) so the
// two layers read as distinct — a well sunk into the raised panel above it.
export const HUB_PANEL_SUBTLE_SURFACE_CLASS =
  'rounded-[18px] border border-push-edge-subtle bg-push-surface-inset shadow-push-inset';

export const HUB_TOP_BANNER_STRIP_CLASS = 'animate-fade-in border-b bg-transparent';

// ── Menu glass ─────────────────────────────────────────────
// The top-level sliding menus (Chats drawer, Workspace hub) are the one place
// Push keeps a true glass material: a translucent gradient + backdrop blur so
// the live chat surface and its Sky ambient frost *through* the panel instead
// of reading as a separate black overlay. The glass identity extends from the
// shell down to a small set of tinted surfaces built on it (strips, repo cards,
// the tab tray + cells) — flat `HUB_MATERIAL_*` / `HUB_PANEL_*` is reserved for
// the *dense content* inside a menu (settings forms, inputs, data/diff cards),
// where a solid raised step out-reads a translucent tint. See DESIGN.md → Hub
// utility classes for the full contract.
//
// Everything below is the single source of truth for that scale: a complete
// utility class per token (the Tailwind JIT only emits classes that appear as
// unbroken strings, so compose with a space — never interpolate the opacity).
// The scale is intentionally tight — five alpha steps total: 0.02 fill,
// 0.05 hover fill, 0.06 hairline, 0.07 shell frame, 0.09 hover edge.

// Panel shell: the frosted surface *and* its outer frame weight. Callers add
// only the side (`border-l` / `border-r` / `border-t`) so the frame lives here,
// one step stronger than the inner hairline by design (a defined outer edge).
// Shadow-free by design: a drawer that uses this also supplies its own outer
// elevation, and two `shadow-*` utilities on one element collide (only one
// box-shadow wins). The frosted edge is folded into the `shadow-push-glass`
// token applied at the drawer call sites instead, so elevation + edge live in
// one utility. Internal seams (e.g. a glass footer) compose this class with no
// shadow, exactly as before.
export const HUB_GLASS_PANEL_CLASS =
  'border-white/[0.07] bg-[linear-gradient(180deg,rgba(12,16,24,0.82)_0%,rgba(6,9,14,0.93)_100%)] backdrop-blur-2xl';

// Soft hairline for dividers *inside* the glass menus. Replaces the hard
// `border-push-edge` slabs so stacked sections read as one continuous panel,
// and supplies the resting outline color the tiles below compose.
export const HUB_GLASS_HAIRLINE = 'border-white/[0.06]';

// Borderless fill family — translucent white lifts with no edge. The two
// documented fill steps (0.02 faint, 0.05 soft), each in a resting and a
// `hover:` form. These are the *atoms* of the glass scale: every tinted glass
// surface below composes from them (and the hairline above), so the alphas are
// declared exactly once and call sites never hand-roll a fresh `white/[x]`.
// (The `hover:` forms are separate literals because the Tailwind JIT only emits
// classes that appear as unbroken strings — a `hover:` prefix can't be glued on
// at runtime.)
export const GLASS_FILL_FAINT = 'bg-white/[0.02]';
export const GLASS_FILL_SOFT = 'bg-white/[0.05]';
export const GLASS_FILL_HOVER_FAINT = 'hover:bg-white/[0.02]';
export const GLASS_FILL_HOVER_SOFT = 'hover:bg-white/[0.05]';

// Resting tinted tile — the lift that turns the drawer's repo / section groups
// into soft glass surfaces instead of flat slabs. Pair with the hover variant
// for interactive tiles; an accent-active state may override it (set border + bg
// in one place each so they never collide on CSS order). `0.09` is the one
// hover-edge step and lives only here.
export const GLASS_SURFACE = `${HUB_GLASS_HAIRLINE} ${GLASS_FILL_FAINT}`;
export const GLASS_SURFACE_HOVER = `hover:border-white/[0.09] ${GLASS_FILL_HOVER_SOFT}`;

// Active (selected) glass tile — the accent counterpart to GLASS_SURFACE. The
// Sky tint + ring + soft drop-glow that marks the live repo card and the live
// tab cell, derived from `--push-accent-rgb` so it follows repo theming. Sets
// border + bg in one place each (drop it onto a tile whose base owns only the
// border *width*); callers add their own text color. Single source so the two
// active surfaces can't drift apart on alpha/shadow.
export const GLASS_ACTIVE_CLASS =
  'border-push-accent/30 bg-push-accent/[0.08] shadow-[0_0_0_1px_rgb(var(--push-accent-rgb)_/_0.06),0_10px_26px_-15px_rgb(var(--push-accent-rgb)_/_0.5)]';

// Status / lifecycle strip: a bottom hairline seam plus the faint lift, so the
// sandbox bars separate from the tab content without a hard rule.
export const HUB_GLASS_STRIP_CLASS = `border-b ${HUB_GLASS_HAIRLINE} ${GLASS_FILL_FAINT}`;

// Quiet ghost icon action inside the glass (e.g. the per-repo customize button)
// — no chrome surface, just a hover wash. Caller supplies size + position.
export const GLASS_GHOST_BUTTON_CLASS = `flex items-center justify-center rounded-full text-push-fg-dim transition-colors ${GLASS_FILL_HOVER_SOFT} hover:text-push-fg-secondary`;

export const HUB_TAG_CLASS =
  'inline-flex items-center rounded-full border border-push-edge-subtle bg-black/15 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-push-fg-dim';

// Chat surface header chrome. These describe the in-bar buttons used by
// the 3-region chat app bar (ChatScreen / ChatSurfaceScreen) — not the
// navigation HeaderBar primitive used by pairing/settings pages. The
// chat app bar puts interactive content in all three grid cells (drawer
// + label left, launcher pill center, palette + dock right), so it can't
// share HeaderBar's `back / title / actions` API. The classes were
// duplicated verbatim across both chat screens; consolidating here is
// the minimum needed to keep them from drifting.
export const HEADER_PLAIN_INTERACTIVE_CLASS =
  'relative text-push-fg-secondary transition-colors duration-200 hover:text-push-fg active:scale-[0.98]';
export const HEADER_ROUND_BUTTON_CLASS = `flex h-9 w-9 items-center justify-center ${HEADER_PLAIN_INTERACTIVE_CLASS}`;
export const HEADER_PILL_BUTTON_CLASS = `pointer-events-auto flex h-9 items-center gap-2 px-1.5 ${HEADER_PLAIN_INTERACTIVE_CLASS}`;
