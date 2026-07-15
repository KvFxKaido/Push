# Astro Migration Assessment

Date: 2026-06-23
Status: **Reference** — recommendation is **do not migrate the `app/`
SPA to Astro**; instead lift the Astro 7 agent-dev ergonomics onto the existing
Vite 8 setup. No implementation committed. Owner: Push web.

## Context

Astro 7 shipped (June 2026): Vite 8 + Rolldown (Rust bundler), a Rust `.astro`
compiler, a Rust Markdown/MDX pipeline (15–61% faster builds in their
benchmarks), Advanced Routing (`src/fetch.ts` request-pipeline entrypoint),
stabilized route caching with experimental CDN cache providers (Netlify, Vercel,
Cloudflare), and an **AI-agent dev mode** — the dev server can detect a coding
agent, run in the background, and emit structured JSON logs for machine-readable
feedback.

The migration interest is framed around troubleshooting ergonomics ("especially
for troubleshooting with you"), which maps to that last feature, not to Astro's
rendering model.

## What Astro is built for

Astro's value proposition is **content-first, multi-page sites with islands
architecture**: render mostly-static HTML, ship zero JS by default, and hydrate
only the interactive islands (`client:*` directives). The framework's wins —
smaller payloads, partial hydration, MPA routing, content collections — all
assume pages that are *mostly static with pockets of interactivity*.

## What Push's `app/` actually is

Measured against the current tree on `claude/astro-migration-a2hhby`:

- **One stateful SPA shell, not pages.** Navigation is in-memory React state
  (`AppShellScreen` switched inside `app/src/App.tsx`). There is **no router**,
  no URL-addressable routes, no content pages — `grep` for
  `react-router` / `createBrowserRouter` / `<Routes` returns nothing. The ~16
  screen sections under `app/src/sections/` are conditionally rendered React
  subtrees, not routes.
- **Everything is interactive.** Streaming chat, CodeMirror editors (10+
  `@codemirror/*` language packs), `react-virtuoso` virtualized lists, Radix UI
  throughout, WebSocket-driven sandbox controllers, mermaid/shiki rendering.
  ~369 component/hook/lib files under `app/src/{components,hooks,sections}`, and
  effectively all of it hydrates. Astro would render an island that *is* the
  whole app — paying the framework's complexity for none of its payoff.
- **The backend is a hand-written Cloudflare Worker.** ~42k lines across
  `app/src/worker/*` (`worker-middleware`, `worker-providers`, `worker-pr-review`,
  `worker-session`, sandbox handlers) plus `app/worker.ts`, bound to Durable
  Objects and the DO-backed sandbox. Astro endpoints / Advanced Routing do not
  model Durable Objects or the DO-bound sandbox; the Worker stays, and Astro
  bolts on top rather than replacing anything.
- **Two extra consumers ride the Vite build.** The PWA service worker is stamped
  in `app/vite.config.ts` (`stampServiceWorkerCache`, rewrites `dist/sw.js`), and
  the Capacitor Android shell consumes `dist/` via `cap sync` (`npm run
  android:sync`). Both assume a Vite SPA output; an Astro output reshapes both.

## The build-speed win is already (mostly) yours

`app/package.json` already pins `vite@^8.0.16`. Rolldown lands through Vite
itself, so the headline Astro 7 build-speed improvement arrives **without**
adopting Astro. The compiler/MDX-pipeline speedups apply to `.astro` and
Markdown content — Push has neither in the app surface.

## Cost vs. payoff

| Astro 7 feature | Value to Push `app/` | Comes free of a migration? |
|---|---|---|
| Vite 8 + Rolldown faster builds | Real | **Yes** — already on Vite 8 |
| Rust `.astro` compiler | None | n/a — no `.astro` files |
| Rust Markdown/MDX pipeline | None in app shell | n/a |
| Islands / zero-JS-by-default | Negative — app is 100% interactive | — |
| Advanced Routing (`src/fetch.ts`) | None — Worker owns the pipeline, no URL routes | — |
| Route caching / CDN providers | Low — app shell isn't cacheable content | — |
| **AI-agent dev mode (JSON logs, bg dev server, agent detect)** | **High — the actual goal** | **Yes — pattern, not framework** |

The one feature that motivated this — agent-friendly dev ergonomics — is
decoupled from the rendering framework. Structured JSON dev-server logs, agent
detection, and a background dev server are patterns adoptable against the
existing Vite config, and they align with the repo's own **symmetric structured
logs** convention (`CLAUDE.md`). The features that *require* Astro (islands,
MPA routing, content collections, Advanced Routing) target an app shape Push
does not have and does not want.

## What a real migration would actually cost

For completeness, if pursued anyway:

1. **Re-model navigation.** Convert the in-memory `AppShellScreen` state machine
   into either Astro routes (changes deep-link/back-button/PWA-install behavior)
   or a single catch-all route that re-hosts the existing SPA (Astro adds a
   wrapper but buys nothing).
2. **Re-wire the Worker.** Reconcile Astro's Cloudflare adapter + Advanced
   Routing with the hand-written Worker, Durable Objects, and the DO-bound
   sandbox. High-risk seam: `prepare_push`/sandbox/PR-review paths in
   `app/src/worker/*`.
3. **Re-stamp the PWA.** Port `stampServiceWorkerCache` to Astro's output layout
   and re-validate stale-cache purge on deploy.
4. **Re-validate Capacitor.** Confirm `cap sync` consumes an Astro `dist/` and
   the Android shell (JGit plugin, desugaring, proguard) still builds.
5. **Re-home the test stack.** ~done via vitest today; Astro changes the dev/build
   harness the tests run against.

Multi-week effort touching the highest-risk seams in the product (push gate,
sandbox, Android), in exchange for ergonomics obtainable without it.

## Recommendation

**Do not migrate the `app/` SPA to Astro.** It is close to the worst-fit case
for Astro's model: an all-interactive, in-memory-routed SPA over a hand-written
Worker, with a PWA and a Capacitor shell riding the build.

Instead, capture the motivating benefit directly:

- Adopt **structured JSON dev-server logs** and an **agent-detectable /
  background dev server** against the existing Vite 8 setup, mirroring the
  `lib/` symmetric-structured-logs convention.
- Track Rolldown stabilization through the existing Vite 8 dependency.

Revisit only if Push grows a genuinely **content-heavy, URL-routed, mostly-static
surface** (e.g. public docs, marketing, or a static blog) that is separable from
the app shell — that surface would be a good Astro fit on its own, without
touching the SPA.

## Status vocabulary note

Per `docs/decisions/README.md`, raw research belongs in `docs/research/` and
plans in `docs/runbooks/`. This file is a **decision record** (a recommendation
against a proposed change), kept here as Draft/Reference so the rationale is
discoverable the next time Astro comes up. If a content-surface migration is
later approved, promote the relevant decision into the live decision docs and
flip this status.
