// Read-only smoke test against the real Amplience hub. Usage: npm run live:scan
// Prints counts only (no tokens, no content bodies beyond short source excerpts of the first issues).
import { runScan } from "../lib/scan/scan";
import { buildView } from "../lib/scan/view";
import { adapter, client } from "./_amp.mts";

const t0 = Date.now();
const snap = await runScan(adapter, { baselines: new Map(), maxItemsPerType: 200, concurrency: 3, criticalLocales: [], provenance: "LIVE · Amplience", onProgress: (p) => process.stdout.write(`\r${p.phase} ${p.done}/${p.total}      `) });
const view = buildView(snap, [], new Date());
console.log(`\nstatus=${snap.status} calls=${client.callCount} ms=${Date.now() - t0}`);
console.log("hub:", snap.hub, "repositories:", snap.repositories.join(", "), "locales:", snap.locales.map((l) => l.code).join(", "), "master:", snap.masterLocale);
console.log("types:", snap.contentTypes.map((c) => `${c.uid}=${c.items}`).join(", "));
console.log("units:", snap.units.length, "itemLocales:", snap.itemLocales.length, "errors:", snap.errors.length);
console.log("existence:", Object.entries(snap.itemLocales.reduce<Record<string, number>>((a, e) => ((a[e.existence] = (a[e.existence] ?? 0) + 1), a), {})));
console.log("publication:", Object.entries(snap.itemLocales.reduce<Record<string, number>>((a, e) => ((a[e.publication] = (a[e.publication] ?? 0) + 1), a), {})));
console.log("coverage:", view.kpis.overall, "health:", view.kpis.health, "open:", view.kpis.openIssues, "byRule:", view.kpis.byRule, "bySev:", view.kpis.bySeverity);
console.log("graph:", snap.graph?.nodes.length, "nodes,", snap.graph?.edges.length, "edges");
console.log("sample open:", view.open.slice(0, 5).map((d) => `${d.severity} ${d.ruleIds} ${d.pointer.contentTypeUid}/${d.pointer.itemId} ${d.pointer.locale} ${d.pointer.fieldPath}`));
console.log("errors:", snap.errors.slice(0, 8).map((e) => `${e.scope}: ${e.message}`));
for (const d of view.open.slice(0, 6)) console.log("issue:", d.title, "|", d.fieldLabel, "|", JSON.stringify(d.sourceText.slice(0, 80)), "|", d.evidence.join(" "));
