# Quality and testing

```bash
npm run verify      # lint → typecheck → unit/integration tests → build
npm run test        # Vitest: scoring, fallback semantics, freshness, state machine, validation,
                    #         schema normalization and locale projection, localized-value paths,
                    #         Management API pagination/retry/partial failure (mocked hub), write guards and version lock,
                    #         OpenAI provider (mocked), reference graph, SEO rules/scoring/suggestions (incl. linked items),
                    #         schema governance, deep links
npm run e2e         # Playwright (demo mode): journey, reject, placeholder block, keyboard, filters/CSV, graph, SEO audit, schema governance
                    #   E2E_PORT=3000 reuses a running dev server; PW_CHROMIUM_PATH reuses an installed Chromium
npm run live:scan   # read-only smoke test against the configured hub (counts only)
```

---
[← Back to README](../README.md) · [All documentation](README.md)
