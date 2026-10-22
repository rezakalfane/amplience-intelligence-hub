import { LOCALIZED_VALUE, isLocalizedValue } from "./normalizer";

// Paths address the locale projection of an item body (`steps[2].title`, `tags[1]`). In the raw
// body the same path ends at a `localized-value` object (or an array of them, for arrays of
// localized strings), which holds one `{ locale, value }` per locale.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

interface Token { name: string; index?: number }

export function parsePath(path: string): Token[] | null {
  const out: Token[] = [];
  for (const part of path.split(".")) {
    const m = /^([^[\]]+)((?:\[\d+\])*)$/.exec(part);
    if (!m) return null;
    out.push({ name: m[1] as string });
    for (const idx of (m[2] ?? "").matchAll(/\[(\d+)\]/g)) out.push({ name: "", index: Number(idx[1]) });
  }
  return out;
}

interface Slot {
  /** Container and key holding the localized value (or the array of localized values). */
  holder: Obj | unknown[];
  key: string | number;
  /** Index inside an array-valued localized value (`{ values: [{ value: [...] }] }`). */
  inner?: number;
}

function locate(root: Obj, path: string): Slot | null {
  const tokens = parsePath(path);
  if (!tokens?.length) return null;
  let holder: Obj | unknown[] = root;
  let key: string | number = "";
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (i > 0) {
      const cur: unknown = (holder as Record<string | number, unknown>)[key];
      if (t.index !== undefined && isLocalizedValue(cur)) return i === tokens.length - 1 ? { holder, key, inner: t.index } : null;
      if (t.index !== undefined ? !Array.isArray(cur) : !isObj(cur)) return null;
      holder = cur as Obj | unknown[];
    }
    key = t.index !== undefined ? t.index : t.name;
  }
  return { holder, key };
}

const findValue = (lv: { values: { locale: string; value: unknown }[] }, locale: string) =>
  lv.values.find((v) => v?.locale?.toLowerCase() === locale.toLowerCase());

/** The text a locale holds at `path` in a raw item body (undefined when absent). */
export function getLocalizedText(body: Obj, path: string, locale: string): string | undefined {
  const slot = locate(body, path);
  if (!slot) return undefined;
  const lv = (slot.holder as Record<string | number, unknown>)[slot.key];
  if (!isLocalizedValue(lv)) return undefined;
  const v = findValue(lv, locale)?.value;
  const text = slot.inner !== undefined ? (Array.isArray(v) ? v[slot.inner] : undefined) : v;
  return typeof text === "string" ? text : undefined;
}

/**
 * Set (insert or replace) one locale's text at `path` in a raw item body. Creates the localized value
 * when the field is absent but its parent exists. Returns false when the path does not resolve, or
 * resolves to a field that is not localized (shared by every locale: never written from here).
 */
export function setLocalizedText(body: Obj, path: string, locale: string, text: string): boolean {
  const slot = locate(body, path);
  if (!slot) return false;
  const h = slot.holder as Record<string | number, unknown>;
  let lv = h[slot.key];
  if (lv === undefined || lv === null) {
    if (slot.inner !== undefined) return false;
    lv = { _meta: { schema: LOCALIZED_VALUE }, values: [] };
    h[slot.key] = lv;
  }
  if (!isLocalizedValue(lv)) return false;
  let entry = findValue(lv, locale);
  if (!entry) {
    entry = { locale, value: slot.inner !== undefined ? [] : "" };
    lv.values.push(entry);
  }
  if (slot.inner !== undefined) {
    const arr = Array.isArray(entry.value) ? [...entry.value] : [];
    while (arr.length < slot.inner) arr.push("");
    arr[slot.inner] = text;
    entry.value = arr;
  } else entry.value = text;
  return true;
}

/** Remove one locale's value at `path` (the field then falls back at delivery). Returns the removed text. */
export function removeLocalizedText(body: Obj, path: string, locale: string): string | undefined {
  const slot = locate(body, path);
  if (!slot || slot.inner !== undefined) return undefined;
  const lv = (slot.holder as Record<string | number, unknown>)[slot.key];
  if (!isLocalizedValue(lv)) return undefined;
  const i = lv.values.findIndex((v) => v?.locale?.toLowerCase() === locale.toLowerCase());
  if (i < 0) return undefined;
  const [removed] = lv.values.splice(i, 1);
  return typeof removed?.value === "string" ? removed.value : undefined;
}
