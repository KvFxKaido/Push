/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    // Streamdown ships its CodeBlock/prose styling as Tailwind utility classes
    // in its dist bundle. Tailwind v3 purges any class it can't find in a
    // scanned file, so without this path the Streamdown-rendered code block
    // chrome (padding/background/border/overflow) is stripped in production
    // builds and highlighted blocks render unstyled. Required by Streamdown's
    // Tailwind v3 setup. Adapter: src/components/chat/PushMarkdownRenderer.tsx.
    './node_modules/streamdown/dist/*.js',
    // Push's Shiki plugin lives in src/ and is covered by the app glob above.
  ],
  theme: {
    extend: {
      colors: {
        // ── Push design tokens ────────────────────────────
        // Single source of truth for the web. Use these instead of [#hex].
        //
        // The cross-surface *identity* tokens below (push-fg{,-secondary,-muted,
        // -dim}, push-surface{,-raised}, push-edge{,-hover}, push-status-{success,
        // warning,error}, push-accent, push-sky, push-link) mirror the shared
        // palette in lib/design-tokens.ts, which the TUI imports directly. This
        // CJS config can't import that TS module at build time, so the values
        // are duplicated here and locked by app/src/lib/design-tokens-drift.test.ts
        // (fails CI on any mismatch). Web-only nuance shades have no TUI peer and
        // live only here.

        // Text hierarchy (bright → dim)
        'push-fg': '#f5f7ff', // primary text
        'push-fg-secondary': '#b4becf', // secondary text, labels
        'push-fg-soft': '#d7deeb', // softened primary text (chat/library panels)
        'push-fg-muted': '#8b96aa', // muted text, subtle icons
        'push-fg-faint': '#7c879b', // fainter muted text (chat/library panels)
        'push-fg-dim': '#667086', // very dim text
        'push-fg-dimmest': '#505971', // disabled / placeholder text (below dim)

        // Surfaces (light → dark)
        'push-surface': '#070a10', // base background
        'push-surface-raised': '#14171f', // elevated surface
        'push-surface-hover': '#0d1119', // hover background
        'push-surface-active': '#111624', // pressed / badge background
        'push-surface-inset': '#05080e', // recessed (editor, inputs)

        // Borders (subtle → strong)
        'push-edge-subtle': '#242c39', // dividers, input borders
        'push-edge': '#2b3340', // primary border
        'push-edge-hover': '#2f3949', // hover border
        'push-edge-focus': '#3d5579', // focus / active input border

        // Status
        'push-status-success': '#22c55e', // green
        'push-status-success-soft': '#4ade80', // lighter green — success/added text on dark
        'push-status-success-bg': '#173523', // dark green tint — success hover background
        'push-status-error': '#ef4444', // red
        'push-status-error-soft': '#f87171', // lighter red — error/removed text on dark
        'push-status-warning': '#f59e0b', // amber

        // Accent — Sky. Light #7dd3fc is the airy identity color (accent text,
        // icons, links, glow, tinted buttons); deep Sky lives in --primary for
        // solid shadcn indicators that need white-on-color contrast.
        'push-accent': '#7dd3fc', // sky accent
        'push-sky': '#38bdf8', // mid sky — secondary focus borders (focus:border-push-sky/50), highlights
        'push-link': '#7dd3fc', // sky links, actions
        'push-link-hover': '#bae6fd', // brighter sky on hover
        'push-glow': '#7dd3fc', // glow color for interactive elements
        'push-violet': '#c4b5fd', // violet accent — chat/conversation affordances
        // ──────────────────────────────────────────────────
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive) / <alpha-value>)',
          foreground: 'hsl(var(--destructive-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar-background))',
          foreground: 'hsl(var(--sidebar-foreground))',
          primary: 'hsl(var(--sidebar-primary))',
          'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
          accent: 'hsl(var(--sidebar-accent))',
          'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
          border: 'hsl(var(--sidebar-border))',
          ring: 'hsl(var(--sidebar-ring))',
        },
      },
      fontFamily: {
        // Resolve to the CSS vars in index.css so the face is swappable in one place.
        sans: ['var(--font-sans)'],
        display: ['var(--font-display)'],
        mono: ['var(--font-mono)'],
      },
      fontSize: {
        'push-2xs': ['10px', { lineHeight: '14px' }], // micro labels, badges
        'push-xs': ['11px', { lineHeight: '16px' }], // labels, timestamps
        'push-sm': ['12px', { lineHeight: '16px' }], // secondary body
        'push-base': ['13px', { lineHeight: '18px' }], // primary body
        'push-lg': ['15px', { lineHeight: '20px' }], // section headings
        // ── Display tier ── headings that get to be a statement. Negative
        // tracking is the "designed, not defaulted" tell; pair with font-display.
        'push-xl': ['18px', { lineHeight: '24px', letterSpacing: '-0.01em' }], // large headings, dialog titles
        'push-2xl': ['24px', { lineHeight: '30px', letterSpacing: '-0.015em' }], // screen titles, empty-state headlines
        'push-display': ['32px', { lineHeight: '38px', letterSpacing: '-0.02em' }], // hero / welcome moments
      },
      borderRadius: {
        xl: 'calc(var(--radius) + 4px)',
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        xs: 'calc(var(--radius) - 6px)',
      },
      boxShadow: {
        // `xs` is the shadcn hairline default (a 1px lift on small controls). It
        // is intentionally NOT folded into the neumorphic scale below — it's a
        // subtle generic shadow, not part of the raised/inset depth vocabulary.
        xs: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
        'push-sm': '0 2px 8px rgba(0, 0, 0, 0.25)',
        'push-md': '0 8px 24px rgba(0, 0, 0, 0.35)',
        'push-lg': '0 14px 36px rgba(0, 0, 0, 0.45)',
        'push-xl': '0 20px 48px rgba(0, 0, 0, 0.55)',
        'push-card': '0 4px 16px rgba(0, 0, 0, 0.3), 0 1px 4px rgba(0, 0, 0, 0.15)',
        'push-card-hover': '0 8px 28px rgba(0, 0, 0, 0.4), 0 2px 6px rgba(0, 0, 0, 0.2)',
        // ── Neumorphic depth (surgical) ───────────────────────────
        // The dark-neumorphism layer. Recessed wells *sink* (inset), raised
        // chrome *lifts* with a lit top edge, and the glass drawer shells get a
        // combined elevation + frosted edge (`push-glass`). All grayscale
        // (black ambient + white sheen) so the depth reads on the near-black
        // canvas without introducing a hue. Dense content cards stay flat
        // (border + fill contrast) — these tokens are for chrome + recessed
        // surfaces only. See DESIGN.md → Shadows.
        'push-inset':
          'inset 0 1px 2px 0 rgba(0, 0, 0, 0.5), inset 0 0 0 1px rgba(255, 255, 255, 0.015)',
        'push-inset-strong':
          'inset 0 2px 5px 0 rgba(0, 0, 0, 0.65), inset 0 1px 0 0 rgba(255, 255, 255, 0.02)',
        'push-raised':
          '0 1px 2px rgba(0, 0, 0, 0.4), 0 3px 9px -2px rgba(0, 0, 0, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.04)',
        'push-raised-hover':
          '0 2px 4px rgba(0, 0, 0, 0.45), 0 8px 20px -4px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
        // Glass drawer shell: outer floating elevation *and* the frosted inner
        // edge (lit top, soft dark bottom) folded into ONE box-shadow utility,
        // so a drawer that already needs elevation doesn't end up with two
        // colliding `shadow-*` classes (only one box-shadow can win). Applied at
        // the drawer call sites, not on the shared glass class.
        'push-glass':
          '0 16px 48px rgba(0, 0, 0, 0.5), 0 4px 16px rgba(0, 0, 0, 0.28), inset 0 1px 0 0 rgba(255, 255, 255, 0.08), inset 0 -1px 0 0 rgba(0, 0, 0, 0.3)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--accordion-panel-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--accordion-panel-height)' },
          to: { height: '0' },
        },
        'caret-blink': {
          '0%,70%,100%': { opacity: '1' },
          '20%,50%': { opacity: '0' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'fade-in-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          from: { opacity: '0', transform: 'translateX(8px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down var(--motion-fast) ease-out',
        'accordion-up': 'accordion-up var(--motion-fast) ease-out',
        'caret-blink': 'caret-blink 1.25s ease-out infinite',
        'fade-in': 'fade-in var(--motion-fast) ease-out',
        'fade-in-up': 'fade-in-up var(--motion-normal) var(--ease-spring)',
        'slide-in-right': 'slide-in-right var(--motion-normal) var(--ease-spring)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
