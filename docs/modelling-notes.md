# Modelling notes

Domain decisions and findings from running against a real Amplience hub (`commercedemo`, 21 content types, ~300 items).

- Existence, completeness, freshness, publication and proposal state are separate fields.
- Delivery fallback is never counted as localized: presence comes from the item's own localized values.
- Field-level localization keeps every locale in one item, so the whole scan is a handful of list calls (no per-locale requests). Array items have no stable instance ids, so they are matched by position.
- Publication is per item, but a locale can still be unpublished: its values may have been added after the last publish. The hub compares against the last published version.
- Hubs enable locales nobody uses yet (`de-DE`, `es-ES`, `it-IT` on `commercedemo`); without `AMPLIENCE_LOCALES` they show as 0% markets.
- Content types are mostly small components linked from pages; the risk and blast-radius views matter more than per-type width.
- Freshness is `unknown` unless an approval baseline exists (created when you approve a proposal). Never guessed.
- "Identical to source" is flagged as *possibly untranslated*; product names may legitimately be unchanged, so a reviewer decides.
- Policy exclusions (identifier-like fields, delivery keys, `account`, enums, fields that are not localized) are disclosed in the UI.

---
[← Back to README](../README.md) · [All documentation](README.md)
