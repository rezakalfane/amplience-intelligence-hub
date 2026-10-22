import { shortId } from "./fingerprint";
import { markdownBlocks, markdownLinks } from "./markdown";
import type {
  NormalizedContentType, NormalizedItem, SchemaField, SeoFacts, SeoFinding, SeoTextField, Severity,
} from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// ---------- Thresholds (documented in docs/seo-audit.md) ----------

export const LIMITS = {
  metaDescription: { min: 50, max: 165 },
  metaTitle: { min: 15, max: 60 },
  url: { max: 75 },
  thinWords: 150,
  longBodyWordsWithoutHeadings: 300,
  longParagraphWords: 160,
  faqLeadWords: 60,
  faqLeadSentenceWords: 35,
  staleMonths: 24,
};

export const PENALTY: Record<Severity, number> = { critical: 20, high: 15, medium: 8, low: 3 };

export const SEO_RULES: Record<string, { category: "seo" | "ai"; title: string; logic: string }> = {
  "SEO-000": { category: "seo", title: "Schema gap: no meta fields", logic: "A content type with URLs has no meta title or meta description field, so editors cannot control search snippets" },
  "SEO-001": { category: "seo", title: "Missing meta description", logic: "Page-like content item whose meta description (or description/summary fallback) is empty" },
  "SEO-002": { category: "seo", title: "Meta description length", logic: `Shorter than ${LIMITS.metaDescription.min} or longer than ${LIMITS.metaDescription.max} characters (truncated or uninformative snippet)` },
  "SEO-003": { category: "seo", title: "Meta title missing or badly sized", logic: `Meta title field empty, longer than ${LIMITS.metaTitle.max} (truncated in results) or shorter than ${LIMITS.metaTitle.min} characters` },
  "SEO-004": { category: "seo", title: "Duplicate meta title/description", logic: "The same meta title or description is used by more than one content item" },
  "SEO-005": { category: "seo", title: "URL quality", logic: `Delivery key / URL has uppercase, spaces, underscores, query string, double slashes or is longer than ${LIMITS.url.max} characters` },
  "SEO-006": { category: "seo", title: "Excluded from search indexing", logic: "Indexing is switched off for the content item (check that this is intended)" },
  "SEO-007": { category: "seo", title: "Image without alt text", logic: "Image (a direct image link, or a linked image content item) has an alt-text field that is empty, or the schema has no alt-text field for it" },
  "SEO-008": { category: "seo", title: "Heading structure", logic: `Body over ${LIMITS.longBodyWordsWithoutHeadings} words with no subheadings, several H1s, or skipped heading levels` },
  "SEO-009": { category: "seo", title: "Thin content", logic: `Article body under ${LIMITS.thinWords} words` },
  "AIO-001": { category: "ai", title: "FAQ answer is not answer-first", logic: `First paragraph over ${LIMITS.faqLeadWords} words or first sentence over ${LIMITS.faqLeadSentenceWords}: harder for search snippets and AI assistants to quote` },
  "AIO-002": { category: "ai", title: "Generic link text", logic: "Links labelled “click here”, “read more”, “here”… give search engines and AI no context about the target" },
  "AIO-003": { category: "ai", title: "Hard to scan", logic: `A paragraph over ${LIMITS.longParagraphWords} words, or a long body with no lists or subheadings` },
  "AIO-004": { category: "ai", title: "Structured-data readiness", logic: "Missing properties that schema.org Article / FAQPage / Product markup needs (headline, author, date, image, description, sku)" },
  "AIO-005": { category: "ai", title: "Freshness signal", logic: `Article has no publish date, or one older than ${LIMITS.staleMonths} months` },
  "AIO-006": { category: "ai", title: "Authorship signal", logic: "Article-like content item has an author field that is empty (trust / E-E-A-T signal)" },
};

// ---------- Schema walking ----------

interface Visit {
  field: SchemaField;
  path: string;
  value: unknown;
  siblings: SchemaField[];
  data: Obj;
}

function walk(schema: SchemaField[], values: Obj, cb: (v: Visit) => void, prefix = "") {
  for (const f of schema) {
    const value = values?.[f.uid];
    const path = prefix ? `${prefix}.${f.uid}` : f.uid;
    cb({ field: f, path, value, siblings: schema, data: values });
    if (value === undefined || value === null) continue;
    if (f.dataType === "object") {
      ([] as unknown[]).concat(value).forEach((item, i) => {
        if (isObj(item)) walk(f.schema ?? [], item, cb, f.multiple ? `${path}[${i}]` : path);
      });
    }
  }
}

