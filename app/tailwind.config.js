/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // ── Push design tokens ────────────────────────────
        // Single source of truth. Use these instead of [#hex].

        // Text hierarchy (bright → dim)
        'push-fg':           '#f5f7ff',  // primary text
        'push-fg-secondary': '#b4becf',  // secondary text, labels
        'push-fg-muted':     '#8b96aa',  // muted text, subtle icons
        'push-fg-dim':       '#667086',  // dimmest text, placeholders

        // Surfaces (light → dark)
        'push-surface':        '#070a10',  // base background
        'push-surface-raised': '#0c1018',  // elevated surface
        'push-surface-hover':  '#0d1119',  // hover background
        'push-surface-active': '#111624',  // pressed / badge background
        'push-surface-inset':  '#05080e',  // recessed (editor, inputs)

        // Borders (subtle → strong)
        'push-edge-subtle':  '#1b2230',  // dividers, input borders
        'push-edge':         '#1f2531',  // primary border
        'push-edge-hover':   '#2f3949',  // hover border

        // Status
        'push-status-success': '#22c55e',  // green
        'push-status-error':   '#ef4444',  // red
        'push-status-warning': '#f59e0b',  // amber

        // Accent
        'push-accent':       '#0070f3',  // blue accent
        'push-sky':          '#38bdf8',  // cyan accent (focus rings, glow)
        'push-link':         '#5cb7ff',  // bright blue links, actions
        'push-glow':         '#0070f3',  // glow color for interactive elements
        // ──────────────────────────────────────────────────
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
      fontSize: {
        'push-2xs': ['10px', { lineHeight: '14px' }],  // micro labels, badges
        'push-xs':  ['11px', { lineHeight: '16px' }],  // labels, timestamps
        'push-sm':  ['12px', { lineHeight: '16px' }],  // secondary body
        'push-base': ['13px', { lineHeight: '18px' }], // primary body
        'push-lg':  ['15px', { lineHeight: '20px' }],  // section headings
      },
      borderRadius: {
        xl: "calc(var(--radius) + 4px)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xs: "calc(var(--radius) - 6px)",
      },
      boxShadow: {
        xs: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
        "push-sm": "0 2px 8px rgba(0, 0, 0, 0.25)",
        "push-md": "0 8px 24px rgba(0, 0, 0, 0.35)",
        "push-lg": "0 14px 36px rgba(0, 0, 0, 0.45)",
        "push-xl": "0 20px 48px rgba(0, 0, 0, 0.55)",
        "push-card": "0 4px 16px rgba(0, 0, 0, 0.3), 0 1px 4px rgba(0, 0, 0, 0.15)",
        "push-card-hover": "0 8px 28px rgba(0, 0, 0, 0.4), 0 2px 6px rgba(0, 0, 0, 0.2)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "caret-blink": {
          "0%,70%,100%": { opacity: "1" },
          "20%,50%": { opacity: "0" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "fade-in-up": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in-right": {
          from: { opacity: "0", transform: "translateX(8px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down var(--motion-fast) ease-out",
        "accordion-up": "accordion-up var(--motion-fast) ease-out",
        "caret-blink": "caret-blink 1.25s ease-out infinite",
        "fade-in": "fade-in var(--motion-fast) ease-out",
        "fade-in-up": "fade-in-up var(--motion-normal) var(--ease-spring)",
        "slide-in-right": "slide-in-right var(--motion-normal) var(--ease-spring)",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}