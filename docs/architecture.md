# Architecture and code layout

**Stack:** Next.js 16 (App Router) · TypeScript (strict) · Tailwind 4 · shadcn-style UI (Radix) · Recharts · d3-force/zoom · TanStack Table · Zod · Vitest · Playwright.

`lib/domain` pure logic (schema normalization and locale projection, rules, scoring, graph, review state machine, localized-value paths, markdown, deep links) · `lib/adapters` demo/live adapters, Management API client, guarded writer · `lib/scan` pipeline and view · `lib/ai` prompt, provider, validation, pricing · `lib/security` env, request guard, write policy · `lib/store` JSON store · `app/api` routes · `components/*` UI · `scripts/` live smoke test and maintenance scripts · `tests/` unit + integration · `e2e/` Playwright. See [PLAN.md](PLAN.md) and [How Amplience maps to the hub](amplience-model.md).

---
[← Back to README](../README.md) · [All documentation](README.md)
