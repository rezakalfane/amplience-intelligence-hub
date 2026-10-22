// Read-only: scan the live hub and print the SEO / AI-discoverability audit (counts and short evidence only).
import { auditSeo, scoreSeo } from "../lib/domain/seo";
import { runScan } from "../lib/scan/scan";
import { adapter } from "./_amp.mts";

const snap = await runScan(adapter, { baselines: new Map(), maxItemsPerType: 200, concurrency: 3, criticalLocales: [], provenance: "LIVE" });
const facts = snap.seo ?? [];
const findings = auditSeo(facts);
const s = scoreSeo(facts, findings);
console.log(`items=${facts.length} pageLike=${facts.filter((f) => f.pageLike).length} articleLike=${facts.filter((f) => f.articleLike).length} faqLike=${facts.filter((f) => f.faqLike).length} productLike=${facts.filter((f) => f.productLike).length}`);
console.log(`SEO score=${s.seo} (${s.seoEntries} items)  AI score=${s.ai} (${s.aiEntries} items)  findings=${findings.length}`);
const by: Record<string, number> = {};
for (const f of findings) by[f.ruleId] = (by[f.ruleId] ?? 0) + 1;
console.log("by rule:", by);
const seen = new Set<string>();
for (const f of findings) if (!seen.has(f.ruleId)) { seen.add(f.ruleId); console.log(` ${f.ruleId} [${f.severity}] ${f.contentTypeUid} · ${f.title.slice(0, 40)} → ${f.message} | ${f.evidence[0]?.slice(0, 90)}`); }