/** Schema-only walk (no values) to learn which fields exist at all. */
function schemaPaths(schema: SchemaField[], prefix = ""): { path: string; field: SchemaField; siblings: SchemaField[] }[] {
  return schema.flatMap((f) => {
    const path = prefix ? `${prefix}.${f.uid}` : f.uid;
    const nested = f.schema ? schemaPaths(f.schema, path) : [];
    return [{ path, field: f, siblings: schema }, ...nested];
  });
}

const META_TITLE = /(^|\.)(meta_?title|seo_?title|og_?title)$|(^|\.)(seo|meta)\.title$/i;
const META_DESC = /(^|\.)(meta_?description|seo_?description|seo_?meta_?description|og_?description)$|(^|\.)(seo|meta)\.description$/i;
const DESC_FALLBACK = /^(description|summary|excerpt|teaser|standfirst)$/i;
const URL_FIELD = /^(deliveryKey|url|slug|path|permalink)$/i;
const DATE_FIELD = /^(date|published_?at|publish_?date|published|publication_?date)$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
const AUTHOR_FIELD = /^(author|byline|authors)$/i;
const SKU_FIELD = /sku$/i;
/** Content links whose targets are the item's body (blog post content: text / image / video items). */
const BODY_LINK = /^(content|body|blocks|sections)$/i;
const ALT_FIELD = /alt/i;
const GENERIC_ANCHOR = /^(click here|here|read more|learn more|more|this link|link|this|details|click)$/i;

// ---------- Markdown body statistics ----------

interface BodyStats {
  words: number;
  paragraphs: number;
  longest: number;
  headings: number[];
  hasList: boolean;
  links: string[];
  firstParagraph?: string;
  text: string;
}

const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

function markdownStats(md: unknown, into: BodyStats) {
  if (typeof md !== "string" || !md.trim()) return;
  for (const block of markdownBlocks(md)) {
    const w = wordCount(block.text);
    if (block.kind === "paragraph" || block.kind === "quote") {
      if (w > 0) {
        into.paragraphs++;
        into.longest = Math.max(into.longest, w);
        into.words += w;
        into.firstParagraph ??= block.text;
        into.text += `${block.text}\n`;
      }
    } else if (block.kind === "heading") {
      into.headings.push(block.level ?? 2);
      into.words += w;
      into.text += `${block.text}\n`;
    } else if (block.kind === "list") {
      into.hasList = true;
      into.words += w;
      into.text += `${block.text}\n`;
    }
  }
  into.links.push(...markdownLinks(md).map((l) => l.trim()));
}

const sentenceWords = (p: string) => wordCount(p.split(/(?<=[.!?])\s+/)[0] ?? "");

// ---------- Extraction ----------

/** Resolves a content link (by item id) to the linked item and its content type, one level deep. */
export type LinkResolver = (itemId: string) => { ct: NormalizedContentType; item: NormalizedItem } | undefined;

