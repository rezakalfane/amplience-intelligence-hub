# PLAN — Amplience Intelligence Hub

> **Status (22 Oct 2026):** built on Amplience with the full feature set: live read-only scan, OpenAI proposals, review/audit, offline demo, Reference Impact Graph, SEO & AI audit, schema governance, deep links, guarded writer (off by default), scan progress/cancel, maintenance scripts. Verified against the live `commercedemo` hub. Not built: auth, database, scheduled scans, GA4/BigCommerce.

## Architecture

```
lib/domain      pure logic (no I/O): types, schema normalization + locale projection, localized-value paths, markdown,
                rules, scoring, graph, SEO, schema governance, review state machine, deep links
lib/adapters    ContentAdapter interface · demo-adapter (fixtures) · live-adapter (Management API, read-only) · live-writer (guarded)
lib/scan        runScan(): adapter output -> translatable units -> diagnostics -> Snapshot (same code for live and demo)
lib/ai          prompt, Zod validation, placeholder/glossary checks, pricing, OpenAI Responses client (server only)
lib/security    env (Zod), request guard (same-origin + header), write policy
lib/store       JSON store (.data/ locally, private Vercel Blob when connected): snapshots, proposals, audit events, scan progress
app/api         sync (start/status/cancel) · translation/{propose,review,apply} · seo/propose · diagnose · mode · status
app/(product)   overview · localization · health · seo · schema · graph · insights · roadmap · settings
```

Key decisions
- **Management API via a thin typed fetch client** (no SDK): one fixed host, Bearer PAT, HAL paging, retry/backoff+jitter on 429/5xx with `Retry-After`, timeouts, cancellation. Writes are single-attempt.
- **List once, project per locale.** Field-level localization keeps every locale in one item, so the adapter lists each repository once and projects items to each locale locally (no fallback). See [How Amplience maps to the hub](amplience-model.md).
- **One analysis pipeline.** The demo adapter emits the same normalized shapes as the live adapter, so KPIs are always *computed*, never hardcoded.
- **Orthogonal statuses**: existence / completeness / freshness / publication / proposal state are separate fields.
- **Freshness** is `unknown` unless an approved-source fingerprint baseline exists (created when a reviewer approves a proposal).
- **Approve ≠ write.** Approve stores the decision. "Apply to demo" mutates only the demo overlay. Live save is disabled (`ENABLE_CMS_WRITES=false`) and guarded; it uses the item version as Amplience's optimistic lock and never publishes.
- **Mode switch** is a cookie (`hub_mode`) and every page shows `LIVE · Amplience` vs `DEMO · Sample fixtures` + scan time.

## Next
Postgres + Drizzle for review/audit, real auth and per-actor permissions, scheduled scans, item-level localization support, edition/slot awareness (what goes live when), a Dynamic Content extension or dashboard embedding, GA4/BigCommerce impact.
