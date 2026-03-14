export const HUB_MATERIAL_SURFACE_CLASS =
  'relative overflow-hidden border border-push-edge-subtle bg-push-grad-input shadow-[0_12px_34px_rgba(0,0,0,0.5),0_3px_10px_rgba(0,0,0,0.28)] backdrop-blur-xl';

export const HUB_MATERIAL_INTERACTIVE_CLASS =
  'transition-all duration-200 hover:border-push-edge-hover hover:text-push-fg hover:brightness-110';

export const HUB_MATERIAL_BUTTON_CLASS =
  `${HUB_MATERIAL_SURFACE_CLASS} ${HUB_MATERIAL_INTERACTIVE_CLASS}`;

export const HUB_MATERIAL_PILL_BUTTON_CLASS =
  `${HUB_MATERIAL_BUTTON_CLASS} inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-push-xs text-push-fg-dim disabled:opacity-50`;

export const HUB_MATERIAL_ROUND_BUTTON_CLASS =
  `${HUB_MATERIAL_BUTTON_CLASS} inline-flex h-8 w-8 items-center justify-center rounded-full text-push-fg-dim disabled:opacity-50`;

export const HUB_MATERIAL_INPUT_CLASS =
  `${HUB_MATERIAL_SURFACE_CLASS} h-8 rounded-full px-3 text-xs text-push-fg-secondary outline-none transition-all placeholder:text-push-fg-dim focus:border-push-sky/50 disabled:opacity-50`;

export const HUB_PANEL_SURFACE_CLASS =
  'rounded-[20px] border border-push-edge/80 bg-[linear-gradient(180deg,rgba(11,15,22,0.96)_0%,rgba(6,9,14,0.98)_100%)] shadow-[0_18px_40px_rgba(0,0,0,0.48),0_3px_10px_rgba(0,0,0,0.24)]';

export const HUB_PANEL_SUBTLE_SURFACE_CLASS =
  'rounded-[18px] border border-push-edge/70 bg-[linear-gradient(180deg,rgba(9,13,19,0.88)_0%,rgba(5,8,13,0.94)_100%)] shadow-[0_14px_30px_rgba(0,0,0,0.32),0_2px_8px_rgba(0,0,0,0.18)]';

export const HUB_TOP_BANNER_STRIP_CLASS =
  'animate-fade-in border-b bg-transparent';

export const HUB_TAG_CLASS =
  'inline-flex items-center rounded-full border border-push-edge-subtle bg-black/15 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-push-fg-dim';

export function HubControlGlow() {
  return (
    <span className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/[0.05] to-transparent" />
  );
}