export function extractSeoFacts(ct: NormalizedContentType, entry: NormalizedItem, resolve?: LinkResolver): SeoFacts {
  const all = schemaPaths(ct.schema);
  const hasMetaTitleField = all.some((a) => a.field.dataType === "text" && META_TITLE.test(a.path));
  const hasMetaDescField = all.some((a) => a.field.dataType === "text" && META_DESC.test(a.path));
  const fallbackField = all.find((a) => a.field.dataType === "text" && !a.path.includes(".") && DESC_FALLBACK.test(a.path));
  const urlField = all.find((a) => a.field.dataType === "text" && !a.path.includes(".") && URL_FIELD.test(a.path));
  const dateField = all.find((a) => (a.field.dataType === "date" || a.field.dataType === "text") && !a.path.includes(".") && DATE_FIELD.test(a.path));
  const authorField = all.find((a) => !a.path.includes(".") && AUTHOR_FIELD.test(a.path) && (a.field.dataType === "reference" || a.field.dataType === "text"));
  const hasSku = all.some((a) => a.field.dataType === "text" && SKU_FIELD.test(a.field.uid));
  const hasBody = all.some((a) => (a.field.dataType === "markdown" && /^(content|body|text|answer|copy)$/i.test(a.field.uid)) || (a.field.dataType === "reference" && !a.path.includes(".") && BODY_LINK.test(a.field.uid)));

  let metaTitle: SeoFacts["metaTitle"] = hasMetaTitleField ? { path: "", text: "" } : null;
  let metaDescription: SeoFacts["metaDescription"] = hasMetaDescField ? { path: "", text: "", source: "meta" } : fallbackField ? { path: fallbackField.path, text: "", source: "description" } : null;
  let url: SeoFacts["url"] = urlField ? { path: urlField.path, text: "" } : null;
  let indexable: boolean | undefined;
  let summaryPresent = false;
  const images: SeoFacts["images"] = [];
  const stats: BodyStats = { words: 0, paragraphs: 0, longest: 0, headings: [], hasList: false, links: [], text: "" };
  let answerStats: BodyStats | undefined;
  const otherText: string[] = []; // other copy on the item, used to ground suggestions when there is no markdown body
  const imageOf = (linked: { ct: NormalizedContentType; item: NormalizedItem }) => {
    const img = linked.ct.schema.find((x) => x.dataType === "image");
    if (!img) return undefined;
    const alt = linked.ct.schema.find((x) => x.dataType === "text" && ALT_FIELD.test(x.uid));
    const altVal = alt ? linked.item.values[alt.uid] : undefined;
    return { present: linked.item.values[img.uid] != null, hasAltField: Boolean(alt), alt: typeof altVal === "string" ? altVal : undefined };
  };

  walk(ct.schema, entry.values, ({ field, path, value, siblings, data }) => {
    if (field.dataType === "text") {
      const text = typeof value === "string" ? value : "";
      if (META_TITLE.test(path) && (!metaTitle?.text || text)) metaTitle = { path, text };
      if (META_DESC.test(path) && (metaDescription?.source !== "meta" || !metaDescription.text || text)) metaDescription = { path, text, source: "meta" };
      if (!path.includes(".") && DESC_FALLBACK.test(path) && metaDescription?.source === "description") metaDescription = { path, text, source: "description" };
      if (!path.includes(".") && URL_FIELD.test(path)) url = { path, text };
      if (!path.includes(".") && /^(summary|description|tagline)$/i.test(path) && text.trim()) summaryPresent = true;
      if (text.trim().length > 12 && !field.hasEnum && !META_TITLE.test(path) && !META_DESC.test(path) && !URL_FIELD.test(field.uid) && !SKU_FIELD.test(field.uid) && !ALT_FIELD.test(field.uid) && !AUTHOR_FIELD.test(field.uid)) otherText.push(text.trim());
    } else if (field.dataType === "boolean" && /(^|\.)enable_search_indexing$|(^|\.)(indexable|index)$/i.test(path) && typeof value === "boolean") {
      indexable = value;
    } else if (field.dataType === "markdown") {
      if (field.uid.toLowerCase() === "answer") {
        answerStats = { words: 0, paragraphs: 0, longest: 0, headings: [], hasList: false, links: [], text: "" };
        markdownStats(value, answerStats);
        markdownStats(value, stats);
      } else markdownStats(value, stats);
    } else if (field.dataType === "reference" && resolve) {
      // Linked image items (DAM image + alt text) and body items (text / image items of a post's content list).
      ([] as unknown[]).concat(value ?? []).forEach((link, i) => {
        const id = isObj(link) && typeof link.id === "string" ? link.id : undefined;
        const linked = id ? resolve(id) : undefined;
        if (!linked) return;
        const at = field.multiple ? `${path}[${i}]` : path;
        const img = imageOf(linked);
        if (img) {
          if (img.present) images.push({ path: at, hasAltField: img.hasAltField, alt: img.alt });
          return;
        }
        if (BODY_LINK.test(field.uid) && !path.includes(".")) {
          for (const lf of linked.ct.schema) if (lf.dataType === "markdown") markdownStats(linked.item.values[lf.uid], stats);
        }
      });
    } else if (field.dataType === "image") {
      const altField = siblings.find((s) => s.dataType === "text" && s.uid !== field.uid && (ALT_FIELD.test(s.uid) || s.uid === `${field.uid}Alt` || s.uid === `${field.uid}_alt`));
      const present = value !== undefined && value !== null && (Array.isArray(value) ? value.length > 0 : true);
      if (present) {
        const altVal = altField ? data[altField.uid] : undefined;
        images.push({ path, hasAltField: Boolean(altField), alt: typeof altVal === "string" ? altVal : undefined });
      }
    }
  });

  const rawDate = dateField ? (entry.values[dateField.path] as unknown) : undefined;
  const dateVal = typeof rawDate === "string" && ISO_DATE.test(rawDate) ? rawDate : undefined;
  const authorVal = authorField ? entry.values[authorField.path] : undefined;
  const authorPresent = Array.isArray(authorVal) ? authorVal.length > 0 : typeof authorVal === "string" ? authorVal.trim() !== "" : authorVal != null;
  const pageLike = Boolean(urlField) || hasMetaTitleField || hasMetaDescField;
  const faqLike = all.some((a) => a.field.dataType === "markdown" && a.field.uid.toLowerCase() === "answer");
  const articleLike = pageLike && hasBody && (Boolean(dateField) || Boolean(authorField)) && !faqLike;
  const productLike = hasSku;
  const grounding = stats.text || [entry.title, ...otherText].join(". ");
  const excerpt = (grounding || metaDescription?.text || entry.title).replace(/\s+/g, " ").trim().slice(0, 500);

  return {
    id: `${entry.contentTypeUid}/${entry.uid}`,
    contentTypeUid: ct.uid,
    contentTypeTitle: ct.title,
    uid: entry.uid,
    title: entry.title,
    locale: entry.locale,
    pageLike, articleLike, faqLike, productLike,
    metaTitle,
    metaDescription,
    url,
    indexable,
    author: { fieldExists: Boolean(authorField), present: authorPresent },
    date: { fieldExists: Boolean(dateField), iso: typeof dateVal === "string" && dateVal ? dateVal : undefined },
    summaryPresent,
    images,
    body: {
      words: stats.words,
      paragraphs: stats.paragraphs,
      longestParagraphWords: stats.longest,
      headings: stats.headings,
      hasList: stats.hasList,
      genericLinks: stats.links.filter((l) => GENERIC_ANCHOR.test(l)),
    },
    faq: faqLike && answerStats
      ? { question: entry.title, firstParagraphWords: wordCount(answerStats.firstParagraph ?? ""), firstSentenceWords: sentenceWords(answerStats.firstParagraph ?? ""), answerWords: answerStats.words }
      : undefined,
    sku: hasSku,
    excerpt,
  };
}

