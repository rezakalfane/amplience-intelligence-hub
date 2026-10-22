# Safety model

- Secrets only in `.env.local`, read in server modules. Nothing uses `NEXT_PUBLIC_`; `/api/status` returns booleans/labels only; errors never include headers.
- Only the Management API host (`https://api.amplience.net/v2/content`) is called; the browser cannot supply URLs.
- Mutating routes require same-origin and an `x-hub-request` header. **This is not user authentication**: it is a single-user local prototype. Production needs real sessions, roles and per-actor permissions.
- **Approve ≠ write ≠ publish.** Approval needs non-empty text, no placeholder/markup mismatch, and an unchanged source fingerprint (409 otherwise).
- Guarded writer requirements: `ENABLE_CMS_WRITES=true`, a separate `AMPLIENCE_WRITE_PAT`, the item in `CMS_WRITE_ALLOWED_ITEM_IDS`, explicit confirmation in a modal, a fresh re-read of the item and its schema, source fingerprint + item version checks, a change to **one locale's value of one localized field** (fields that are not localized are never written), and read-back verification before a proposal becomes `written`. The save sends the item version, so **Amplience itself rejects it (409) if the item changed in between**. After a conflict the reviewer can **re-review against the current CMS state**. Nothing is published.
- The review panel lists exactly which write conditions are unmet.
- Review/audit state, scan progress and the last live snapshot are stored as JSON in `.data/` (gitignored) locally, or as **private** Vercel Blob objects under `hub/` when a Blob store is connected (`BLOB_STORE_ID` or `BLOB_READ_WRITE_TOKEN`; required on Vercel, where the filesystem is read-only and instances share no memory). The live snapshot contains source/target text; delete `.data/` or the `hub/` blobs to purge.

---
[← Back to README](../README.md) · [All documentation](README.md)
