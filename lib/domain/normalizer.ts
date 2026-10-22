import type { NormalizedContentType, SchemaField } from "./types";

// ---------- Amplience content type schema (JSON Schema) -> SchemaField ----------

const CORE = "http://bigcontent.io/cms/schema/v1/core#/definitions/";
export const LOCALIZED_VALUE = `${CORE}localized-value`;
export const CONTENT_LINK = `${CORE}content-link`;
export const CONTENT_REFERENCE = `${CORE}content-reference`;
export const IMAGE_LINK = `${CORE}image-link`;
export const VIDEO_LINK = `${CORE}video-link`;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Short id of a content type: the last path segment of its schema URI (`https://x.com/buying-guide` -> `buying-guide`). */
export function shortTypeId(schemaId: string): string {
  const clean = schemaId.replace(/[#?].*$/, "").replace(/\/+$/, "");
  return clean.slice(clean.lastIndexOf("/") + 1) || schemaId;
}

/** Every `$ref` reachable through allOf/anyOf/oneOf (not through properties). */
function refsOf(node: Json): string[] {
  const out: string[] = [];
  if (typeof node.$ref === "string") out.push(node.$ref);
  for (const k of ["allOf", "anyOf", "oneOf"]) {
    const list = node[k];
    if (Array.isArray(list)) for (const s of list) if (isObj(s)) out.push(...refsOf(s));
  }
  return out;
}

/** Content types allowed by a link (`properties.contentType.enum`, possibly inside allOf). */
function linkTargets(node: Json): string[] {
  const out: string[] = [];
  const visit = (n: Json) => {
    const ct = isObj(n.properties) ? (n.properties as Json).contentType : undefined;
    if (isObj(ct) && Array.isArray(ct.enum)) out.push(...ct.enum.filter((x): x is string => typeof x === "string").map(shortTypeId));
    for (const k of ["allOf", "anyOf", "oneOf"]) {
      const list = n[k];
      if (Array.isArray(list)) for (const s of list) if (isObj(s)) visit(s);
    }
  };
  visit(node);
  return [...new Set(out)];
}

/** Schema of the inner `value` of a localized-value property (`properties.values.items.properties.value`). */
function localizedInner(node: Json): Json {
  const values = isObj(node.properties) ? (node.properties as Json).values : undefined;
  const items = isObj(values) ? values.items : undefined;
  const value = isObj(items) && isObj(items.properties) ? (items.properties as Json).value : undefined;
  return isObj(value) ? value : { type: "string" };
}

const isDateFormat = (f: unknown) => f === "date" || f === "date-time";

interface Classified {
  dataType: SchemaField["dataType"];
  localized: boolean;
  multiple: boolean;
  hasEnum: boolean;
  referenceTo?: string[];
  properties?: Json;
  required?: string[];
}

function classify(node: Json): Classified {
  const refs = refsOf(node);
  const base = { localized: false, multiple: false, hasEnum: Array.isArray(node.enum) };
  if (refs.includes(LOCALIZED_VALUE)) {
    const inner = localizedInner(node);
    if (inner.type === "array") {
      const item = isObj(inner.items) ? inner.items : {};
      return { ...base, dataType: item.format === "markdown" ? "markdown" : item.type === "string" ? "text" : "other", localized: true, multiple: true, hasEnum: Array.isArray(item.enum) };
    }
    const dataType = inner.format === "markdown" ? "markdown" : inner.type === "string" ? (isDateFormat(inner.format) ? "date" : "text") : inner.type === "number" || inner.type === "integer" ? "number" : inner.type === "boolean" ? "boolean" : "other";
    return { ...base, dataType, localized: true, hasEnum: Array.isArray(inner.enum) };
  }
  if (refs.includes(CONTENT_LINK) || refs.includes(CONTENT_REFERENCE)) return { ...base, dataType: "reference", referenceTo: linkTargets(node) };
  if (refs.includes(IMAGE_LINK)) return { ...base, dataType: "image" };
  if (refs.includes(VIDEO_LINK)) return { ...base, dataType: "video" };
  if (node.type === "array") {
    const item = isObj(node.items) ? node.items : {};
    const c = classify(item);
    return { ...c, multiple: true };
  }
  if (node.type === "object" || isObj(node.properties)) {
    return { ...base, dataType: "object", properties: isObj(node.properties) ? node.properties : {}, required: Array.isArray(node.required) ? (node.required as string[]) : [] };
  }
  if (node.type === "string") return { ...base, dataType: node.format === "markdown" ? "markdown" : isDateFormat(node.format) ? "date" : "text" };
  if (node.type === "number" || node.type === "integer") return { ...base, dataType: "number" };
  if (node.type === "boolean") return { ...base, dataType: "boolean" };
  return { ...base, dataType: "other" };
}

export function normalizeProperties(properties: Json, required: string[] = [], depth = 0): SchemaField[] {
  if (depth > 8) return []; // guard against pathological nesting
  const out: SchemaField[] = [];
  for (const [uid, raw] of Object.entries(properties)) {
    if (uid === "_meta" || !isObj(raw)) continue;
    const c = classify(raw);
    const field: SchemaField = {
      uid,
      displayName: typeof raw.title === "string" && raw.title ? raw.title : uid,
      dataType: c.dataType,
      mandatory: required.includes(uid),
      multiple: c.multiple,
      localized: c.localized,
      hasEnum: c.hasEnum,
    };
    if (c.dataType === "reference") field.referenceTo = c.referenceTo ?? [];
    if (c.dataType === "object") field.schema = normalizeProperties(c.properties ?? {}, c.required, depth + 1);
    out.push(field);
  }
  return out;
}

/** A content type schema as returned by `GET /hubs/{id}/content-type-schemas` (`body` is a JSON string). */
export interface RawContentTypeSchema {
  schemaId: string;
  body: string | Json;
  /** Label of the registered content type (falls back to the schema title). */
  label?: string;
}

export function normalizeContentType(raw: RawContentTypeSchema): NormalizedContentType {
  const body = (typeof raw.body === "string" ? JSON.parse(raw.body) : raw.body) as Json;
  const properties = isObj(body.properties) ? body.properties : {};
  const required = Array.isArray(body.required) ? (body.required as string[]) : [];
  const schema = normalizeProperties(properties, required);
  // `_meta.deliveryKey` declared in the schema: expose it as a read-only, non-localized text field.
  const meta = properties._meta;
  if (isObj(meta) && isObj(meta.properties) && "deliveryKey" in (meta.properties as Json)) {
    schema.unshift({ uid: "deliveryKey", displayName: "Delivery key", dataType: "text", mandatory: false, multiple: false, localized: false, hasEnum: false });
  }
  return { uid: shortTypeId(raw.schemaId), schemaId: raw.schemaId, title: raw.label ?? (typeof body.title === "string" ? body.title : shortTypeId(raw.schemaId)), schema };
}

// ---------- Item body -> locale projection ----------

export const isLocalizedValue = (v: unknown): v is { values: { locale: string; value: unknown }[] } =>
  isObj(v) && isObj(v._meta) && v._meta.schema === LOCALIZED_VALUE && Array.isArray(v.values);

/**
 * The body as one locale sees it: every localized value is replaced by that locale's value, with
 * NO fallback (a missing locale is `undefined`). `_meta` is dropped; links and assets are kept.
 * `_meta.deliveryKey` is surfaced as `deliveryKey`.
 */
export function projectLocale(body: Json, locale: string): Json {
  const visit = (v: unknown): unknown => {
    if (isLocalizedValue(v)) {
      const hit = v.values.find((x) => x?.locale?.toLowerCase() === locale.toLowerCase());
      return hit ? visit(hit.value) : undefined;
    }
    if (Array.isArray(v)) return v.map(visit);
    if (isObj(v)) {
      const o: Json = {};
      for (const [k, x] of Object.entries(v)) if (k !== "_meta") o[k] = visit(x);
      return o;
    }
    return v;
  };
  const out = visit(body) as Json;
  const key = isObj(body._meta) ? body._meta.deliveryKey : undefined;
  if (typeof key === "string" && key) out.deliveryKey = key;
  return out;
}

/** Locales that hold at least one non-empty localized value anywhere in the body. */
export function localesPresent(body: unknown): Set<string> {
  const out = new Set<string>();
  const visit = (v: unknown) => {
    if (isLocalizedValue(v)) {
      for (const x of v.values) {
        const val = x?.value;
        const filled = typeof val === "string" ? val.trim() !== "" : Array.isArray(val) ? val.length > 0 : val !== undefined && val !== null;
        if (filled && typeof x.locale === "string") out.add(x.locale);
      }
      return;
    }
    if (Array.isArray(v)) v.forEach(visit);
    else if (isObj(v)) Object.values(v).forEach(visit);
  };
  visit(body);
  return out;
}

// ---------- Policy: text fields that are identifiers, not copy ----------

/** Disclosed in the UI as a policy exclusion. */
export const EXCLUDED_TEXT_FIELD = /^(url|slug|href|src|email|deliveryKey|account|.*_url|.*Url|.*_sku|.*Sku|.*_skus|.*_email|.*phone.*)$/i;
export const EXCLUSION_POLICY_NOTE =
  "Fields excluded by policy (identifiers, not copy): delivery key, url, slug, href, src, account, *Sku/*_sku, *Url/*_url, *email*, *phone*, enum fields, fields that are not localized.";

// ---------- Item values -> translatable leaves ----------

export interface Leaf {
  path: string;
  /** Same leaf addressed by array position (identical to `path` for Amplience items, kept for matching). */
  ppath: string;
  label: string;
  kind: "text" | "markdown";
  mandatory: boolean;
  /** The field is not localized (shared by every locale). */
  nonLocalizable: boolean;
  text: string;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Walk a schema against projected item values and emit every translatable leaf (including empty ones).
 * Array items are addressed by position (`steps[2].title`).
 */
export function extractLeaves(schema: SchemaField[], values: Record<string, unknown>): Leaf[] {
  const out: Leaf[] = [];
  const visit = (fields: SchemaField[], data: Record<string, unknown>, prefix: string, labelPrefix: string, inheritedLocalized: boolean) => {
    for (const f of fields) {
      const value = data?.[f.uid];
      const path = prefix ? `${prefix}.${f.uid}` : f.uid;
      const label = labelPrefix ? `${labelPrefix} › ${f.displayName}` : f.displayName;
      const localized = inheritedLocalized || f.localized;

      switch (f.dataType) {
        case "text":
        case "markdown": {
          if (f.hasEnum || EXCLUDED_TEXT_FIELD.test(f.uid)) break;
          const kind = f.dataType;
          if (f.multiple) {
            asArray(value).forEach((item, i) =>
              out.push({ path: `${path}[${i}]`, ppath: `${path}[${i}]`, label: `${label} #${i + 1}`, kind, mandatory: f.mandatory, nonLocalizable: !localized, text: typeof item === "string" ? item : "" }),
            );
          } else {
            out.push({ path, ppath: path, label, kind, mandatory: f.mandatory, nonLocalizable: !localized, text: typeof value === "string" ? value : "" });
          }
          break;
        }
        case "object": {
          if (f.multiple) {
            asArray(value).forEach((item, i) => {
              if (isObj(item)) visit(f.schema ?? [], item, `${path}[${i}]`, `${label} #${i + 1}`, localized);
            });
          } else if (isObj(value)) visit(f.schema ?? [], value, path, label, localized);
          break;
        }
        default:
          break; // links, assets, numbers, booleans, dates: not translatable text
      }
    }
  };
  visit(schema, values, "", "", false);
  return out;
}

/** Display title: the `title` field (or a question/heading/name), then the item label, then the id. */
export function itemDisplayTitle(values: Record<string, unknown>, label: string | undefined, fallback: string): string {
  for (const k of ["title", "question", "heading", "name", "message"]) {
    const v = values[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return label?.trim() || fallback;
}

/** Index target leaves for matching (by path, then by position). */
export function indexLeaves(leaves: Leaf[]) {
  return { byPath: new Map(leaves.map((l) => [l.path, l])), byPos: new Map(leaves.map((l) => [l.ppath, l])) };
}

export function matchLeaf(idx: ReturnType<typeof indexLeaves>, source: Leaf): { leaf?: Leaf; byPosition: boolean } {
  const direct = idx.byPath.get(source.path);
  if (direct) return { leaf: direct, byPosition: false };
  const pos = source.path === source.ppath ? undefined : idx.byPos.get(source.ppath);
  return { leaf: pos, byPosition: Boolean(pos) };
}
