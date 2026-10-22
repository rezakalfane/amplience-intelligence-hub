// Read-only: compare the current target-locale values (default fr-FR) with a backup and list differences in translatable text.
import fs from "node:fs";
import path from "node:path";
import type { RawItem } from "../lib/adapters/live-adapter";
import { readItem } from "../lib/adapters/live-adapter";
import { extractLeaves, projectLocale } from "../lib/domain/normalizer";
import type { NormalizedContentType } from "../lib/domain/types";
import { arg, client, TARGET } from "./_amp.mts";

const backup = JSON.parse(fs.readFileSync(path.join(arg(0) as string, "backup.json"), "utf8")) as { contentTypes: NormalizedContentType[]; items: RawItem[] };
const bySchema = new Map(backup.contentTypes.map((c) => [c.schemaId, c]));
let changedItems = 0, changedFields = 0;
for (const raw of backup.items) {
  const ct = bySchema.get(raw.body._meta?.schema);
  if (!ct) continue;
  const now = await readItem(client, raw.id);
  const before = new Map(extractLeaves(ct.schema, projectLocale(raw.body, TARGET)).map((l) => [l.path, l.text]));
  const diffs = extractLeaves(ct.schema, projectLocale(now.body, TARGET)).filter((l) => (before.get(l.path) ?? "") !== l.text);
  if (diffs.length) {
    changedItems++; changedFields += diffs.length;
    console.log(`${ct.uid}/${raw.id}: v${raw.version} → v${now.version}, ${diffs.length} changed value(s): ${diffs.map((d) => `${d.path}=${JSON.stringify(d.text.slice(0, 20))}`).join("; ")}`);
  }
}
console.log(`\n${changedItems} content items differ from the backup (${changedFields} ${TARGET} text values changed)`);
