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
