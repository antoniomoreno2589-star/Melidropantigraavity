# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start Vite dev server (HTTPS + ngrok tunnel configured)
npm run build     # TypeScript compile + Vite production build
npm run preview   # Preview production build locally
```

No test suite exists in this project.

## Architecture

**Melidrop** is a React + Vite SPA for Amazon-to-Mercado Libre dropshipping automation.

### Stack
- **React 19 + React Router DOM 7** (HashRouter, client-side only)
- **Vite 6 + TypeScript 5.8**
- **Supabase** — auth, credential storage, settings persistence
- **No global state manager** — plain `useState` + `localStorage` for caching

### Directory roles
| Path | Purpose |
|------|---------|
| `App.tsx` | Route definitions (HashRouter) |
| `types.ts` | Shared TypeScript interfaces (`Product`, `Order`, `User`, `DashboardStats`, etc.) |
| `components/` | One file per page/view + the `AmazonImporter/` sub-module |
| `services/` | All external API logic — `meliService`, `amazonService`, `aiImporterService`, `supabase` |
| `api/` | Vercel serverless proxy handler |
| `supabase/` | DB schema migrations |

### Key routes
`/dashboard` · `/amazon-importer` · `/catalog` · `/orders` · `/settings` · `/analytics` · `/communications` · `/security-history`

### AmazonImporter module (`components/AmazonImporter/`)
Refactored 5-step wizard — original monolith lives at `components/AmazonImporter.tsx` (untouched; the modular version is the `AmazonImporter/` directory):

| File | Role |
|------|------|
| `index.tsx` | Orchestrator — auth guard, calls `useAmazonImporter`, spreads hook to step components |
| `useAmazonImporter.ts` | All wizard state + handlers (single source of truth) |
| `steps/StepsConfig.tsx` | Steps 1–3 JSX (`Step1Config`, `Step2Asins`, `Step3AI`) |
| `steps/StepsReview.tsx` | Steps 4–5 JSX (`Step4Attributes`, `Step5Publish`) |
| `StepIndicator.tsx` | Progress bar UI |
| `types.ts` | Wizard-local types (`Marketplace`, `ListingType`, `Step`, `LoadedProduct`) |

Step components type their props as `ReturnType<typeof useAmazonImporter>` and receive the entire hook via `{...hook}` spread.

### Credential flow
Amazon and Mercado Libre credentials are entered by the user in `/settings`, persisted to Supabase, and loaded at startup by `amazonService` / `meliService`. `amazonService.isAuthenticated()` is the gate used before showing the importer.
