# Configuration

Set these in `.env.local` (copy from `.env.example`). Secrets are read only in server modules; never use `NEXT_PUBLIC_` for them.

| Variable | Purpose |
|---|---|
| `DATA_MODE` | `live` (default when configured) or `demo` |
| `AMPLIENCE_PAT` | Personal access token used for every read. It carries its user's permissions, so prefer a user with read-only access. Only `https://api.amplience.net` is ever called |
| `AMPLIENCE_HUB_ID` / `AMPLIENCE_HUB_NAME` | The hub to scan (id preferred). The name is also used for deep links into the Dynamic Content app |
| `AMPLIENCE_MASTER_LOCALE` | Source locale (default: the first scanned locale) |
| `AMPLIENCE_LOCALES` | Comma-separated subset of the hub's locales (Settings → Localization). Default: every hub locale. A hub often enables locales nobody uses yet; list only the markets you ship |
| `AMPLIENCE_REPOSITORIES` | Comma-separated repository names. Default: repositories that have content types and no item-level locale other than the master |
| `OPENAI_MODEL`, `OPENAI_REASONING_EFFORT` | Model and effort. **Effort is read from env only** and recorded on every proposal with reasoning tokens |
| `OPENAI_PRICE_INPUT_PER_MTOK`, `OPENAI_PRICE_OUTPUT_PER_MTOK` | USD per 1M tokens, taken from OpenAI's pricing page for your model. Unset ⇒ cost shows `—`, never `$0`. Cached-input discounts are not modelled |
| `AI_SEND_CONTENT_TO_OPENAI` | Must be `true`, plus per-field consent in the UI, before any CMS text is sent |
| `ENABLE_CMS_WRITES`, `AMPLIENCE_WRITE_PAT`, `CMS_WRITE_ALLOWED_ITEM_IDS` | All three are required for the guarded save. Default: off |
| `ENABLE_CMS_PUBLISH` | Ignored. Publishing does not exist in this build |
| `SCAN_MAX_ITEMS_PER_TYPE`, `CRITICAL_LOCALES`, `HUB_ACTOR_ID` | Scan bound (disclosed in the UI), priority markets (codes as the hub spells them, e.g. `fr-FR`), reviewer identity for the audit trail |
| `BLOB_STORE_ID` / `BLOB_READ_WRITE_TOKEN` | Optional: a private Vercel Blob store for review state and snapshots (required on Vercel). Use a store of its own; do not share one with another hub app |

---
[← Back to README](../README.md) · [All documentation](README.md)
