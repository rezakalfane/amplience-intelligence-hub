import { fingerprint } from "@/lib/domain/fingerprint";
import type { LocaleInfo, NormalizedContentType, NormalizedItem, SchemaField } from "@/lib/domain/types";
import { CTAS, ENTRY_TITLES, HEADLINES, LOCALE_META, SENTENCES, type DemoLocale, type Phrase } from "./bank";

// Deterministic offline sample hub. 5 locales, 4 content types, 56 content items, field-level localization.
// Values are already projected per locale (what the live adapter produces from `localized-value` fields).
// Every KPI in DEMO mode is computed from these records by the same pipeline as live data.

export const DEMO_HUB = "global-commerce (sample)";
export const DEMO_SCHEMA_BASE = "https://schemas.example.com/";
export const DEMO_MASTER: DemoLocale = "en-US";
const ENTRIES_PER_TYPE = 14;

const field = (uid: string, displayName: string, dataType: SchemaField["dataType"], o: Partial<SchemaField> = {}): SchemaField => ({
  uid, displayName, dataType, mandatory: false, multiple: false, localized: false, hasEnum: false, ...o,
});
/** A localized string (`localized-value`) unless `localized: false` is passed. */
const text = (uid: string, name: string, mandatory = false, o: Partial<SchemaField> = {}) => field(uid, name, "text", { mandatory, localized: true, ...o });
const internalTitle = () => text("title", "Internal name", true, { localized: false });
const deliveryKey = () => text("deliveryKey", "Delivery key", false, { localized: false });

export const DEMO_CONTENT_TYPES: NormalizedContentType[] = [
  {
    uid: "campaign", schemaId: `${DEMO_SCHEMA_BASE}campaign`, title: "Campaign",
    schema: [
      deliveryKey(),
      internalTitle(),
      field("hero", "Hero", "object", { schema: [text("title", "Title", true), text("description", "Description", true)] }),
      text("seo_meta_description", "SEO meta description", true),
      text("cta_label", "CTA label", true),
      text("meta_title", "Meta title"),
      text("tagline", "Tagline", false, { localized: false }), // looks translatable but is not localized (SCH-010)
      text("legacy_banner_text", "Legacy banner text"), // never filled (SCH-001)
      field("promo", "Promo", "object", { schema: [text("cta_text", "CTA text"), text("cta_link", "CTA link", false, { localized: false }), text("style_note", "Style note")] }), // repeated structure (SCH-002)
      text("hero_image_alt", "Hero image alt text"),
      field("highlights", "Highlights", "object", { multiple: true, schema: [text("text", "Text")] }),
      field("related_page", "Related landing page", "reference", { referenceTo: ["landing_page"] }),
      field("hero_image", "Hero image", "image"),
    ],
  },
  {
    uid: "landing_page", schemaId: `${DEMO_SCHEMA_BASE}landing_page`, title: "Landing page",
    schema: [
      deliveryKey(),
      internalTitle(),
      text("meta_title", "Meta title"),
      text("hero_title", "Hero title", true),
      text("hero_description", "Hero description"),
      text("cta_label", "CTA label"),
      text("seo_description", "SEO description", true),
      field("promo", "Promo", "object", { schema: [text("cta_text", "CTA text"), text("cta_link", "CTA link", false, { localized: false }), text("style_note", "Style note")] }),
      field("stats", "Stats", "object", { multiple: true, schema: [text("label", "Label"), field("source", "Source", "object", { schema: [text("name", "Name"), field("citation", "Citation", "object", { schema: [text("note", "Note")] })] })] }), // deep nesting (SCH-003)
      text("field1", "Field 1"), // generic name (SCH-007)
      field("related_pages", "Related pages", "reference", { referenceTo: ["campaign", "landing_page", "product_story", "editorial", "story_archive", "press"], multiple: true }), // broad + unregistered targets (SCH-009)
      field("featured_story", "Featured story", "reference", { referenceTo: ["product_story"] }),
      field("hero_image", "Hero image", "image"),
      field("sections", "Sections", "object", { multiple: true, schema: [text("heading", "Heading"), text("copy", "Copy")] }),
    ],
  },
  {
    uid: "product_story", schemaId: `${DEMO_SCHEMA_BASE}product_story`, title: "Product story",
    schema: [
      internalTitle(),
      text("headline", "Headline", true),
      text("sku", "SKU", false, { localized: false }),
      text("external_id", "External ID"), // identifier but localized (SCH-010)
      text("summary", "Summary", true),
      text("short_summary", "Summary (short)"), // near-duplicate of summary? (SCH-006: summary vs seo_summary style)
      text("seo_summary", "SEO summary"),
      text("key_features", "Key features", false, { multiple: true }),
      text("cta_label", "CTA label"),
      field("related_editorial", "Related editorial", "reference", { referenceTo: ["editorial"], multiple: true }),
      field("gallery", "Gallery", "image", { multiple: true }),
    ],
  },
  {
    uid: "editorial", schemaId: `${DEMO_SCHEMA_BASE}editorial`, title: "Editorial",
    schema: [
      deliveryKey(),
      internalTitle(),
      text("meta_title", "Meta title"),
      field("published", "Published", "date"),
      text("byline", "Byline", false, { localized: false }),
      text("headline", "Headline", true),
      text("standfirst", "Standfirst"),
      field("body", "Body", "markdown", { localized: true }),
      text("seo_description", "SEO description"),
      field("related_campaign", "Related campaign", "reference", { referenceTo: ["campaign"] }),
      field("featured_product", "Featured product", "reference", { referenceTo: ["product_story"] }),
      field("cover", "Cover image", "image"),
      text("cover_alt", "Cover image alt text"),
    ],
  },
];