// ---------- Rules ----------

const SEV: Record<string, Severity> = {
  "SEO-000": "medium", "SEO-001": "high", "SEO-002": "medium", "SEO-003": "medium", "SEO-004": "high", "SEO-005": "low", "SEO-006": "medium",
  "SEO-007": "medium", "SEO-008": "medium", "SEO-009": "medium", "AIO-001": "medium", "AIO-002": "low", "AIO-003": "low", "AIO-004": "medium", "AIO-005": "low", "AIO-006": "medium",
};

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export function auditSeo(facts: SeoFacts[], now = new Date()): SeoFinding[] {
  const out: SeoFinding[] = [];
  const add = (f: SeoFacts | null, ct: { uid: string; title: string; locale: string }, o: {
    ruleId: string; message: string; evidence: string[]; severity?: Severity; entryId?: string; field?: { path: string; label: string }; current?: string;
    suggestion?: SeoFinding["suggestion"]; discriminator?: string;
  }) => {
    const severity = o.severity ?? (SEV[o.ruleId] as Severity);
    const entryId = o.entryId ?? f?.id ?? `ct:${ct.uid}`;
    out.push({
      id: shortId("s", `${o.ruleId}|${entryId}|${o.field?.path ?? ""}|${o.discriminator ?? ""}`),
      ruleId: o.ruleId,
      category: SEO_RULES[o.ruleId]!.category,
      severity,
      entryId,
      contentTypeUid: ct.uid,
      contentTypeTitle: ct.title,
      itemId: f?.uid,
      title: f?.title ?? `${ct.title} (content type)`,
      locale: ct.locale,
      message: o.message,
      evidence: o.evidence,
      current: o.current,
      fieldPath: o.field?.path,
      fieldLabel: o.field?.label,
      proposable: Boolean(o.suggestion && f && o.field?.path),
      suggestion: o.suggestion,
      excerpt: f?.excerpt,
      penalty: PENALTY[severity],
      status: "open",
    });
  };

  const byCt = new Map<string, SeoFacts[]>();
  for (const f of facts) byCt.set(f.contentTypeUid, [...(byCt.get(f.contentTypeUid) ?? []), f]);

  // --- content-type level (schema) findings ---
  for (const [, list] of byCt) {
    const f0 = list[0]!;
    const ct = { uid: f0.contentTypeUid, title: f0.contentTypeTitle, locale: f0.locale };
    if (f0.pageLike && f0.url && !f0.metaTitle && !f0.metaDescription) {
      add(null, ct, { ruleId: "SEO-000", message: "No meta title or meta description field", evidence: [`${ct.title} content items have a URL (delivery key) but no way to set a search snippet. Search engines will improvise one.`] });
    }
    const noAlt = new Set(list.flatMap((f) => f.images.filter((i) => !i.hasAltField).map((i) => i.path.replace(/\[\d+\]/g, ""))));
    for (const path of noAlt) {
      add(null, ct, { ruleId: "SEO-007", severity: "low", message: `Image field “${path}” has no alt-text field`, evidence: ["Editors cannot add alt text for this image field, which hurts accessibility and image search."], field: { path, label: path }, discriminator: "schema" });
    }
  }

  // --- duplicate detection ---
  const dupe = (pick: (f: SeoFacts) => SeoTextField | null | undefined) => {
    const m = new Map<string, SeoFacts[]>();
    for (const f of facts.filter((x) => x.pageLike)) {
      const t = pick(f)?.text;
      if (t && t.trim()) m.set(norm(t), [...(m.get(norm(t)) ?? []), f]);
    }
    return new Map([...m].filter(([, v]) => v.length > 1));
  };
  const dupTitles = dupe((f) => f.metaTitle);
  const dupDescs = dupe((f) => f.metaDescription);

  for (const f of facts) {
    const ct = { uid: f.contentTypeUid, title: f.contentTypeTitle, locale: f.locale };

    if (f.pageLike) {
      // meta description
      const md = f.metaDescription;
      const label = md?.source === "description" ? "Description" : "Meta description";
      if (md) {
        const len = md.text.trim().length;
        const sug = (kind: "rewrite" | "generate") => ({ kind, target: "meta_description" as const, min: LIMITS.metaDescription.min + 20, max: 155 });
        if (len === 0) add(f, ct, { ruleId: "SEO-001", message: `${label} is empty`, evidence: ["No snippet text is set; search engines pick arbitrary page text."], field: { path: md.path, label }, current: "", suggestion: sug("generate") });
        else if (len < LIMITS.metaDescription.min || len > LIMITS.metaDescription.max) {
          add(f, ct, { ruleId: "SEO-002", message: `${label} is ${len} characters`, evidence: [`Recommended ${LIMITS.metaDescription.min}–${LIMITS.metaDescription.max}. ${len > LIMITS.metaDescription.max ? "It will be truncated in results." : "It is too short to be informative."}`], field: { path: md.path, label }, current: md.text, suggestion: sug("rewrite") });
        }
        const dups = dupDescs.get(norm(md.text));
        if (dups) add(f, ct, { ruleId: "SEO-004", message: `${label} is shared with ${dups.length - 1} other content item${dups.length === 2 ? "" : "s"}`, evidence: dups.filter((d) => d.id !== f.id).slice(0, 4).map((d) => `Also used by: ${d.title} (${d.contentTypeTitle})`), field: { path: md.path, label }, current: md.text, discriminator: "desc", suggestion: { kind: "rewrite", target: "meta_description", min: 70, max: 155 } });
      }
      // meta title
      if (f.metaTitle) {
        const t = f.metaTitle.text.trim();
        const sug = (kind: "rewrite" | "generate") => ({ kind, target: "meta_title" as const, min: 30, max: LIMITS.metaTitle.max });
        if (!t) add(f, ct, { ruleId: "SEO-003", message: "Meta title is empty", evidence: ["Search engines will fall back to the page title or page content."], field: { path: f.metaTitle.path, label: "Meta title" }, current: "", suggestion: sug("generate") });
        else if (t.length > LIMITS.metaTitle.max || t.length < LIMITS.metaTitle.min) add(f, ct, { ruleId: "SEO-003", message: `Meta title is ${t.length} characters`, evidence: [`Recommended ${LIMITS.metaTitle.min}–${LIMITS.metaTitle.max}. ${t.length > LIMITS.metaTitle.max ? "It will be truncated in results." : "It is too short to describe the page."}`], field: { path: f.metaTitle.path, label: "Meta title" }, current: f.metaTitle.text, suggestion: sug("rewrite") });
        const dups = dupTitles.get(norm(t));
        if (dups) add(f, ct, { ruleId: "SEO-004", message: `Meta title is shared with ${dups.length - 1} other content item${dups.length === 2 ? "" : "s"}`, evidence: dups.filter((d) => d.id !== f.id).slice(0, 4).map((d) => `Also used by: ${d.title} (${d.contentTypeTitle})`), field: { path: f.metaTitle.path, label: "Meta title" }, current: f.metaTitle.text, discriminator: "title", suggestion: { kind: "rewrite", target: "meta_title", min: 30, max: LIMITS.metaTitle.max } });
      }
      // url
      if (f.url?.text) {
        const u = f.url.text;
        const problems = [
          /[A-Z]/.test(u) && "contains uppercase letters",
          /\s/.test(u) && "contains spaces",
          u.includes("_") && "uses underscores (hyphens are preferred)",
          u.includes("?") && "contains a query string",
          u.includes("//") && "contains a double slash",
          u.length > LIMITS.url.max && `is ${u.length} characters long`,
        ].filter(Boolean) as string[];
        if (problems.length) add(f, ct, { ruleId: "SEO-005", message: `URL ${problems[0]}`, evidence: problems.map((p) => `URL ${p}`), field: { path: f.url.path, label: "URL" }, current: u });
      }
      if (f.indexable === false) add(f, ct, { ruleId: "SEO-006", message: "Search indexing is switched off", evidence: ["The content item asks search engines not to index it. Confirm this is intended."] });
    }

    // images
    for (const img of f.images) {
      if (img.hasAltField && !(img.alt ?? "").trim()) add(f, ct, { ruleId: "SEO-007", message: "Image has no alt text", evidence: [`Image at ${img.path} has an alt-text field but it is empty.`], field: { path: img.path, label: "Image alt text" }, discriminator: img.path });
    }

    // body
    const b = f.body;
    if (f.articleLike) {
      if (b.words > 0 && b.words < LIMITS.thinWords) add(f, ct, { ruleId: "SEO-009", message: `Body is only ${b.words} words`, evidence: [`Articles under ${LIMITS.thinWords} words rarely satisfy search intent.`] });
      const h1s = b.headings.filter((h) => h === 1).length;
      const skipped = b.headings.some((h, i) => i > 0 && h - (b.headings[i - 1] as number) > 1);
      const problems = [
        b.words > LIMITS.longBodyWordsWithoutHeadings && b.headings.length === 0 && `${b.words} words with no subheadings`,
        h1s > 1 && `${h1s} H1 headings (use one)`,
        skipped && "heading levels are skipped (e.g. H2 → H4)",
      ].filter(Boolean) as string[];
      if (problems.length) add(f, ct, { ruleId: "SEO-008", message: problems[0]!, evidence: problems });
    }
    if (f.articleLike || f.faqLike) {
      if (b.genericLinks.length) add(f, ct, { ruleId: "AIO-002", message: `${b.genericLinks.length} link${b.genericLinks.length > 1 ? "s" : ""} with generic text`, evidence: [`Anchor text: ${[...new Set(b.genericLinks)].map((l) => `“${l}”`).join(", ")}`] });
    }
    if (f.articleLike) {
      const scanProblems = [
        b.longestParagraphWords > LIMITS.longParagraphWords && `a paragraph has ${b.longestParagraphWords} words`,
        b.words > 400 && b.headings.length === 0 && !b.hasList && "long body with no subheadings or lists",
      ].filter(Boolean) as string[];
      if (scanProblems.length) add(f, ct, { ruleId: "AIO-003", message: scanProblems[0]!, evidence: scanProblems });
      // authorship / freshness
      if (f.author.fieldExists && !f.author.present) add(f, ct, { ruleId: "AIO-006", message: "No author is set", evidence: ["Readers and AI assistants use authorship as a trust signal."] });
      if (f.date.fieldExists) {
        if (!f.date.iso) add(f, ct, { ruleId: "AIO-005", message: "No publish date", evidence: ["Without a date, freshness cannot be signalled."] });
        else {
          const months = (now.getTime() - new Date(f.date.iso).getTime()) / (30.44 * 86_400_000);
          if (months > LIMITS.staleMonths) add(f, ct, { ruleId: "AIO-005", message: `Published ${Math.floor(months)} months ago`, evidence: [`Older than ${LIMITS.staleMonths} months: review or refresh it.`] });
        }
      }
    }
    // FAQ answer-first
    if (f.faq) {
      const q = f.faq;
      const reasons = [
        q.firstParagraphWords > LIMITS.faqLeadWords && `the first paragraph is ${q.firstParagraphWords} words`,
        q.firstSentenceWords > LIMITS.faqLeadSentenceWords && `the first sentence is ${q.firstSentenceWords} words`,
        q.answerWords > 0 && q.answerWords < 15 && `the whole answer is only ${q.answerWords} words`,
      ].filter(Boolean) as string[];
      if (reasons.length) add(f, ct, { ruleId: "AIO-001", message: `Answer is not answer-first: ${reasons[0]}`, evidence: reasons.map((r) => `Question “${q.question}”: ${r}`) });
    }

    // structured-data readiness
    const missing: string[] = [];
    let kind = "";
    if (f.faqLike) { kind = "FAQPage"; if (!f.faq || f.faq.answerWords === 0) missing.push("answer text"); if (!f.title.trim()) missing.push("question"); }
    else if (f.articleLike) {
      kind = "Article";
      if (!f.title.trim()) missing.push("headline");
      if (!f.author.present) missing.push("author");
      if (!f.date.iso) missing.push("datePublished");
      if (f.images.length === 0) missing.push("image");
    } else if (f.productLike) {
      kind = "Product";
      if (f.images.length === 0) missing.push("image");
      if (!f.metaDescription?.text.trim() && !f.summaryPresent) missing.push("description");
    }
    if (kind && missing.length) add(f, ct, { ruleId: "AIO-004", message: `${kind} markup would be incomplete`, evidence: [`Missing for schema.org ${kind}: ${missing.join(", ")}.`] });
  }

  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return out.sort((a, b) => order[a.severity] - order[b.severity] || a.title.localeCompare(b.title));
}

