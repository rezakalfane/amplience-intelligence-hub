// Read-only. Saves every scanned content item (raw Management API JSON, all locales) plus the normalized content types.
// Usage: npm run amp:backup      → backups/<timestamp>/backup.json   (gitignored; contains real content)
import fs from "node:fs";
import path from "node:path";
import type { RawItem } from "../lib/adapters/live-adapter";
import { adapter, client, TARGET } from "./_amp.mts";

const ctx = await adapter.getContext();
const contentTypes = await adapter.listContentTypes();
const items: RawItem[] = [];
for (const ct of contentTypes) {
  let n = 0;
  for (let cursor: string | undefined; ; ) {
    const page = await adapter.listSourceItems({ contentTypeUid: ct.uid, cursor });
    for (const it of page.items) {
      const raw = adapter.rawItem(it.uid);
      if (raw) { items.push(raw); n++; }
    }
    cursor = page.cursor;
    if (!cursor) break;
  }
  process.stdout.write(`${ct.uid}: ${n} items\n`);
}

const dir = path.join("backups", new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "backup.json"), JSON.stringify({ createdAt: new Date().toISOString(), hub: ctx.hub, hubId: ctx.hubId, masterLocale: ctx.masterLocale, targetLocale: TARGET, contentTypes, items }));
fs.chmodSync(path.join(dir, "backup.json"), 0o600);
console.log(`\nSaved ${items.length} content items → ${dir}/backup.json  [${client.callCount} API calls]`);