export const DEMO_LOCALES: LocaleInfo[] = LOCALE_META.map((l) => ({ code: l.code, name: l.name, fallbackLocale: l.fallback }));
export const DEMO_CRITICAL_LOCALES = ["it-IT", "fr-FR"];

const hash = (...parts: (number | string)[]) => {
  let h = 2166136261;
  for (const p of parts) for (const ch of String(p)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) % 100;
};
type MdBlock = string | { h: number; text: string } | { link: string; text: string };
/** Markdown body (Amplience stores rich text as markdown strings). */
const md = (blocks: MdBlock[]) =>
  blocks.map((b) => (typeof b === "string" ? b : "h" in b ? `${"#".repeat(b.h)} ${b.text}` : `${b.text} [${b.link}](/guides/buying).`)).join("\n\n");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const uidOf = (ct: string, n: number) => `${ct}_${String(((n % ENTRIES_PER_TYPE) + ENTRIES_PER_TYPE) % ENTRIES_PER_TYPE + 1).padStart(2, "0")}`;
/** Content link, as projected (the `_meta` schema marker is dropped). */
const ref = (ct: string, n: number) => ({ contentType: `${DEMO_SCHEMA_BASE}${ct}`, id: uidOf(ct, n) });
/** Image link to a Content Hub asset. */
const asset = (n: number) => ({ id: `asset_${n % 6}`, name: `${["autumn", "winter", "studio", "workshop", "materials", "journal"][n % 6]}-${n % 6}`, endpoint: "globalcommerce", defaultHost: "cdn.media.amplience.net" });

const MISSING_RATE: Record<string, number> = { "it-IT": 11, default: 5 };
const UNTRANSLATED_RATE: Record<string, number> = { "it-IT": 5, default: 3 };
const NOT_LOCALIZED_RATE: Record<string, number> = { "it-IT": 22, "es-ES": 7, "de-DE": 6, "fr-FR": 4 };

type Translator = (phrase: Phrase, key: string) => string;

