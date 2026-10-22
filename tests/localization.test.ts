import { describe, expect, it } from "vitest";
import { buildUnits, deriveDiagnostics } from "@/lib/domain/rules";
import { coverage, healthScore } from "@/lib/domain/scoring";
import { entry, fingerprint, input } from "./helpers";

const NOW = new Date("2026-10-20T00:00:00Z");
const policy = { criticalLocales: ["fr-FR"], now: NOW };

describe("locale presence / fallback semantics", () => {
  it("fallback-only entries are never counted as localized", () => {
    const i = input({ presence: new Map([["page/e1", new Map([["fr-FR", false]])]]) });
    const { units } = buildUnits(i);
    expect(units.length).toBeGreaterThan(0);
    expect(units.every((u) => u.existence === "fallback_only" && u.completeness === "missing")).toBe(true);
    expect(coverage(units).percent).toBe(0);
  });

  it("unknown presence (scan failure) is excluded, not assumed complete", () => {
    const i = input({ presence: new Map() });
    const { units, itemLocales } = buildUnits(i);
    expect(units).toHaveLength(0);
    expect(itemLocales[0]?.existence).toBe("unknown");
    expect(coverage(units).percent).toBeNull(); // N/A, never 100%
  });

  it("explicitly localized, non-empty, translated fields are complete", () => {
    const target = entry({ locale: "fr-FR", values: { title: "Bonjour mon ami", subtitle: "Deuxième ligne de texte ici" } });
    const { units } = buildUnits(input({ targets: new Map([["page/e1/fr-FR", target]]) }));
    expect(units.map((u) => u.completeness)).toEqual(["complete", "complete"]);
    expect(coverage(units).percent).toBe(100);
  });
});

describe("schema-aware eligibility", () => {
  it("excludes non-localizable, enum and identifier fields", () => {
    const target = entry({ locale: "fr-FR", values: { title: "Bonjour mon ami", subtitle: "Deuxième ligne de texte ici", sku_code: "A-1" } });
    const { units } = buildUnits(input({ targets: new Map([["page/e1/fr-FR", target]]) }));
    expect(units.map((u) => u.pointer.fieldPath).sort()).toEqual(["subtitle", "title"]);
  });

  it("whitespace-only localized value is missing", () => {
    const target = entry({ locale: "fr-FR", values: { title: "   ", subtitle: "Deuxième ligne de texte ici" } });
    const { units } = buildUnits(input({ targets: new Map([["page/e1/fr-FR", target]]) }));
    expect(units.find((u) => u.pointer.fieldPath === "title")?.completeness).toBe("missing");
  });

  it("value identical to a multi-word source is flagged incomplete (possibly untranslated)", () => {
    const target = entry({ locale: "fr-FR", values: { title: "Hello there my friend", subtitle: "Deuxième ligne de texte ici" } });
    const { units } = buildUnits(input({ targets: new Map([["page/e1/fr-FR", target]]) }));
    expect(units.find((u) => u.pointer.fieldPath === "title")?.completeness).toBe("incomplete");
  });

  it("eligible=0 yields N/A", () => {
    expect(coverage([]).percent).toBeNull();
  });
});

describe("freshness", () => {
  const target = entry({ locale: "fr-FR", values: { title: "Bonjour mon ami", subtitle: "Deuxième ligne de texte ici" } });
  const targets = new Map([["page/e1/fr-FR", target]]);

  it("no approval baseline => unknown, not stale", () => {
    const { units } = buildUnits(input({ targets }));
    expect(units.every((u) => u.freshness === "unknown")).toBe(true);
  });

  it("different approved fingerprint => stale; same => current", () => {
    const key = "page/e1/fr-FR/title";
    const stale = buildUnits(input({ targets, baselines: new Map([[key, fingerprint("old source")]]) })).units;
    expect(stale.find((u) => u.key === key)?.freshness).toBe("stale");
    const current = buildUnits(input({ targets, baselines: new Map([[key, fingerprint("Hello there my friend")]]) })).units;
    expect(current.find((u) => u.key === key)?.freshness).toBe("current");
  });
});

describe("diagnostics and scoring", () => {
  it("mandatory missing field is critical; optional is not", () => {
    const { units, itemLocales } = buildUnits(input({ presence: new Map([["page/e1", new Map([["fr-FR", false]])]]) }));
    const d = deriveDiagnostics(units, itemLocales, policy);
    expect(d.find((x) => x.pointer.fieldPath === "title")?.severity).toBe("critical");
    expect(d.find((x) => x.pointer.fieldPath === "subtitle")?.severity).not.toBe("critical");
  });

  it("score is monotonic when an issue is resolved", () => {
    const { units, itemLocales } = buildUnits(input({ presence: new Map([["page/e1", new Map([["fr-FR", false]])]]) }));
    const d = deriveDiagnostics(units, itemLocales, policy);
    const before = healthScore(d, units.length) as number;
    const after = healthScore(d.slice(1), units.length) as number;
    expect(after).toBeGreaterThanOrEqual(before);
    expect(healthScore([], 0)).toBeNull();
  });

  it("placeholder mismatch raises LOC-004", () => {
    const i = input({ sourceItems: [entry({ values: { title: "Hi {{name}}, welcome back", subtitle: "Second line of copy here" } })] });
    const target = entry({ locale: "fr-FR", values: { title: "Salut {{nom}}, bon retour", subtitle: "Deuxième ligne de texte ici" } });
    i.targets = new Map([["page/e1/fr-FR", target]]);
    const { units, itemLocales } = buildUnits(i);
    const d = deriveDiagnostics(units, itemLocales, policy);
    expect(d.find((x) => x.pointer.fieldPath === "title")?.ruleIds).toContain("LOC-004");
  });

  it("PUB-001 only when the item is published but its published version lacks the locale", () => {
    const i = input({
      sourceItems: [entry({ publicationKnown: true, published: true, values: { title: "Hello there my friend" } })],
      targets: new Map([["page/e1/fr-FR", entry({ locale: "fr-FR", publicationKnown: true, published: false, values: { title: "Bonjour mon ami" } })]]),
    });
    const { units, itemLocales } = buildUnits(i);
    const d = deriveDiagnostics(units, itemLocales, policy);
    expect(d.some((x) => x.ruleIds.includes("PUB-001"))).toBe(true);
  });
});

import { ampLinks } from "@/lib/domain/amp-links";
describe("Amplience deep links", () => {
  const b = { hub: "commercedemo" };
  it("builds content item, hub, settings and content type URLs and encodes segments", () => {
    expect(ampLinks.item(b, "f05a0723-9e67")).toBe("https://app.amplience.net/content/#!/commercedemo/authoring/content-item/edit/f05a0723-9e67");
    expect(ampLinks.hub(b)).toBe("https://app.amplience.net/content/#!/commercedemo/authoring/content-items");
    expect(ampLinks.contentTypes(b)).toContain("/development/content-types");
    expect(ampLinks.settings(b)).toContain("/commercedemo/settings");
    expect(ampLinks.item({ hub: "a/b" }, "x y")).toContain("a%2Fb/authoring/content-item/edit/x%20y");
  });
});
