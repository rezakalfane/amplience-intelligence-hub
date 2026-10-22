import { shortId } from "./fingerprint";
import { shortTypeId } from "./normalizer";
import type {
  FieldUsageRow, NormalizedContentType, NormalizedItem, ReferenceGraph, SchemaField, Severity,
} from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export const GOV = {
  minEntriesForUsage: 5,
  rareFillRatio: 0.1,
  rareMinEntries: 10,
  deepNesting: { medium: 4, high: 5 },
  wide: { low: 25, medium: 40 },
  manyBlockTypes: 12,
  broadReferenceTargets: 5,
  sharedFieldsMin: 3,
  complexityBands: { medium: 25, high: 60 },
  riskBands: { medium: 30, high: 60 },
};
export const PENALTY: Record<Severity, number> = { critical: 20, high: 15, medium: 8, low: 3 };

export const SCHEMA_RULES: Record<string, { title: string; logic: string; severity: string }> = {
  "SCH-001": { title: "Unused or rarely used field", severity: "medium / low", logic: `Never populated across ≥${GOV.minEntriesForUsage} content items (medium), or populated in under ${GOV.rareFillRatio * 100}% of ≥${GOV.rareMinEntries} items (low)` },
  "SCH-002": { title: "Repeated structure", severity: "medium", logic: `The same object of ≥3 fields appears in several places, or ≥${GOV.sharedFieldsMin} identical fields are repeated across content types: a candidate for a shared partial (definitions/$ref) or its own content type` },
  "SCH-003": { title: "Deep nesting", severity: "medium / high", logic: `Inline objects nested ${GOV.deepNesting.medium}+ levels (medium) or ${GOV.deepNesting.high}+ (high): hard to edit in the content form and heavy to deliver` },
  "SCH-004": { title: "Wide content type", severity: "low / medium", logic: `More than ${GOV.wide.low} fields (low) or ${GOV.wide.medium} (medium)` },
  "SCH-005": { title: "Link palette bloat", severity: "medium / low", logic: `A content link (e.g. a page's component list) accepts more than ${GOV.manyBlockTypes} content types, or an allowed content type is never linked` },
  "SCH-006": { title: "Near-duplicate field names", severity: "low", logic: "Two fields of the same type whose names differ only by a seo/meta/og prefix, so editors must guess which to fill (title/metaTitle is exempt)" },
  "SCH-007": { title: "Generic field name", severity: "low", logic: "Property name such as field1, newField, untitled, test: unclear intent and brittle to integrate" },
  "SCH-008": { title: "Empty content type", severity: "low", logic: "No content items in the scanned repositories: candidate for retirement (or a template not yet used)" },
  "SCH-009": { title: "Broken or broad content link", severity: "high / low", logic: `A content link allows a content type that is not registered in the hub (high), or more than ${GOV.broadReferenceTargets} types (low)` },
  "SCH-010": { title: "Localization setting looks wrong", severity: "medium / low", logic: "Translatable-looking text (headline, description, label…) is not a localized value (medium), or an identifier (sku, id, slug, code…) is localized (low). `title` is exempt (often an internal name)" },
  "SCH-011": { title: "Fragile core type", severity: "medium", logic: "High complexity combined with high change risk: changes here are expensive and need a migration plan" },
};

// ---------- Schema walking ----------

export interface FlatField {
  path: string;
  field: SchemaField;
  /** 1 = top-level. Each inline object adds a level. */
  depth: number;
  kind: "leaf" | "object";
  parent?: string;
}

export function flattenSchema(schema: SchemaField[], prefix = "", depth = 1, parent?: string): FlatField[] {
  return schema.flatMap((f) => {
    const path = prefix ? `${prefix}.${f.uid}` : f.uid;
    const self: FlatField = { path, field: f, depth, parent, kind: f.dataType === "object" ? "object" : "leaf" };
    if (f.schema && f.dataType === "object") return [self, ...flattenSchema(f.schema, path, depth + 1, path)];
    return [self];
  });
}