function content(ctUid: string, e: number, t: Translator, master = false): Record<string, unknown> {
  const S = (k: number) => SENTENCES[k % SENTENCES.length] as Phrase;
  const H = (k: number) => HEADLINES[k % HEADLINES.length] as Phrase;
  const C = (k: number) => CTAS[k % CTAS.length] as Phrase;
  const title = ENTRY_TITLES[e % ENTRY_TITLES.length] as string;
  // Deliberate SEO problems in the MASTER locale (targets inherit structure, not the gaps).
  // Meta title: unique "<headline> | <entry name>" with deliberate defects (empty, too long, a duplicated pair on campaigns).
  const metaTitle = (k: number) =>
    e === 4 ? (master ? "" : `${t(H(k), "mt")} | ${title}`)
    : e % 5 === 2 ? t(S(e + 9), "mt-long")
    : ctUid === "campaign" && (e === 1 || e === 9) ? t(H(2), "mt-dup")
    : `${t(H(k), "mt")} | ${title}`;
  // Meta description: unique by construction (pair derived from a per-entry number), with deliberate defects:
  // occasionally the bare entry name (too short, and duplicated across types) or three sentences (too long).
  const entryNo = DEMO_CONTENT_TYPES.findIndex((c) => c.uid === ctUid) * ENTRIES_PER_TYPE + e;
  const metaDesc = (_k: number, key: string) => {
    const a = entryNo % 12, c = Math.floor(entryNo / 12), b = (a + 1 + c * 2) % 12;
    return e % 7 === 3 ? `${title}.`
      : e % 9 === 4 ? [a, b, (b + 5) % 12].map((x, j) => t(S(x), `${key}${j}`)).join(" ")
      : [a, b].map((x, j) => t(S(x), `${key}${j}`)).join(" ");
  };
  // Delivery keys (the URL path): a few carry deliberate defects (uppercase, underscores, too long).
  const urlFor = (base: string) => (e === 3 ? `${base}/${slug(title)}`.replace(/(^.|\/.)/g, (c) => c.toUpperCase()) : e === 7 ? `${base}/${slug(title).replace(/-/g, "_")}` : e === 11 ? `${base}/${slug(title)}-${slug(S(e)["en-US"])}-${slug(S(e + 1)["en-US"])}` : `${base}/${slug(title)}`);
  switch (ctUid) {
    case "campaign":
      return {
        title,
        hero: { title: t(H(e), "hero.title"), description: t(S(e), "hero.description") },
        seo_meta_description: master && e === 8 ? "" : metaDesc(e + 2, "seo"),
        cta_label: t(C(e), "cta"),
        highlights: [
          { text: t(S(e + 4), "hl-a") },
          { text: t(S(e + 6), "hl-b") },
        ],
        related_page: ref("landing_page", e + 2),
        hero_image: asset(e),
        deliveryKey: urlFor("campaigns"),
        tagline: "Autumn essentials",
        promo: e % 2 === 0 ? { cta_text: t(C(e), "promo-cta"), cta_link: "/shop" } : undefined,
        meta_title: metaTitle(e),
        hero_image_alt: e % 4 === 1 ? (master ? "" : t(H(e), "alt")) : t(H(e + 1), "alt"),
      };
    case "landing_page":
      return {
        title,
        hero_title: t(H(e + 1), "hero_title"),
        hero_description: t(S(e + 1), "hero_description"),
        cta_label: t(C(e + 1), "cta"),
        seo_description: master && e === 6 ? "" : metaDesc(e + 3, "seo"),
        sections: [{ heading: t(H(e + 3), "sec-h"), copy: t(S(e + 5), "sec-c") }],
        // product_story_02 is a deliberate hub: many landing pages feature it.
        featured_story: ref("product_story", e % 3 === 0 ? 1 : e),
        // Only campaigns and landing pages are ever linked: the other allowed types are unused (SCH-005).
        related_pages: e % 4 === 2 ? [ref("campaign", e), ref("landing_page", e + 1)] : undefined,
        hero_image: asset(e + 1),
        deliveryKey: urlFor("pages"),
        promo: { cta_text: t(C(e + 1), "promo-cta"), cta_link: "/shop", style_note: "dark" },
        stats: e === 3 ? [{ label: t(H(e), "stat"), source: { name: "Industry report", citation: { note: "2025" } } }] : undefined,
        meta_title: metaTitle(e + 1),
      };
    case "product_story":
      return {
        title,
        headline: t(H(e + 2), "headline"),
        summary: t(S(e + 9), "summary"),
        key_features: [t(S(e + 4), "kf0"), t(S(e + 6), "kf1"), t(S(e + 8), "kf2")],
        cta_label: t(C(e + 2), "cta"),
        related_editorial: e < 10 ? [ref("editorial", e), ref("editorial", e + 4)] : [],
        gallery: e % 5 === 0 ? [] : [asset(e), asset(e + 2)],
        sku: `SKU-${String(e + 100)}`,
        external_id: e % 3 === 0 ? `EXT-${e}` : undefined,
        seo_summary: e === 2 ? "Rare override" : undefined,
      };
    default: {
      // Body shape varies on purpose: structured+long, long without headings, thin, one huge paragraph.
      const para = (i: number, n = 3) => Array.from({ length: n }, (_, j) => t(S(e + i * 3 + j), `bp${i}-${j}`)).join(" ");
      const shape = e % 3;
      let blocks: MdBlock[];
      if (e === 6) blocks = [Array.from({ length: 20 }, (_, j) => t(S(e + j), `huge${j}`)).join(" "), para(1)];
      else if (shape === 0) blocks = [para(0), { h: 2, text: t(H(e), "bh0") }, para(1), para(2), { h: e === 9 ? 4 : 2, text: t(H(e + 1), "bh1") }, para(3), para(4), para(5)];
      else if (shape === 1) blocks = Array.from({ length: 12 }, (_, i) => para(i));
      else blocks = [para(0), para(1)];
      if (e % 4 === 1) blocks[0] = { link: "click here", text: para(0, 2) };
      return {
        title,
        deliveryKey: urlFor("journal"),
        meta_title: metaTitle(e + 4),
        published: new Date(Date.UTC(2026, 9, 1) - e * 60 * 86_400_000).toISOString().slice(0, 10),
        byline: e % 6 === 5 ? "" : "Staff writer",
        headline: t(H(e + 4), "headline"),
        standfirst: t(S(e + 7), "standfirst"),
        body: md(blocks),
        featured_product: e % 4 === 0 ? ref("product_story", e) : undefined,
        seo_description: master && e === 2 ? "" : metaDesc(e + 5, "seo"),
        // editorial_06 links a campaign that no longer exists: a broken content link to detect.
        related_campaign: e === 5 ? { contentType: `${DEMO_SCHEMA_BASE}campaign`, id: "campaign_99" } : e < 10 ? ref("campaign", e + 1) : undefined,
        cover: asset(e + 3),
        cover_alt: e % 3 === 2 ? (master ? "" : t(H(e), "calt")) : t(H(e + 2), "calt"),
      };
    }
  }
}

