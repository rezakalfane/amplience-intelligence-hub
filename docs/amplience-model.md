# How Amplience maps to the hub

The analysis pipeline works on a normalized model (content types, items projected per locale, translatable leaves). This page is how the live adapter (`lib/adapters/live-adapter.ts`) builds it from Dynamic Content.

| Amplience | In the hub |
|---|---|
| **Hub** (`/hubs/{id}`) | The scanned workspace. Its localization settings give the locales; `AMPLIENCE_LOCALES` narrows them |
| **Content repositories** | Scanned unless they use item-level locales other than the master (e.g. `contentfr`), or `AMPLIENCE_REPOSITORIES` says otherwise |
| **Content type** (registered) + its **schema** (JSON Schema) | A content type. Its short id is the last segment of the schema URI (`https://content.commerce.com/buying-guide` → `buying-guide`); the label is the registered content type's label |
| `localized-value` property | A **localized** field (`{ values: [{ locale, value }] }`). Plain properties are shared by every locale ("same in all") |
| `format: "markdown"` | A markdown field: translated as a whole string, structure checked by block count |
| Inline object / array of objects | A nested object (each adds a nesting level); array items are addressed by position (`steps[2].title`) |
| `content-link` / `content-reference` | A link to other content items; the allowed types come from `properties.contentType.enum` |
| `image-link` / `video-link` | An asset link (graph node, SEO image facts) |
| `_meta.deliveryKey` | The URL (`deliveryKey`), used by the SEO audit and excluded from translation |
| **Content item** (`status: ACTIVE`) | A source item. Items with an item-level `locale` other than the master are skipped |
| Locale values of one item | The item **projected** to that locale, without fallback. A locale "exists" for an item when at least one localized value has a non-empty value for it |
| `version` | The item version (one per item, shared by every locale). Proposals record it; a save sends it back as an optimistic lock |
| `publishingStatus`, `lastPublishedVersion` | Publication: the source is published when a published version exists; a target locale is published when the **last published version carries that locale's values** (one extra read of `/versions/{n}` for items with unpublished changes) |

## Consequences worth knowing

- **Delivery fallback is never counted as translated.** The storefront asks for `locale=fr-FR,en-US`, so an untranslated field silently shows English; the hub reports it as missing.
- **Field-level localization means one version for all locales.** Editing the English copy changes the item version too, so a pending French proposal asks for re-review. That is deliberate: the source may have changed.
- **Writing a missing translation is a normal save.** There is no separate "localized version" to create: the guarded writer adds the locale's value to the field's localized value (creating the localized value if the field is absent) and saves the item. It never publishes.
- **Bodies often live in linked items.** A blog post's content is a list of links to `text` / `image` / `video` items, and images are `image` items with alt text. The SEO audit follows links one level deep for bodies and alt text.

---
[← Back to README](../README.md) · [All documentation](README.md)
