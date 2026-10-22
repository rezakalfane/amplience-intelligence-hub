import { describe, expect, it } from "vitest";
import { analyzeSchemas, computeFieldUsage, flattenSchema, presentPaths } from "@/lib/domain/schema-governance";
import type { NormalizedContentType, ReferenceGraph, SchemaField } from "@/lib/domain/types";
import { entry, field } from "./helpers";

const f = (uid: string, o: Partial<SchemaField> = {}) => field(uid, o);
const grp = (uid: string, schema: SchemaField[], o: Partial<SchemaField> = {}) => f(uid, { dataType: "object", schema, ...o });
const link = (ct: string, id: string) => ({ contentType: `https://schemas.example.com/${ct}`, id });

const POST: NormalizedContentType = {
  uid: "post", title: "Post",
  schema: [
    f("title"), f("headline", { localized: false }), f("sku"), f("legacy_note"), f("description"), f("seo_description"),
    grp("promo", [f("cta_text"), f("cta_link"), f("style")]),
    f("deep", { dataType: "object", schema: [grp("l2", [grp("l3", [f("leaf")])])] }),
    grp("sections", [f("heading"), f("copy")], { multiple: true }),
    f("components", { dataType: "reference", multiple: true, referenceTo: ["page", "unused", "post"] }),
    f("related", { dataType: "reference", referenceTo: ["ghost"] }),
    f("field1"),
  ],
};
const PAGE: NormalizedContentType = { uid: "page", title: "Page", schema: [f("title"), grp("promo", [f("cta_text"), f("cta_link"), f("style")]), f("body")] };
const UNUSED: NormalizedContentType = { uid: "unused", title: "Unused", schema: [f("title")] };

const posts = Array.from({ length: 12 }, (_, i) =>
  entry({ uid: `p${i}`, contentTypeUid: "post", title: `P${i}`, values: {
    title: `P${i}`, headline: "h", sku: "S", description: "d", seo_description: i === 0 ? "x" : "",
    promo: i % 2 === 0 ? { cta_text: "Go", cta_link: "/", style: "a" } : undefined,
    sections: [{ heading: "H", copy: "C" }],
    components: [link("page", `g${i % 6}`)],
  } }));
const pages = Array.from({ length: 6 }, (_, i) => entry({ uid: `g${i}`, contentTypeUid: "page", title: `G${i}`, values: { title: `G${i}`, promo: { cta_text: "x" }, body: "b" } }));

const run = (graph?: ReferenceGraph, localeCount = 2) => {
  const schemas = [POST, PAGE, UNUSED];
  return analyzeSchemas({ schemas, usage: computeFieldUsage(schemas, [...posts, ...pages]), graph, localeCount });
};
const byRule = (a: ReturnType<typeof run>, id: string) => a.findings.filter((x) => x.ruleId === id);

describe("field usage", () => {
  it("collapses array items to schema paths and counts non-empty values only", () => {
    const paths = presentPaths(POST.schema, posts[0]!.values);
    expect(paths.has("promo.cta_text")).toBe(true);
    expect(paths.has("sections.heading")).toBe(true);
    expect(paths.has("components")).toBe(true);
    expect(paths.has("components→https://schemas.example.com/page")).toBe(true);
    expect(paths.has("related")).toBe(false);
    expect(paths.has("legacy_note")).toBe(false);
    expect(paths.has("seo_description")).toBe(true); // "x"
    expect(presentPaths(POST.schema, posts[1]!.values).has("seo_description")).toBe(false); // empty string
    const usage = computeFieldUsage([POST], posts);
    expect(usage.find((u) => u.path === "promo.cta_text")).toMatchObject({ filled: 6, total: 12 });
    expect(usage.find((u) => u.path === "legacy_note")).toMatchObject({ filled: 0, total: 12 });
  });
  it("assigns nesting depth: each inline object adds a level", () => {
    const flat = flattenSchema(POST.schema);
    expect(flat.find((x) => x.path === "deep.l2.l3.leaf")!.depth).toBe(4);
    expect(flat.find((x) => x.path === "sections.heading")!.depth).toBe(2);
  });
});

