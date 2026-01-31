# Diff — AI-Powered GitHub PR Analyzer

A client-side web app that analyzes GitHub Pull Requests using Google's Gemini API, providing AI-generated code review insights including risk assessment, diff notes, and complexity hotspots.

## Features

- **PR Analysis** — Enter a GitHub repo and PR number to fetch PR data and diffs via the GitHub API
- **AI Code Review** — Analyzes code changes with Gemini 1.5 Flash, returning structured feedback
- **Risk Assessment** — Identifies risks categorized by severity (low / medium / high) and type (security, breaking changes, testing gaps)
- **Diff Notes** — Annotated observations on specific files and lines, classified as logic, mechanical, or style
- **Hotspot Detection** — Flags files with high complexity or critical changes
- **Progressive Web App** — Installable, offline-capable PWA with service worker support
- **Demo Mode** — Falls back to mock data when API keys are not configured, so you can explore the UI without credentials

## Tech Stack

| Layer | Tools |
|-------|-------|
| Framework | React 19, TypeScript 5.9 |
| Build | Vite 7 |
| Styling | Tailwind CSS 3, Radix UI primitives |
| UI Components | shadcn/ui-based component library (60+ components) |
| Forms | React Hook Form, Zod validation |
| APIs | GitHub REST API, Google Gemini API |

## Getting Started

### Prerequisites

- Node.js (v18+)
- npm

### Installation

```bash
cd app
npm install
```

### Environment Variables

Create a `.env` file in the `app/` directory:

```env
VITE_GITHUB_TOKEN=your_github_token       # Optional — increases GitHub API rate limits
VITE_GITHUB_CLIENT_ID=your_client_id      # Optional — enables GitHub OAuth login
VITE_GITHUB_OAUTH_PROXY=https://your-proxy.example.com/oauth/github
VITE_GEMINI_API_KEY=your_gemini_api_key   # Required for real AI analysis
```

Without these keys the app runs in demo mode using mock data.

To use GitHub OAuth you need a small proxy service to exchange the OAuth code
for an access token (GitHub does not allow client-side token exchange). The
`VITE_GITHUB_OAUTH_PROXY` endpoint should accept a POST with `{ code, redirect_uri }`
and return `{ access_token }`.

### Development

```bash
npm run dev
```

### Build

```bash
npm run build
npm run preview   # preview the production build locally
```

### Lint

```bash
npm run lint
```

## Project Structure

```
app/
├── public/                 # PWA assets (manifest, service worker, icons)
├── src/
│   ├── components/ui/      # Reusable UI components (shadcn/ui)
│   ├── hooks/
│   │   ├── useGitHub.ts    # GitHub API data fetching
│   │   ├── useAnalysis.ts  # Gemini analysis orchestration
│   │   └── use-mobile.ts   # Mobile viewport detection
│   ├── lib/
│   │   ├── gemini.ts       # Gemini API client & prompt engineering
│   │   └── utils.ts        # Utility helpers
│   ├── sections/
│   │   ├── HomeScreen.tsx   # Input form (repo + PR number)
│   │   ├── RunningScreen.tsx# Loading / progress indicator
│   │   └── ResultsScreen.tsx# Analysis results display
│   ├── types/index.ts       # TypeScript type definitions
│   ├── App.tsx              # Root component & screen routing
│   └── main.tsx             # React entry point
├── index.html               # HTML shell & PWA registration
├── vite.config.ts
├── tailwind.config.js
└── tsconfig.json
```

## How It Works

1. **Input** — User provides a GitHub repository (`owner/repo`) and PR number
2. **Fetch** — The app calls the GitHub API to retrieve PR metadata, changed files, and the unified diff
3. **Analyze** — The diff (capped at 10k characters) is sent to Gemini 1.5 Flash with a structured review prompt
4. **Display** — Results are rendered in collapsible sections: summary, risks, diff notes, and hotspots

## License

This project is private and not currently licensed for redistribution.