/** First translatable field per type that gets an approval baseline in the fixtures (stale seeds). */
const BASELINE_FIELD: Record<string, string> = {
  campaign: "hero.description", landing_page: "hero_description", product_story: "summary", editorial: "standfirst",
};

export interface DemoWorld {
  sourceItems: NormalizedItem[];
  presence: Map<string, string[]>;
  targets: Map<string, NormalizedItem>;
  baselines: Map<string, string>;
}

export function buildDemoWorld(): DemoWorld {
  const sourceItems: NormalizedItem[] = [];
  const presence = new Map<string, string[]>();
  const targets = new Map<string, NormalizedItem>();
  const baselines = new Map<string, string>();

  DEMO_CONTENT_TYPES.forEach((ct, ci) => {
    for (let e = 0; e < ENTRIES_PER_TYPE; e++) {
      const uid = `${ct.uid}_${String(e + 1).padStart(2, "0")}`;
      const values = content(ct.uid, e, (p) => p[DEMO_MASTER], true);
      const campaign =
        ct.uid === "campaign"
          ? { id: `CMP-${String(e + 1).padStart(2, "0")}`, launchDate: e < 3 ? `2026-10-${27 + e}` : `2026-12-${String(1 + e).padStart(2, "0")}` }
          : undefined;
      sourceItems.push({
        uid, contentTypeUid: ct.uid, title: ENTRY_TITLES[e] as string, locale: DEMO_MASTER, version: 2 + (e % 3),
        updatedAt: `2026-10-${String(1 + ((e * 2) % 18)).padStart(2, "0")}T09:00:00.000Z`,
        deliveryKey: typeof values.deliveryKey === "string" ? values.deliveryKey : undefined,
        values, published: true, publicationKnown: true, campaign,
      });

      const localized: string[] = [];
      for (const loc of LOCALE_META.filter((l) => l.code !== DEMO_MASTER)) {
        // Forced fixture for the demo story: the first campaign has no Italian values at all.
        const forced = ct.uid === "campaign" && e === 0 && loc.code === "it-IT";
        const notLocalized = forced || hash(ci, e, loc.code, "nl") < (NOT_LOCALIZED_RATE[loc.code] ?? 5);
        if (notLocalized) continue;
        localized.push(loc.code);

        const tr: Translator = (phrase, key) => {
          const r = hash(ct.uid, e, loc.code, key);
          const miss = MISSING_RATE[loc.code] ?? MISSING_RATE.default ?? 5;
          const same = UNTRANSLATED_RATE[loc.code] ?? UNTRANSLATED_RATE.default ?? 3;
          if (r < miss) return "";
          if (r < miss + same) return phrase[DEMO_MASTER];
          const out = phrase[loc.code as DemoLocale];
          if (loc.code === "de-DE" && out.includes("{{firstName}}") && hash(e, "ph") < 60) return out.replace("{{firstName}}", "{{vorname}}");
          return out;
        };
        const target: NormalizedItem = {
          uid, contentTypeUid: ct.uid, title: ENTRY_TITLES[e] as string, locale: loc.code,
          // Field-level localization: the locale lives in the same item, so it shares the item version.
          version: 2 + (e % 3),
          values: content(ct.uid, e, tr),
          // The last published version may predate this locale's values (PUB-001).
          published: hash(ci, e, loc.code, "pub") >= 12,
          publicationKnown: true,
        };
        targets.set(`${ct.uid}/${uid}/${loc.code}`, target);

        if (hash(ci, e, loc.code, "stale") < 9) {
          const path = BASELINE_FIELD[ct.uid] as string;
          const src = sourceTextAt(values, path);
          if (src) baselines.set(`${ct.uid}/${uid}/${loc.code}/${path}`, fingerprint(`${src} (earlier wording)`));
        }
      }
      presence.set(`${ct.uid}/${uid}`, localized);
    }
  });
  return { sourceItems, presence, targets, baselines };
}

function sourceTextAt(values: Record<string, unknown>, path: string): string | undefined {
  let cur: unknown = values;
  for (const part of path.split(".")) cur = (cur as Record<string, unknown> | undefined)?.[part];
  return typeof cur === "string" ? cur : undefined;
}