// ---------- Field usage (computed during the scan from real content items) ----------

function filled(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (typeof v === "boolean") return v; // an untouched boolean is false
  if (Array.isArray(v)) return v.some(filled);
  if (isObj(v)) return typeof v.id === "string" || Object.values(v).some(filled); // links / assets carry an id
  return true;
}

/** Schema paths that hold a value in this content item. Array items collapse to their schema path. */
export function presentPaths(schema: SchemaField[], values: Obj, prefix = "", out = new Set<string>()): Set<string> {
  for (const f of schema) {
    const v = values?.[f.uid];
    const path = prefix ? `${prefix}.${f.uid}` : f.uid;
    if (v === undefined || v === null) continue;
    if (f.dataType === "object") {
      const items = ([] as unknown[]).filter.call(([] as unknown[]).concat(v), isObj) as Obj[];
      if (items.length) {
        let any = false;
        for (const it of items) { const before = out.size; presentPaths(f.schema ?? [], it, path, out); if (out.size > before) any = true; }
        if (any) out.add(path);
      }
    } else if (f.dataType === "reference") {
      for (const item of ([] as unknown[]).concat(v)) {
        if (!isObj(item) || typeof item.id !== "string") continue;
        out.add(path);
        if (typeof item.contentType === "string") out.add(`${path}→${item.contentType}`); // which allowed types are actually linked (SCH-005)
      }
    } else if (filled(v)) out.add(path);
  }
  return out;
}

export function computeFieldUsage(contentTypes: NormalizedContentType[], items: NormalizedItem[]): FieldUsageRow[] {
  const rows: FieldUsageRow[] = [];
  for (const ct of contentTypes) {
    const mine = items.filter((e) => e.contentTypeUid === ct.uid);
    const counts = new Map<string, number>();
    for (const e of mine) for (const p of presentPaths(ct.schema, e.values)) counts.set(p, (counts.get(p) ?? 0) + 1);
    const flat = flattenSchema(ct.schema);
    for (const f of flat) rows.push({ contentTypeUid: ct.uid, path: f.path, filled: counts.get(f.path) ?? 0, total: mine.length });
    // Per allowed link target (`components→https://…/hero-banner`), for SCH-005.
    for (const f of flat.filter((x) => x.field.dataType === "reference")) {
      for (const [k, n] of counts) if (k.startsWith(`${f.path}→`)) rows.push({ contentTypeUid: ct.uid, path: k, filled: n, total: mine.length });
    }
  }
  return rows;
}

// ---------- Analysis ----------

export interface SchemaFinding {
  id: string;
  ruleId: string;
  severity: Severity;
  contentTypeUid: string;
  contentTypeTitle: string;
  fieldPath?: string;
  message: string;
  evidence: string[];
  recommendation: string;
  penalty: number;
}

export interface TypeReport {
  uid: string;
  title: string;
  items: number;
  fields: number; // leaf fields
  maxDepth: number;
  objects: number;
  /** Content types a content link may point at, summed over link fields. */
  linkTargets: number;
  references: number;
  mandatory: number;
  complexity: number;
  complexityBand: "low" | "medium" | "high";
  inbound: { items: number; types: number };
  risk: { score: number; band: "low" | "medium" | "high"; rationale: string[] };
  findings: number;
  score: number;
  fieldRows: (FlatField & { filled: number; total: number })[];
}

export interface SimilarityPair { a: string; b: string; shared: string[]; score: number }

export interface SchemaAnalysis {
  types: TypeReport[];
  findings: SchemaFinding[];
  similarity: SimilarityPair[];
  score: number | null;
  totals: { types: number; fields: number; items: number };
}

