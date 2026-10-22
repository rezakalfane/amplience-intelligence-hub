import type { ContentAdapter } from "@/lib/adapters/content-adapter";
import { buildGraph } from "@/lib/domain/graph";
import { computeFieldUsage } from "@/lib/domain/schema-governance";
import { extractSeoFacts } from "@/lib/domain/seo";
import { buildUnits } from "@/lib/domain/rules";
import { EXCLUSION_POLICY_NOTE } from "@/lib/domain/normalizer";
import type { NormalizedItem, ScanError, ScanProgress, Snapshot } from "@/lib/domain/types";
import { mapPool, ScanAbortedError } from "@/lib/utils/pool";

export interface ScanOptions {
  signal?: AbortSignal;
  onProgress?: (p: ScanProgress) => void;
  /** Approval baselines recorded by this tool (unit key -> fingerprint). */
  baselines: Map<string, string>;
  maxItemsPerType: number;
  concurrency: number;
  criticalLocales: string[];
  provenance: string;
  now?: () => Date;
}

const MAX_PAGES = 200;

export async function runScan(adapter: ContentAdapter, opts: ScanOptions): Promise<Snapshot> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const errors: ScanError[] = [];
  const limits: string[] = [];
  const progress: ScanProgress = { state: "running", phase: "Connecting", done: 0, total: 0, startedAt, errors };
  const emit = (patch: Partial<ScanProgress>) => opts.onProgress?.(Object.assign(progress, patch));
  const check = () => {
    if (opts.signal?.aborted) throw new ScanAbortedError();
  };

  emit({ phase: "Reading hub settings", percent: 2 });
  const ctx = await adapter.getContext();
  check();

  emit({ phase: "Reading content types", percent: 6 });
  const allTypes = await adapter.listContentTypes();
  check();

  // Source items (master-locale projection), bounded + paginated.
  emit({ phase: "Listing content items", percent: 10 });
  const sourceItems: NormalizedItem[] = [];
  const counts = new Map<string, number>();
  const truncatedTypes = new Set<string>();
  const failedTypes = new Set<string>();
  for (const ct of allTypes) {
    let cursor: string | undefined;
    let n = 0;
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        check();
        const res = await adapter.listSourceItems({ contentTypeUid: ct.uid, cursor });
        for (const e of res.items) {
          if (n >= opts.maxItemsPerType) break;
          sourceItems.push(e);
          n++;
        }
        if (n >= opts.maxItemsPerType && (res.cursor || (res.total ?? 0) > n)) {
          truncatedTypes.add(ct.uid);
          limits.push(`${ct.title}: first ${opts.maxItemsPerType} of ${res.total ?? "more"} content items scanned (SCAN_MAX_ITEMS_PER_TYPE).`);
          break;
        }
        cursor = res.cursor;
        if (!cursor) break;
      }
    } catch (err) {
      if (err instanceof ScanAbortedError) throw err;
      failedTypes.add(ct.uid);
      errors.push({ scope: `content type ${ct.uid}`, message: errMsg(err) });
    }
    counts.set(ct.uid, n);
  }

  // Locale presence + locale projections of every source item.
  const targetLocales = ctx.locales.filter((l) => l.code !== ctx.masterLocale);
  const presence = new Map<string, Map<string, boolean>>();
  const targets = new Map<string, NormalizedItem>();
  emit({ phase: "Checking locale values", done: 0, total: sourceItems.length, percent: 20 });
  let done = 0;
  await mapPool(sourceItems, opts.concurrency, async (entry) => {
    const id = `${entry.contentTypeUid}/${entry.uid}`;
    try {
      const localizedCodes = new Set(await adapter.getLocalePresence({ contentTypeUid: entry.contentTypeUid, itemId: entry.uid }));
      const map = new Map<string, boolean>();
      for (const l of targetLocales) map.set(l.code, localizedCodes.has(l.code));
      presence.set(id, map);
      for (const l of targetLocales) {
        if (!localizedCodes.has(l.code)) continue;
        try {
          const t = await adapter.getLocalizedItem({
            hubId: ctx.hubId ?? ctx.hub, contentTypeUid: entry.contentTypeUid, itemId: entry.uid, locale: l.code, fieldPath: "",
          });
          if (t) targets.set(`${id}/${l.code}`, t);
          else errors.push({ scope: `${id} (${l.code})`, message: "Locale values were found but the item could not be projected to the locale" });
        } catch (err) {
          if (err instanceof ScanAbortedError) throw err;
          errors.push({ scope: `${id} (${l.code})`, message: errMsg(err) });
        }
      }
    } catch (err) {
      if (err instanceof ScanAbortedError) throw err;
      errors.push({ scope: `${id} locales`, message: errMsg(err) });
    }
    emit({ done: ++done, percent: 20 + Math.round((75 * done) / Math.max(1, sourceItems.length)) });
  }, opts.signal);

  emit({ phase: "Analysing fields", percent: 96 });
  const baselines = new Map([...(adapter.getApprovalBaselines?.() ?? []), ...opts.baselines]);
  const { units, itemLocales } = buildUnits({
    hubId: ctx.hubId ?? ctx.hub, masterLocale: ctx.masterLocale, locales: ctx.locales, contentTypes: allTypes,
    sourceItems, presence, targets, baselines,
  });

  const completeTypes = new Set(allTypes.map((c) => c.uid).filter((u) => !truncatedTypes.has(u) && !failedTypes.has(u)));
  const graph = buildGraph({ contentTypes: allTypes, entries: sourceItems, completeTypes });
  graph.note = `References are read from ${ctx.masterLocale} content items (content links and references, image and video links).${truncatedTypes.size || failedTypes.size ? " Some content types were not fully scanned; their targets are shown as unverified rather than broken." : ""}`;

  const ctByUid = new Map(allTypes.map((c) => [c.uid, c]));
  const itemById = new Map(sourceItems.map((e) => [e.uid, e]));
  const resolve = (id: string) => {
    const item = itemById.get(id);
    const ct = item ? ctByUid.get(item.contentTypeUid) : undefined;
    return item && ct ? { ct, item } : undefined;
  };
  const seo = sourceItems.flatMap((e) => {
    const ct = ctByUid.get(e.contentTypeUid);
    return ct ? [extractSeoFacts(ct, e, resolve)] : [];
  });

  const unknown = itemLocales.filter((e) => e.existence === "unknown").length;
  if (unknown) errors.push({ scope: "coverage", message: `${unknown} item×locale combination(s) have unknown localization state and are excluded from coverage.` });

  return {
    mode: adapter.kind,
    provenance: opts.provenance,
    hub: ctx.hub, hubId: ctx.hubId, repositories: ctx.repositories, masterLocale: ctx.masterLocale, locales: ctx.locales,
    contentTypes: allTypes.map((c) => ({ uid: c.uid, title: c.title, items: counts.get(c.uid) ?? 0 })),
    sourceItemCount: sourceItems.length,
    startedAt, completedAt: now().toISOString(),
    status: errors.length ? "partial" : "complete",
    errors, limits, units, itemLocales, graph, seo, schemas: allTypes, fieldUsage: computeFieldUsage(allTypes, sourceItems),
    policy: { criticalLocales: opts.criticalLocales, exclusions: EXCLUSION_POLICY_NOTE },
  };
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}