describe("schema governance rules", () => {
  const a = run();
  it("SCH-001 unused vs rarely used, and skips children of an unused container", () => {
    const unused = byRule(a, "SCH-001").map((x) => x.fieldPath);
    expect(unused).toEqual(expect.arrayContaining(["legacy_note", "field1", "related", "deep"]));
    expect(unused).not.toContain("deep.l2"); // child of an already-unused container
    expect(byRule(a, "SCH-001").find((x) => x.fieldPath === "seo_description")?.severity).toBe("low"); // 1/12 < 10%
    expect(byRule(a, "SCH-001").some((x) => x.fieldPath === "title")).toBe(false);
  });
  it("SCH-001 needs enough content items to be confident", () => {
    const few = analyzeSchemas({ schemas: [POST], usage: computeFieldUsage([POST], posts.slice(0, 3)), localeCount: 2 });
    expect(few.findings.filter((x) => x.ruleId === "SCH-001")).toHaveLength(0);
  });
  it("SCH-002 repeated object structure across types", () => {
    const r = byRule(a, "SCH-002").find((x) => x.message.includes("object structure"));
    expect(r?.evidence.join()).toMatch(/Post → promo.*Page → promo/);
  });
  it("SCH-003 deep nesting, SCH-005 allowed content types never linked, SCH-006/7 names", () => {
    expect(byRule(a, "SCH-003")[0]).toMatchObject({ severity: "medium" });
    const palette = byRule(a, "SCH-005").map((x) => x.fieldPath);
    expect(palette.sort()).toEqual(["components→post", "components→unused"]);
    expect(byRule(a, "SCH-006").some((x) => x.message.includes("description") && x.message.includes("seo_description"))).toBe(true);
    expect(byRule(a, "SCH-007").some((x) => x.fieldPath === "field1")).toBe(true);
  });
  it("SCH-008 empty type, SCH-009 link to an unregistered content type (high)", () => {
    expect(byRule(a, "SCH-008").map((x) => x.contentTypeUid)).toEqual(["unused"]);
    expect(byRule(a, "SCH-009")[0]).toMatchObject({ severity: "high", fieldPath: "related" });
  });
  it("SCH-010 only applies with several locales; title is exempt", () => {
    expect(byRule(a, "SCH-010").some((x) => x.fieldPath === "headline" && x.severity === "medium")).toBe(true);
    expect(byRule(a, "SCH-010").some((x) => x.fieldPath === "sku" && x.severity === "low")).toBe(true);
    expect(run(undefined, 1).findings.filter((x) => x.ruleId === "SCH-010")).toHaveLength(0);
    const nl = analyzeSchemas({ schemas: [{ uid: "t", title: "T", schema: [f("title", { localized: false })] }], usage: [], localeCount: 3 });
    expect(nl.findings.filter((x) => x.ruleId === "SCH-010")).toHaveLength(0);
  });
});