const band = (v: number, b: { medium: number; high: number }): "low" | "medium" | "high" => (v >= b.high ? "high" : v >= b.medium ? "medium" : "low");
const sig = (f: SchemaField[]) => f.map((x) => `${x.uid}:${x.dataType}`).sort().join("|");
/** camelCase / kebab-case -> snake_case, so naming rules read the same whatever the schema's convention. */
const snake = (uid: string) => uid.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();
const tokens = (uid: string) => snake(uid).split("_").filter((t) => !["seo", "meta", "og"].includes(t)).join("_");
const TRANSLATABLE = /^(headline|heading|description|summary|tagline|label|cta(_.*)?|message|subtitle|intro|body|copy|caption|standfirst|alt(_.*)?|.*_alt)$/i;
const IDENTIFIER = /(^|_)(sku|id|uid|slug|code|gtin|ean|isbn|email|phone|href|url)$/i;
const GENERIC = /^(field|new_field|untitled|test|tmp|temp|foo|bar|misc)_?\d*$|^(field|text|data|value)_?\d+$/i;

export function analyzeSchemas(input: {
  schemas: NormalizedContentType[];
  usage: FieldUsageRow[];
  graph?: ReferenceGraph;
  localeCount: number;
}): SchemaAnalysis {
  const { schemas, usage } = input;
  const usageBy = new Map(usage.map((u) => [`${u.contentTypeUid}|${u.path}`, u]));
  const known = new Set(schemas.map((s) => s.uid));
  const findings: SchemaFinding[] = [];
  const add = (ct: NormalizedContentType, o: Omit<SchemaFinding, "id" | "contentTypeUid" | "contentTypeTitle" | "penalty">) => {
    findings.push({ ...o, id: shortId("g", `${o.ruleId}|${ct.uid}|${o.fieldPath ?? ""}|${o.message}`), contentTypeUid: ct.uid, contentTypeTitle: ct.title, penalty: PENALTY[o.severity] });
  };

  // inbound dependencies from the reference graph
  const nodeCt = new Map((input.graph?.nodes ?? []).map((n) => [n.id, n.contentTypeUid]));
  const inbound = new Map<string, { items: Set<string>; types: Set<string> }>();
  for (const e of input.graph?.edges ?? []) {
    const toCt = nodeCt.get(e.to);
    const fromCt = nodeCt.get(e.from);
    if (!toCt || !fromCt || nodeCt.get(e.from) === undefined) continue;
    if (e.to.startsWith("asset/")) continue;
    const cur = inbound.get(toCt) ?? { items: new Set(), types: new Set() };
    if (fromCt !== toCt) cur.types.add(fromCt);
    cur.items.add(e.from);
    inbound.set(toCt, cur);
  }

  const reports: TypeReport[] = [];
  const structures = new Map<string, { ct: NormalizedContentType; path: string }[]>();
  const leafSets = new Map<string, Set<string>>();

  for (const ct of schemas) {
    const flat = flattenSchema(ct.schema);
    const leaves = flat.filter((f) => f.kind === "leaf");
    const items = usage.find((u) => u.contentTypeUid === ct.uid)?.total ?? 0;
    const rows = flat.map((f) => ({ ...f, filled: usageBy.get(`${ct.uid}|${f.path}`)?.filled ?? 0, total: items }));
    const label = (n: number) => `${n} content item${n === 1 ? "" : "s"}`;

    // SCH-001 unused / rare. A flagged object suppresses its children: one decision, one finding.
    const skip = new Set<string>();
    for (const r of rows) {
      if (r.parent && skip.has(r.parent)) { if (r.kind !== "leaf") skip.add(r.path); continue; }
      const container = r.kind !== "leaf";
      if (items >= GOV.minEntriesForUsage && r.filled === 0 && r.path !== "title" && r.path !== "deliveryKey") {
        skip.add(r.path);
        add(ct, { ruleId: "SCH-001", severity: "medium", fieldPath: r.path, message: `“${r.path}” is never filled in`, evidence: [`Empty in all ${label(items)} of ${ct.title}${r.field.mandatory ? ", although it is required by the schema" : ""}.${container ? " Everything inside it is unused too." : ""}`], recommendation: r.field.mandatory ? "A required property that is always empty indicates items predate the rule or were saved without validation. Fix the data or drop the requirement." : "Check whether anything still reads it, then remove it from the schema to simplify the content form and the delivery payload." });
      } else if (items >= GOV.rareMinEntries && r.filled > 0 && r.filled / items < GOV.rareFillRatio) {
        if (container) skip.add(r.path);
        add(ct, { ruleId: "SCH-001", severity: "low", fieldPath: r.path, message: `“${r.path}” is rarely used (${r.filled}/${items})`, evidence: [`Filled in ${Math.round((100 * r.filled) / items)}% of content items.${container ? " Its inner fields are at most as common." : ""}`], recommendation: "Consider moving it into a separate linked content type or removing it if it has outlived its purpose." });
      }
    }
    const unusedContainers = skip;

    // SCH-003 / SCH-004
    const maxDepth = Math.max(1, ...flat.map((f) => f.depth));
    if (maxDepth >= GOV.deepNesting.medium) add(ct, { ruleId: "SCH-003", severity: maxDepth >= GOV.deepNesting.high ? "high" : "medium", message: `Nested ${maxDepth} levels deep`, evidence: [`Deepest path: ${flat.filter((f) => f.depth === maxDepth).map((f) => f.path)[0]}`], recommendation: "Flatten where possible, or move deeply nested parts into their own linked content type." });
    if (leaves.length > GOV.wide.low) add(ct, { ruleId: "SCH-004", severity: leaves.length > GOV.wide.medium ? "medium" : "low", message: `${leaves.length} fields in one content type`, evidence: [`Editors scroll through ${leaves.length} fields; the delivery payload grows with every one.`], recommendation: "Group related fields into objects, share repeated parts through schema definitions ($ref), or split the type." });

    // SCH-005 link palette bloat / allowed content types never linked
    for (const f of flat.filter((x) => x.field.dataType === "reference")) {
      const targets = f.field.referenceTo ?? [];
      if (targets.length > GOV.manyBlockTypes) add(ct, { ruleId: "SCH-005", severity: "medium", fieldPath: f.path, message: `“${f.path}” accepts ${targets.length} content types`, evidence: ["A long list of content types is hard for editors to choose from."], recommendation: "Merge similar components and use variants (an enum) instead of separate content types." });
      if (items >= GOV.minEntriesForUsage && targets.length > 1 && !unusedContainers.has(f.path) && !(f.parent && unusedContainers.has(f.parent))) {
        const linked = new Set(usage.filter((u) => u.contentTypeUid === ct.uid && u.path.startsWith(`${f.path}→`) && u.filled > 0).map((u) => shortTypeId(u.path.slice(f.path.length + 1))));
        if (linked.size) for (const t of targets) if (!linked.has(t)) add(ct, { ruleId: "SCH-005", severity: "low", fieldPath: `${f.path}→${t}`, message: `“${f.path}” never links a ${t}`, evidence: [`No ${ct.title} content item links a “${t}” in ${f.path}.`], recommendation: "Remove the unused content type from the link's enum to shorten the editor's choices." });
      }
    }

    // SCH-006 near-duplicate names, SCH-007 generic names (within the same object)
    const byContainer = new Map<string, FlatField[]>();
    for (const f of flat) byContainer.set(f.parent ?? "", [...(byContainer.get(f.parent ?? "") ?? []), f]);
    for (const [, group] of byContainer) {
      const seen = new Map<string, FlatField>();
      for (const f of group) {
        const key = `${tokens(f.field.uid)}:${f.field.dataType}`;
        const prev = seen.get(key);
        // title vs metaTitle is a normal pairing (item title vs SEO title), not redundancy
        if (prev && prev.field.uid !== f.field.uid && prev.field.uid !== "title" && f.field.uid !== "title") add(ct, { ruleId: "SCH-006", severity: "low", fieldPath: f.path, message: `“${prev.field.uid}” and “${f.field.uid}” look redundant`, evidence: ["Same type, names differ only by a seo/meta/og prefix."], recommendation: "Keep one and migrate the other, so editors know where to write." });
        else seen.set(key, f);
      }
      for (const f of group) if (GENERIC.test(snake(f.field.uid))) add(ct, { ruleId: "SCH-007", severity: "low", fieldPath: f.path, message: `Generic field name “${f.field.uid}”`, evidence: ["The name does not say what the field is for."], recommendation: "Rename (via a new schema version and a content migration) to something descriptive." });
    }

    // SCH-009 broken / broad links
    for (const f of flat.filter((x) => x.field.dataType === "reference")) {
      const targets = f.field.referenceTo ?? [];
      const missing = targets.filter((t) => !known.has(t));
      if (missing.length) add(ct, { ruleId: "SCH-009", severity: "high", fieldPath: f.path, message: `“${f.path}” allows unregistered content type ${missing.join(", ")}`, evidence: ["Editors cannot create or pick items of that type, and links to it cannot be resolved."], recommendation: "Register the content type in the hub, or remove it from the link's enum." });
      else if (targets.length > GOV.broadReferenceTargets) add(ct, { ruleId: "SCH-009", severity: "low", fieldPath: f.path, message: `“${f.path}” can link ${targets.length} content types`, evidence: ["Very broad links make rendering and impact analysis unpredictable."], recommendation: "Narrow the allowed content types." });
    }

    // SCH-010 localization hygiene (only meaningful with several locales)
    if (input.localeCount > 1) {
      for (const f of leaves) {
        const textual = f.field.dataType === "text" || f.field.dataType === "markdown";
        if (!textual || f.field.hasEnum || f.field.uid === "deliveryKey") continue;
        const inheritedLocalized = flat.some((p) => p.kind === "object" && p.field.localized && f.path.startsWith(`${p.path}.`));
        const localized = f.field.localized || inheritedLocalized;
        if (!localized && f.field.uid !== "title" && TRANSLATABLE.test(snake(f.field.uid))) add(ct, { ruleId: "SCH-010", severity: "medium", fieldPath: f.path, message: `“${f.path}” looks translatable but is not localized`, evidence: [`With ${input.localeCount} locales, every market will show the same text.`], recommendation: "Make it a localized value (localized-value), or confirm it is intentionally identical in every market." });
        if (localized && f.field.dataType === "text" && IDENTIFIER.test(snake(f.field.uid))) add(ct, { ruleId: "SCH-010", severity: "low", fieldPath: f.path, message: `“${f.path}” looks like an identifier but is localized`, evidence: ["Identifiers are usually the same in every market; localizing them creates drift and translation work."], recommendation: "Make it a plain string unless markets genuinely need different values." });
      }
    }

    // SCH-008 empty content type
    if (items === 0) add(ct, { ruleId: "SCH-008", severity: "low", message: "No content items", evidence: ["The scanned repositories have no content items of this type."], recommendation: "Archive the content type if it is unused, or document it as a template." });

    // collect structures for repetition analysis
    for (const f of flat.filter((x) => x.kind === "object" && (x.field.schema?.length ?? 0) >= 3)) structures.set(sig(f.field.schema ?? []), [...(structures.get(sig(f.field.schema ?? [])) ?? []), { ct, path: f.path }]);
    leafSets.set(ct.uid, new Set(flat.filter((f) => f.kind === "leaf" && !["title", "deliveryKey"].includes(f.field.uid)).map((f) => `${f.field.uid}:${f.field.dataType}`)));

    const objects = flat.filter((f) => f.kind === "object").length;
    const refFields = flat.filter((f) => f.field.dataType === "reference");
    const linkTargets = refFields.reduce((n, f) => n + (f.field.referenceTo?.length ?? 0), 0);
    const refs = refFields.length;
    const complexity = leaves.length + 4 * maxDepth + Math.min(3 * linkTargets, 30) + 2 * objects + refs;
    const inc = inbound.get(ct.uid);
    const inboundItems = inc?.items.size ?? 0;
    const inboundTypes = inc?.types.size ?? 0;
    const riskScore = Math.min(100, Math.round(items * 1.5 + inboundItems * 2 + inboundTypes * 8));
    reports.push({
      uid: ct.uid, title: ct.title, items, fields: leaves.length, maxDepth, objects, linkTargets, references: refs,
      mandatory: leaves.filter((l) => l.field.mandatory).length,
      complexity, complexityBand: band(complexity, GOV.complexityBands),
      inbound: { items: inboundItems, types: inboundTypes },
      risk: {
        score: riskScore, band: band(riskScore, GOV.riskBands),
        rationale: [`${label(items)} would carry any breaking change`, `${label(inboundItems)} in ${inboundTypes} other type${inboundTypes === 1 ? "" : "s"} link to it`, ...(input.localeCount > 1 ? [`Each change must be checked in ${input.localeCount} locales`] : [])],
      },
      findings: 0, score: 100, fieldRows: rows,
    });
  }

  // SCH-011 fragile core
  for (const r of reports) if (r.complexityBand === "high" && r.risk.band === "high") {
    const ct = schemas.find((s) => s.uid === r.uid)!;
    add(ct, { ruleId: "SCH-011", severity: "medium", message: `${r.title} is complex (${r.complexity}) and high-risk to change (${r.risk.score})`, evidence: r.risk.rationale, recommendation: "Plan changes as new schema versions with a content migration, try them in a test hub or repository first, and avoid renaming or retyping properties in place." });
  }

  // SCH-002 repeated object structures and repeated top-level field sets
  for (const [, where] of structures) {
    const places = where.filter((w, i) => where.findIndex((x) => x.ct.uid === w.ct.uid && x.path === w.path) === i);
    if (places.length > 1) add(places[0]!.ct, { ruleId: "SCH-002", severity: "medium", fieldPath: places[0]!.path, message: `The same object structure repeats in ${places.length} places`, evidence: places.map((p) => `${p.ct.title} → ${p.path}`), recommendation: "Define it once (a shared schema definition referenced with $ref, or its own content type) so changes are made once." });
  }
  const similarity: SimilarityPair[] = [];
  const uids = [...leafSets.keys()];
  for (let i = 0; i < uids.length; i++) for (let j = i + 1; j < uids.length; j++) {
    const A = leafSets.get(uids[i]!)!, B = leafSets.get(uids[j]!)!;
    const shared = [...A].filter((x) => B.has(x));
    const union = new Set([...A, ...B]).size;
    similarity.push({ a: uids[i]!, b: uids[j]!, shared, score: union ? shared.length / union : 0 });
  }
  for (const s of [...similarity].filter((p) => p.shared.length >= GOV.sharedFieldsMin).sort((x, y) => y.shared.length - x.shared.length).slice(0, 8)) {
    const ct = schemas.find((c) => c.uid === s.a)!;
    const other = schemas.find((c) => c.uid === s.b)!;
    add(ct, { ruleId: "SCH-002", severity: "medium", message: `${ct.title} and ${other.title} share ${s.shared.length} identical fields`, evidence: [s.shared.map((x) => x.split(":")[0]).join(", "), `${Math.round(s.score * 100)}% overlap`], recommendation: "Move the shared fields into a shared schema definition ($ref), or merge the types if they are variants of one thing." });
  }

  // scoring
  for (const r of reports) {
    const mine = findings.filter((f) => f.contentTypeUid === r.uid);
    r.findings = mine.length;
    r.score = Math.max(0, 100 - mine.reduce((n, f) => n + f.penalty, 0));
  }
  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.contentTypeTitle.localeCompare(b.contentTypeTitle));
  const scored = reports.filter((r) => r.fields > 0);
  return {
    types: reports.sort((a, b) => b.complexity - a.complexity),
    findings,
    similarity,
    score: scored.length ? Math.round(scored.reduce((n, r) => n + r.score, 0) / scored.length) : null,
    totals: { types: reports.length, fields: reports.reduce((n, r) => n + r.fields, 0), items: reports.reduce((n, r) => n + r.items, 0) },
  };
}
