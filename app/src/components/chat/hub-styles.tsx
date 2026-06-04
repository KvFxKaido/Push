// Flat chrome. The "glass" identity (backdrop-blur + translucent gradient +
// heavy floating shadow) is gone: chrome surfaces are now a solid raised step
// over the canvas with a clean 1px border, the way DeepSeek/Kimi build chips
// and panels. Surface hierarchy comes from border + fill contrast, not blur or
// shadow (see DESIGN.md → Shadows).
const HUB_MATERIAL_SURFACE_BASE_CLASS =
  'relative overflow-hidden border border-push-edge bg-push-surface-raised';

// The flat chrome surface. (Formerly this added `backdrop-blur-xl` over the
// base; flat chrome has no blur, so the two collapsed into one.)
export const HUB_MATERIAL_SURFACE_CLASS = HUB_MATERIAL_SURFACE_BASE_CLASS;

export const HUB_MATERIAL_INTERACTIVE_CLASS =
  'transition-all duration-200 hover:border-push-edge-hover hover:text-push-fg hover:brightness-110';

const HUB_MATERIAL_PILL_LAYOUT_CLASS =
  'inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-push-xs text-push-fg-dim disabled:opacity-50';

export const HUB_MATERIAL_BUTTON_CLASS = `${HUB_MATERIAL_SURFACE_CLASS} ${HUB_MATERIAL_INTERACTIVE_CLASS}`;

export const HUB_MATERIAL_PILL_BUTTON_CLASS = `${HUB_MATERIAL_BUTTON_CLASS} ${HUB_MATERIAL_PILL_LAYOUT_CLASS}`;

export const HUB_MATERIAL_ROUND_BUTTON_CLASS = `${HUB_MATERIAL_BUTTON_CLASS} inline-flex h-8 w-8 items-center justify-center rounded-full text-push-fg-dim disabled:opacity-50`;

export const HUB_MATERIAL_INPUT_CLASS = `${HUB_MATERIAL_SURFACE_CLASS} h-8 rounded-full px-3 text-xs text-push-fg-secondary outline-none transition-all placeholder:text-push-fg-dim focus:border-push-sky/50 disabled:opacity-50`;

// Top-level panel: a solid raised surface one clear step above the canvas,
// defined by a 1px border instead of a translucent gradient + drop shadow.
export const HUB_PANEL_SURFACE_CLASS =
  'rounded-[20px] border border-push-edge bg-push-surface-raised';

// Nested panel: recesses below its parent (inset fill) so the two layers read
// as distinct without any blur or shadow.
export const HUB_PANEL_SUBTLE_SURFACE_CLASS =
  'rounded-[18px] border border-push-edge-subtle bg-push-surface-inset';

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
export const HUB_GLASS_PANEL_CLASS =
  'border-white/[0.07] bg-[linear-gradient(180deg,rgba(12,16,24,0.82)_0%,rgba(6,9,14,0.93)_100%)] backdrop-blur-2xl';

// Soft hairline for dividers *inside* the glass menus. Replaces the hard
// `border-push-edge` slabs so stacked sections read as one continuous panel,
// and supplies the resting outline color folded into GLASS_SURFACE below.
export const HUB_GLASS_HAIRLINE = 'border-white/[0.06]';

// Resting tinted tile — the lift that turns the drawer's repo / section groups
// into soft glass surfaces instead of flat slabs. Pair with the hover variant
// for interactive tiles; an accent-active state may override it (set border + bg
// in one place each so they never collide on CSS order).
export const GLASS_SURFACE = 'border-white/[0.06] bg-white/[0.02]';
export const GLASS_SURFACE_HOVER = 'hover:border-white/[0.09] hover:bg-white/[0.05]';

// Active (selected) glass tile — the accent counterpart to GLASS_SURFACE. The
// Sky tint + ring + soft drop-glow that marks the live repo card and the live
// tab cell, derived from `--push-accent-rgb` so it follows repo theming. Sets
// border + bg in one place each (drop it onto a tile whose base owns only the
// border *width*); callers add their own text color. Single source so the two
// active surfaces can't drift apart on alpha/shadow.
export const GLASS_ACTIVE_CLASS =
  'border-push-accent/30 bg-push-accent/[0.08] shadow-[0_0_0_1px_rgb(var(--push-accent-rgb)_/_0.06),0_10px_26px_-15px_rgb(var(--push-accent-rgb)_/_0.5)]';

// Borderless fill family — translucent white lifts with no edge, for surfaces
// that build hierarchy from fill alone (the drawer footer, the workspace tool
// tabs, the Review segmented pills). Both alphas are the documented fill steps
// (0.02 faint, 0.05 soft); each comes in a resting and a `hover:` form so call
// sites compose the scale instead of hand-rolling a fresh `white/[x]`.
export const GLASS_FILL_FAINT = 'bg-white/[0.02]';
export const GLASS_FILL_SOFT = 'bg-white/[0.05]';
export const GLASS_FILL_HOVER_FAINT = 'hover:bg-white/[0.02]';
export const GLASS_FILL_HOVER_SOFT = 'hover:bg-white/[0.05]';

// Status / lifecycle strip: a bottom hairline seam plus the faint lift, so the
// sandbox bars separate from the tab content without a hard rule.
export const HUB_GLASS_STRIP_CLASS = 'border-b border-white/[0.06] bg-white/[0.02]';

// Quiet ghost icon action inside the glass (e.g. the per-repo customize button)
// — no chrome surface, just a hover wash. Caller supplies size + position.
export const GLASS_GHOST_BUTTON_CLASS =
  'flex items-center justify-center rounded-full text-push-fg-dim transition-colors hover:bg-white/[0.05] hover:text-push-fg-secondary';

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
