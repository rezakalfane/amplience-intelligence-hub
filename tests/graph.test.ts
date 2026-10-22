import { describe, expect, it } from "vitest";
import { createDemoAdapter } from "@/lib/adapters/demo-adapter";
import { adjacency, buildGraph, dependencies, dependents, extractRefs, graphStats } from "@/lib/domain/graph";
import { runScan } from "@/lib/scan/scan";
import type { NormalizedContentType, NormalizedItem, SchemaField } from "@/lib/domain/types";
import { entry, field } from "./helpers";

const refField = (uid: string, to: string[], o: Partial<SchemaField> = {}) => field(uid, { dataType: "reference", referenceTo: to, ...o });

const CT: NormalizedContentType[] = [
  {
    uid: "page", title: "Page",
    schema: [
      field("title"),
      refField("related", ["page", "faq"], { multiple: true }),
      field("image", { dataType: "image" }),
      field("body", { dataType: "markdown" }),
      field("hero", { dataType: "object", schema: [refField("cta_target", ["faq"]), field("bg", { dataType: "image" })] }),
      field("teasers", { dataType: "object", multiple: true, schema: [refField("page_ref", ["page"]), field("clip", { dataType: "video" })] }),
    ],
  },
  { uid: "faq", title: "FAQ", schema: [field("title")] },
];

const e = (ct: string, uid: string, values: Record<string, unknown>): NormalizedItem => entry({ uid, contentTypeUid: ct, title: uid, values });
const link = (ct: string, id: string) => ({ contentType: `https://schemas.example.com/${ct}`, id });

describe("reference extraction", () => {
  it("finds content links, image and video links, inside objects and arrays of objects", () => {
    const refs = extractRefs(CT[0]!.schema, {
      related: [link("faq", "f1"), link("page", "p2")],
      image: { id: "a1", name: "hero-shot", endpoint: "hub", defaultHost: "cdn.media.amplience.net" },
      body: "Markdown is text: [a link](/faq) is not a content link.",
      hero: { cta_target: link("faq", "f3"), bg: { id: "a3", name: "bg" } },
      teasers: [{ page_ref: link("page", "p9"), clip: { id: "v1", name: "clip" } }],
    });
    expect(refs.map((r) => `${r.kind}:${r.uid}:${r.via}`).sort()).toEqual([
      "asset:a1:asset", "asset:a3:asset", "asset:v1:asset", "item:f1:reference", "item:f3:reference", "item:p2:reference", "item:p9:reference",
    ]);
    expect(refs.find((r) => r.uid === "a1")?.assetName).toBe("hero-shot");
    expect(refs.find((r) => r.uid === "f1")?.contentTypeUid).toBe("faq");
    expect(refs.find((r) => r.uid === "p9")?.field).toBe("teasers[0].page_ref");
  });
});

describe("graph", () => {
  const entries = [
    e("page", "a", { related: [link("page", "b")] }),
    e("page", "b", { related: [link("page", "c")] }),
    e("page", "c", { related: [link("page", "a")], hero: { cta_target: link("faq", "ghost") } }), // cycle a→b→c→a, broken link to ghost
    e("page", "solo", {}),
    e("faq", "f", {}),
  ];
  const g = buildGraph({ contentTypes: CT, entries, completeTypes: new Set(["page", "faq"]) });
  const adj = adjacency(g);

  it("computes transitive blast radius with depths, safely through cycles", () => {
    const d = dependents(adj, "page/c");
    expect(Object.fromEntries(d)).toEqual({ "page/b": 1, "page/a": 2 });
    expect(dependents(adj, "page/solo").size).toBe(0);
    expect(dependencies(adj, "page/a").get("page/c")).toBe(2);
  });

  it("flags links to content items that do not exist as broken (only for fully scanned types)", () => {
    expect(graphStats(g).broken.map((n) => n.uid)).toEqual(["ghost"]);
    const partial = buildGraph({ contentTypes: CT, entries, completeTypes: new Set(["page"]) });
    expect(partial.nodes.find((n) => n.uid === "ghost")).toMatchObject({ kind: "item", unscanned: true });
    expect(graphStats(partial).broken).toHaveLength(0);
  });

  it("reports orphans and hubs", () => {
    const s = graphStats(g);
    expect(s.orphans.map((n) => n.uid).sort()).toEqual(["f", "solo"]);
    expect(s.hubs[0]?.transitive).toBe(2);
  });
});

describe("demo graph", () => {
  it("is large enough to be interesting and includes a hub, orphans, assets and one broken reference", async () => {
    const snap = await runScan(createDemoAdapter(), { baselines: new Map(), maxItemsPerType: 100, concurrency: 4, criticalLocales: [], provenance: "DEMO" });
    const s = graphStats(snap.graph!);
    expect(s.entries).toBeGreaterThanOrEqual(50);
    expect(s.assets).toBeGreaterThan(3);
    expect(s.edges).toBeGreaterThan(100);
    expect(s.broken.map((n) => n.uid)).toEqual(["campaign_99"]);
    expect(s.orphans.length).toBeGreaterThan(0);
    expect(s.hubs[0]!.transitive).toBeGreaterThan(8);
  });
});
