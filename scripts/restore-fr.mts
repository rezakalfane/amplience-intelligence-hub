// Put back exactly the values that degrade-fr removed, using the manifest. Saves the items, never publishes.
// A value is restored only if it is still absent or empty (i.e. nobody translated it since); use --force to override.
//   npm run amp:restore -- <backupDir>            (preview)
//   npm run amp:restore -- <backupDir> --apply
import fs from "node:fs";
import path from "node:path";
import { readItem } from "../lib/adapters/live-adapter";
import { getLocalizedText, setLocalizedText } from "../lib/domain/path";
import { arg, client, flag, TARGET, writeClient } from "./_amp.mts";

const dir = arg(0);
if (!dir) throw new Error("Usage: amp:restore -- <backupDir> [--apply] [--force]");
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "degrade-manifest.json"), "utf8")) as {
  items: { contentType: string; id: string; picks: { path: string; original: string }[] }[];
};
const apply = flag("apply"), force = flag("force");

let restored = 0, skipped = 0, failed = 0;
for (const m of manifest.items) {
  const item = await readItem(client, m.id);
  const body = structuredClone(item.body);
  const todo: typeof m.picks = [];
  for (const k of m.picks) {
    const current = getLocalizedText(body, k.path, TARGET);
    if (current === k.original) { skipped++; console.log(`  skip ${m.id} ${k.path}: already restored`); continue; }
    if (!force && current !== undefined && current !== "") { skipped++; console.log(`  skip ${m.id} ${k.path}: has a value again (edited since?) — use --force to overwrite`); continue; }
    if (!setLocalizedText(body, k.path, TARGET, k.original)) { failed++; console.log(`  ! ${m.id} ${k.path}: path no longer resolves`); continue; }
    todo.push(k);
  }
  if (!todo.length) continue;
  if (!apply) { console.log(`would restore ${todo.length} value(s) in ${m.contentType}/${m.id}`); restored += todo.length; continue; }
  try {
    await writeClient.patch(`/content-items/${encodeURIComponent(m.id)}`, { body, version: item.version, label: item.label });
    const after = await readItem(client, m.id);
    const ok = todo.every((k) => getLocalizedText(after.body, k.path, TARGET) === k.original);
    console.log(`${ok ? "restored" : "UNVERIFIED"} ${todo.length} value(s) in ${m.contentType}/${m.id}`);
    restored += todo.length;
    if (!ok) failed++;
  } catch (err) { failed++; console.log(`  ! ${m.contentType}/${m.id}: ${(err as Error).message}`); }
}
console.log(`\n${apply ? "Restored" : "Would restore"} ${restored} value(s); skipped ${skipped}; failed ${failed}.${apply ? "" : " DRY RUN — re-run with --apply."}`);
