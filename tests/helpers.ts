import { fingerprint } from "@/lib/domain/fingerprint";
import type { AnalysisInput } from "@/lib/domain/rules";
import type { NormalizedContentType, NormalizedItem, SchemaField } from "@/lib/domain/types";

export const field = (uid: string, o: Partial<SchemaField> = {}): SchemaField => ({
  uid, displayName: uid, dataType: "text", mandatory: false, multiple: false, localized: true, hasEnum: false, ...o,
});

export const CT: NormalizedContentType = {
  uid: "page",
  title: "Page",
  schema: [
    field("title", { mandatory: true }),
    field("subtitle"),
    field("sku_code", { localized: false }),
    field("url"),
    field("badge", { hasEnum: true }),
  ],
};

export const entry = (o: Partial<NormalizedItem> & { values: Record<string, unknown> }): NormalizedItem => ({
  uid: "e1", contentTypeUid: "page", title: "Entry", locale: "en-US", version: 1, publicationKnown: false, ...o,
});

export function input(over: Partial<AnalysisInput> = {}): AnalysisInput {
  return {
    hubId: "s", masterLocale: "en-US",
    locales: [
      { code: "en-US", name: "English", fallbackLocale: null },
      { code: "fr-FR", name: "French", fallbackLocale: "en-US" },
    ],
    contentTypes: [CT],
    sourceItems: [entry({ values: { title: "Hello there my friend", subtitle: "Second line of copy here", sku_code: "A-1", url: "/x", badge: "new" } })],
    presence: new Map([["page/e1", new Map([["fr-FR", true]])]]),
    targets: new Map(),
    baselines: new Map(),
    ...over,
  };
}

export { fingerprint };
