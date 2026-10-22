# What is real, what is simulated

Honest boundaries of this prototype.

| Piece | Status |
|---|---|
| Amplience Management API reads (hub, locales, repositories, content type schemas, content items, published versions) | **Real**, read-only, server-side, verified against the live `commercedemo` hub (299 items, 21 content types, 8 API calls) |
| Coverage / health / issue rules / graph | Real computation over whichever dataset is loaded |
| Schema governance | **Real** analysis of real schemas, field usage and content links (verified on the live hub). Recommendations only; the tool never edits a schema |
| SEO & AI audit | **Real** rules over real master-locale items, following links to text and image items (verified on the live hub). Suggestions are **simulated** in demo and OpenAI in live (verified against a mocked API only). No live write-back for SEO text; copy the approved text |
| OpenAI proposals | **Real** when configured and consented. Code is verified against a mocked Responses API; run it with your own key to verify live |
| DEMO data and DEMO proposals | **Simulated** (sample phrase bank), always labelled |
| "Apply to demo" | Changes only the local demo overlay (`.data/demo.json`) |
| Live CMS save | Implemented as a guarded, single-value writer with Amplience's version lock; **disabled by default**; unit-tested with a mocked API; see [Safety model](safety.md) |
| Publishing | **Does not exist** |
| Trend chart | Live: recorded scan history. Demo: labelled *illustrative* |
| GA4 / BigCommerce impact | Not implemented; clearly marked future |

## Known limitations

No authentication or database (local JSON; Postgres + real sessions are the production path) · live save path not exercised end-to-end against a hub · OpenAI path not exercised live unless you add a key · scan is bounded and in-process (no scheduler) · links are read from the master locale · item-level localization (a separate item per locale) is not analysed · slots and editions are scanned as content items, without their schedules · deep-link URL shapes follow the Dynamic Content app's hash routes and were not click-tested on every account.

---
[← Back to README](../README.md) · [All documentation](README.md)
