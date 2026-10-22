# Getting started

```bash
npm install
cp .env.example .env.local        # fill secrets locally; never commit, never paste into chat
npm run dev                        # http://localhost:3000  → /overview
```

- **Demo (offline, no credentials):** choose *DEMO · Sample fixtures* in the hub menu (top right). 5 locales, 4 content types, 56 content items.
- **Live:** set `AMPLIENCE_PAT` and `AMPLIENCE_HUB_ID` (or `AMPLIENCE_HUB_NAME`), ideally `AMPLIENCE_LOCALES` and `AMPLIENCE_MASTER_LOCALE`, then *Integration → Connect & diagnose Amplience* and *Scan Amplience*. A scan of a 300-item hub takes a few seconds and about ten API calls: items are listed once per repository, every locale is read from the same item, and only items whose latest changes are unpublished cost one more call (their published version).
- **Live AI:** set `OPENAI_API_KEY`, `OPENAI_MODEL`, optionally `OPENAI_REASONING_EFFORT`, and `AI_SEND_CONTENT_TO_OPENAI=true` only if the content may go to OpenAI. Then *Integration → Check OpenAI model access*.

---
[← Back to README](../README.md) · [All documentation](README.md)