// ---------- Scoring ----------

export interface SeoScores {
  seo: number | null;
  ai: number | null;
  seoEntries: number;
  aiEntries: number;
  perEntry: Map<string, { seo?: number; ai?: number }>;
}

/** Per content item: 100 − Σ penalties (high 15, medium 8, low 3), floor 0. Site score = mean over applicable entries. null = nothing applicable (never 100). */
export function scoreSeo(facts: SeoFacts[], findings: SeoFinding[]): SeoScores {
  const pen = new Map<string, { seo: number; ai: number }>();
  for (const f of findings) {
    if (f.status === "resolved" || f.entryId.startsWith("ct:")) continue;
    const p = pen.get(f.entryId) ?? { seo: 0, ai: 0 };
    p[f.category] += f.penalty;
    pen.set(f.entryId, p);
  }
  const perEntry = new Map<string, { seo?: number; ai?: number }>();
  const seoScores: number[] = [];
  const aiScores: number[] = [];
  for (const f of facts) {
    const p = pen.get(f.id) ?? { seo: 0, ai: 0 };
    const e: { seo?: number; ai?: number } = {};
    if (f.pageLike) { e.seo = Math.max(0, 100 - p.seo); seoScores.push(e.seo); }
    if (f.articleLike || f.faqLike || f.productLike) { e.ai = Math.max(0, 100 - p.ai); aiScores.push(e.ai); }
    perEntry.set(f.id, e);
  }
  const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  return { seo: mean(seoScores), ai: mean(aiScores), seoEntries: seoScores.length, aiEntries: aiScores.length, perEntry };
}

/** Demo overlay: replace a field's text with an applied suggestion and re-audit, marking resolved findings. */
export function applyTextOverrides(facts: SeoFacts[], overrides: Map<string, string>): SeoFacts[] {
  return facts.map((f) => {
    const mt = f.metaTitle ? overrides.get(`${f.id}|${f.metaTitle.path}`) : undefined;
    const md = f.metaDescription ? overrides.get(`${f.id}|${f.metaDescription.path}`) : undefined;
    if (mt === undefined && md === undefined) return f;
    return {
      ...f,
      metaTitle: f.metaTitle && mt !== undefined ? { ...f.metaTitle, text: mt } : f.metaTitle,
      metaDescription: f.metaDescription && md !== undefined ? { ...f.metaDescription, text: md } : f.metaDescription,
    };
  });
}
