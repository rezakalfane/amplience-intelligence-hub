# Maintenance scripts (live hub)

These talk to the real hub with the personal access token and are separate from the app's safety model. Saves use `AMPLIENCE_WRITE_PAT` when set, send the item version (Amplience rejects the save if the item changed) and **never publish**. Backups are written to `backups/` (gitignored, contains real content).

```bash
npm run live:scan                                        # read-only smoke test, prints counts only
npm run live:schema                                      # read-only: schema-governance analysis of the live hub
npm run live:seo                                         # read-only: SEO / AI-discoverability audit of the live hub (counts + one example per rule)
npm run amp:backup                                       # read-only: every scanned content item (all locales) and the content types
npm run amp:degrade -- backups/<ts>                      # PREVIEW: remove ~10% of fr-FR text values
npm run amp:degrade -- backups/<ts> --apply              # save the items + degrade-manifest.json
npm run amp:restore -- backups/<ts>                      # PREVIEW restore from the manifest
npm run amp:restore -- backups/<ts> --apply              # put the original values back (only if still absent; --force to override)
npm run amp:diff -- backups/<ts>                         # read-only: what differs from the backup
```

`amp:degrade` exists to make gaps visible for demos (`DEGRADE_LOCALE` changes the locale). The manifest is written incrementally so a crash can still be restored, and `--apply` resumes safely. Removed values make the storefront fall back to English until restored; items whose latest changes were published stay as published until someone publishes them again.

---
[← Back to README](../README.md) · [All documentation](README.md)
