// Remove ~10% of the target locale's text values (default fr-FR) to make gaps visible in the UI.
// Saves the items (new versions), never publishes. Dry run by default.
//   npm run amp:degrade -- <backupDir>            (preview)
//   npm run amp:degrade -- <backupDir> --apply    (save the items)
// Writes <backupDir>/degrade-manifest.json, which scripts/restore-fr.mts uses to put every value back.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { RawItem } from "../lib/adapters/live-adapter";
import { readItem } from "../lib/adapters/live-adapter";
import { extractLeaves, projectLocale } from "../lib/domain/normalizer";
import { getLocalizedText, removeLocalizedText } from "../lib/domain/path";
import type { NormalizedContentType } from "../lib/domain/types";
import { arg, client, flag, TARGET, writeClient } from "./_amp.mts";

const RATE = 10; // percent
const dir = arg(0);
if (!dir) throw new Error("Usage: amp:degrade -- <backupDir> [--apply]");
const backup = JSON.parse(fs.readFileSync(path.join(dir, "backup.json"), "utf8")) as { contentTypes: NormalizedContentType[]; items: RawItem[] };
const apply = flag("apply");
const manifestPath = path.join(dir, "degrade-manifest.json");

const hash = (s: string) => parseInt(createHash("sha1").update(`degrade|${s}`).digest("hex").slice(0, 8), 16) % 100;
const bySchema = new Map(backup.contentTypes.map((c) => [c.schemaId, c]));

interface Pick { path: string; label: string; original: string; mandatory: boolean }
const plan: { contentType: string; id: string; version: number; picks: Pick[] }[] = [];
let candidates = 0;
for (const raw of backup.items) {
  const ct = bySchema.get(raw.body._meta?.schema);
  if (!ct) continue;
  const leaves = extractLeaves(ct.schema, projectLocale(raw.body, TARGET)).filter((l) => !l.nonLocalizable && l.text.trim() && !/\[\d+\]$/.test(l.path));
  candidates += leaves.length;
  const picks = leaves.filter((l) => hash(`${ct.uid}/${raw.id}/${l.path}`) < RATE).map((l) => ({ path: l.path, label: l.label, original: l.text, mandatory: l.mandatory }));
  if (picks.length) plan.push({ contentType: ct.uid, id: raw.id, version: raw.version, picks });
}
const total = plan.reduce((n, p) => n + p.picks.length, 0);
console.log(`${TARGET}: ${candidates} text values, ${total} selected (${((100 * total) / Math.max(1, candidates)).toFixed(1)}%) across ${plan.length} content items`);
const byType: Record<string, number> = {};
for (const p of plan) byType[p.contentType] = (byType[p.contentType] ?? 0) + p.picks.length;
console.log("by content type:", byType, "| required fields:", plan.flatMap((p) => p.picks).filter((x) => x.mandatory).length);
if (!apply) {
  for (const p of plan.slice(0, 8)) console.log(` - ${p.contentType}/${p.id}: ${p.picks.map((x) => x.path).join(", ")}`);
  console.log("\nDRY RUN — nothing written. Re-run with --apply to save the items (never published).");
  process.exit(0);
}

const done: unknown[] = [];
const failed: string[] = [];
for (const p of plan) {
  const item = await readItem(client, p.id);
  if (item.version !== p.version) {
    // Resume support: if every picked value is already gone, an earlier run did this item.
    const already = p.picks.filter((k) => getLocalizedText(item.body, k.path, TARGET) === undefined);
    if (already.length === p.picks.length) {
      done.push({ contentType: p.contentType, id: p.id, locale: TARGET, versionBefore: p.version, versionAfter: item.version, picks: already, note: "already removed by an earlier run" });
      console.log(`already removed: ${already.length} value(s) in ${p.contentType}/${p.id}`);
    } else failed.push(`${p.contentType}/${p.id}: version moved (${p.version} → ${item.version}), skipped`);
    fs.writeFileSync(manifestPath, JSON.stringify({ createdAt: new Date().toISOString(), items: done }, null, 1));
    continue;
  }
  const body = structuredClone(item.body);
  const applied = p.picks.filter((k) => removeLocalizedText(body, k.path, TARGET) !== undefined);
  try {
    // The version makes the save fail (409) if anyone edited the item since it was read.
    await writeClient.patch(`/content-items/${encodeURIComponent(p.id)}`, { body, version: item.version, label: item.label });
    const after = await readItem(client, p.id);
    done.push({ contentType: p.contentType, id: p.id, locale: TARGET, versionBefore: p.version, versionAfter: after.version, picks: applied });
    console.log(`removed ${applied.length} value(s) in ${p.contentType}/${p.id} (v${p.version} → v${after.version})`);
  } catch (err) {
    failed.push(`${p.contentType}/${p.id}: ${(err as Error).message}`);
  }
  fs.writeFileSync(manifestPath, JSON.stringify({ createdAt: new Date().toISOString(), items: done }, null, 1)); // written incrementally so a crash can still be restored
}
console.log(`\nDone: ${done.length} content items modified, ${failed.length} skipped/failed. Manifest: ${manifestPath}`);
for (const f of failed) console.log("  ! " + f);
console.log("Nothing was published. Restore with: npm run amp:restore -- " + dir + " --apply");