describe("complexity, change risk, scoring", () => {
  it("complexity grows with depth and link targets; risk uses content items and inbound links", () => {
    const graph: ReferenceGraph = {
      nodes: [
        ...pages.map((e) => ({ id: `page/${e.uid}`, kind: "item" as const, contentTypeUid: "page", uid: e.uid, title: e.title })),
        ...posts.slice(0, 4).map((e) => ({ id: `post/${e.uid}`, kind: "item" as const, contentTypeUid: "post", uid: e.uid, title: e.title })),
      ],
      edges: pages.map((e, i) => ({ id: `e${i}`, from: `page/${e.uid}`, to: `post/${posts[i % 4]!.uid}`, field: "x", via: "reference" as const })),
    };
    const a = run(graph);
    const post = a.types.find((t) => t.uid === "post")!;
    const page = a.types.find((t) => t.uid === "page")!;
    expect(post.complexity).toBeGreaterThan(page.complexity);
    expect(post.inbound).toEqual({ items: 6, types: 1 });
    expect(post.risk.score).toBe(Math.round(12 * 1.5 + 6 * 2 + 1 * 8));
    expect(post.risk.rationale.join()).toMatch(/12 content items/);
  });
  it("score = 100 − penalties per type; hub score is the mean over types with fields", () => {
    const a = run();
    const post = a.types.find((t) => t.uid === "post")!;
    const penalties = a.findings.filter((x) => x.contentTypeUid === "post").reduce((n, x) => n + x.penalty, 0);
    expect(post.score).toBe(Math.max(0, 100 - penalties));
    expect(a.score).toBe(Math.round(a.types.reduce((n, t) => n + t.score, 0) / a.types.length));
    expect(analyzeSchemas({ schemas: [], usage: [], localeCount: 2 }).score).toBeNull();
  });
  it("similarity matrix reports shared identical fields between types", () => {
    const A: NormalizedContentType = { uid: "a", title: "A", schema: [f("title"), f("url"), f("intro"), f("hero"), f("x")] };
    const B: NormalizedContentType = { uid: "b", title: "B", schema: [f("title"), f("url"), f("intro"), f("hero"), f("y")] };
    const r = analyzeSchemas({ schemas: [A, B], usage: [], localeCount: 1 });
    expect(r.similarity[0]).toMatchObject({ a: "a", b: "b" });
    expect(r.similarity[0]!.shared.sort()).toEqual(["hero:text", "intro:text", "url:text"]);
    expect(r.findings.some((x) => x.ruleId === "SCH-002" && /share 3 identical fields/.test(x.message))).toBe(true);
  });
});

import { createDemoAdapter } from "@/lib/adapters/demo-adapter";
import { runScan } from "@/lib/scan/scan";

describe("demo schema governance", () => {
  it("exercises the rule families with a believable score and a unique finding per issue", async () => {
    const snap = await runScan(createDemoAdapter(), { baselines: new Map(), maxItemsPerType: 100, concurrency: 4, criticalLocales: [], provenance: "DEMO" });
    const a = analyzeSchemas({ schemas: snap.schemas!, usage: snap.fieldUsage!, graph: snap.graph, localeCount: snap.locales.length });
    const hit = new Set(a.findings.map((x) => x.ruleId));
    for (const r of ["SCH-001", "SCH-002", "SCH-003", "SCH-005", "SCH-006", "SCH-007", "SCH-009", "SCH-010"]) expect(hit.has(r), r).toBe(true);
    expect(new Set(a.findings.map((x) => x.id)).size).toBe(a.findings.length);
    expect(a.score).toBeGreaterThan(30);
    expect(a.score).toBeLessThan(95);
    expect(a.types.every((t) => t.items >= 14)).toBe(true);
  });
});

describe("one decision, one finding", () => {
  it("an unused or rarely used object does not also report every inner field", () => {
    const a = run();
    const paths = a.findings.map((x) => x.fieldPath ?? "");
    expect(a.findings.filter((x) => x.ruleId === "SCH-005" && x.fieldPath === "components→unused")).toHaveLength(1); // one per unused allowed type
    expect(paths.filter((p) => p.startsWith("deep.") )).toEqual([]); // children of the unused `deep` container
    // a rare group: flagged once, children suppressed
    const RARE: NormalizedContentType = { uid: "r", title: "R", schema: [f("title"), grp("extra", [f("a"), f("b"), f("c")])] };
    const es = Array.from({ length: 20 }, (_, i) => entry({ uid: `e${i}`, contentTypeUid: "r", title: `E${i}`, values: { title: `E${i}`, extra: i === 0 ? { a: "1", b: "2", c: "3" } : undefined } }));
    const r = analyzeSchemas({ schemas: [RARE], usage: computeFieldUsage([RARE], es), localeCount: 1 });
    expect(r.findings.filter((x) => x.ruleId === "SCH-001").map((x) => x.fieldPath)).toEqual(["extra"]);
  });
});

describe("SCH-006 false positives", () => {
  it("does not flag title / meta_title, but still flags description / seo_description", () => {
    const CT: NormalizedContentType = { uid: "x", title: "X", schema: [f("title"), f("meta_title"), f("description"), f("seo_description")] };
    const r = analyzeSchemas({ schemas: [CT], usage: [], localeCount: 1 });
    const msgs = r.findings.filter((x) => x.ruleId === "SCH-006").map((x) => x.message);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/description.*seo_description/);
  });
});
