import { itemDisplayTitle, localesPresent, normalizeContentType, projectLocale, shortTypeId } from "@/lib/domain/normalizer";
import type { ContentPointer, LocaleInfo, NormalizedContentType, NormalizedItem, Page, Publication } from "@/lib/domain/types";
import type { ContentAdapter, HubContext } from "./content-adapter";
import type { AmplienceClient } from "./amplience-client";

interface RawHub { id: string; name: string; label?: string; settings?: { localization?: { locales?: string[] } } }
interface RawRepository { id: string; name: string; label?: string; status?: string; itemLocales?: string[]; contentTypes?: { hubContentTypeId: string; contentTypeUri: string }[] }
interface RawSchema { id: string; schemaId: string; body: string; status?: string; validationLevel?: string }
interface RawContentType { id: string; contentTypeUri: string; status?: string; settings?: { label?: string } }
export interface RawItem {
  id: string;
  label?: string;
  locale?: string;
  version: number;
  status?: string;
  folderId?: string;
  lastModifiedDate?: string;
  lastPublishedVersion?: number;
  publishingStatus?: "NONE" | "EARLY" | "LATEST" | "UNPUBLISHED" | string;
  body: Record<string, unknown> & { _meta?: { schema?: string; name?: string; deliveryKey?: string } };
}

export interface LiveAdapterOptions {
  client: AmplienceClient;
  /** Hub id (preferred) or hub name. */
  hubId?: string;
  hubName?: string;
  masterLocale?: string;
  /** Restrict to these locales (default: the hub's locales). */
  locales?: string[];
  /** Restrict to these repository names (default: every repository without item-level locales other than the master). */
  repositories?: string[];
}

/**
 * Amplience Dynamic Content, read-only. Field-level localization: one content item carries every
 * locale, so a "localized version" is the item projected to that locale (no fallback). Items are
 * listed once per scan (per repository) and projections are computed locally.
 */
export function createLiveAdapter(opts: LiveAdapterOptions): ContentAdapter & { client: AmplienceClient; rawItem(id: string): RawItem | undefined } {
  const { client } = opts;
  let ctx: HubContext | undefined;
  let hubId: string | undefined = opts.hubId;
  let repos: RawRepository[] = [];
  let itemsPromise: Promise<Map<string, RawItem[]>> | undefined;
  const byId = new Map<string, RawItem>();
  const publishedBodies = new Map<string, Promise<RawItem | null>>();
  let typeIds: Map<string, string> | undefined; // schema URI -> short id

  const shortOf = (schemaId: string) => typeIds?.get(schemaId) ?? shortTypeId(schemaId);

  const project = (raw: RawItem, ct: string, locale: string, published?: boolean): NormalizedItem => {
    const values = projectLocale(raw.body, locale);
    return {
      uid: raw.id,
      contentTypeUid: ct,
      title: itemDisplayTitle(values, raw.label ?? raw.body._meta?.name, raw.id),
      locale,
      version: raw.version,
      updatedAt: raw.lastModifiedDate,
      deliveryKey: raw.body._meta?.deliveryKey,
      values,
      published,
      publicationKnown: published !== undefined,
    };
  };

  /** The published version of an item (cached per scan), or null when it was never published. */
  const publishedVersion = (raw: RawItem): Promise<RawItem | null> => {
    if (!raw.lastPublishedVersion || raw.publishingStatus === "NONE" || raw.publishingStatus === "UNPUBLISHED") return Promise.resolve(null);
    if (raw.lastPublishedVersion === raw.version) return Promise.resolve(raw);
    const key = `${raw.id}@${raw.lastPublishedVersion}`;
    let p = publishedBodies.get(key);
    if (!p) {
      p = client.get<RawItem>(`/content-items/${encodeURIComponent(raw.id)}/versions/${raw.lastPublishedVersion}`);
      publishedBodies.set(key, p);
    }
    return p;
  };

  /** Is this locale's content part of what Content Delivery serves? */
  const isPublished = async (raw: RawItem, locale: string, master: string): Promise<boolean> => {
    const pub = await publishedVersion(raw);
    if (!pub) return false;
    return locale === master ? true : localesPresent(pub.body).has(locale);
  };

  const loadItems = (): Promise<Map<string, RawItem[]>> => {
    itemsPromise ??= (async () => {
      const c = await adapter.getContext();
      const bySchema = new Map<string, RawItem[]>();
      for (const repo of repos) {
        const items = await client.all<RawItem>(`/content-repositories/${encodeURIComponent(repo.id)}/content-items`, "content-items", { status: "ACTIVE" });
        for (const it of items) {
          // Item-level localization (a separate item per locale) is out of scope: keep master-locale or locale-less items.
          if (it.locale && it.locale !== c.masterLocale) continue;
          const schema = it.body?._meta?.schema;
          if (!schema) continue;
          byId.set(it.id, it);
          bySchema.set(schema, [...(bySchema.get(schema) ?? []), it]);
        }
      }
      return bySchema;
    })();
    return itemsPromise;
  };

  const findRaw = async (ct: string, id: string): Promise<RawItem | undefined> => {
    await loadItems();
    const raw = byId.get(id);
    return raw && shortOf(raw.body._meta?.schema ?? "") === ct ? raw : undefined;
  };

  const adapter: ContentAdapter & { client: AmplienceClient; rawItem(id: string): RawItem | undefined } = {
    kind: "live",
    client,
    rawItem: (id) => byId.get(id),

    async getContext() {
      if (ctx) return ctx;
      let hub: RawHub;
      if (hubId) hub = await client.get<RawHub>(`/hubs/${encodeURIComponent(hubId)}`);
      else {
        const hubs = await client.all<RawHub>("/hubs", "hubs");
        const hit = hubs.find((h) => h.name === opts.hubName);
        if (!hit) throw new Error(`Hub "${opts.hubName}" is not visible to this token`);
        hub = hit;
      }
      hubId = hub.id;
      const hubLocales = hub.settings?.localization?.locales ?? [];
      const wanted = opts.locales?.length ? opts.locales : hubLocales;
      if (!wanted.length) throw new Error("The hub has no locales configured (Settings → Localization) and AMPLIENCE_LOCALES is empty");
      const unknown = opts.locales?.filter((l) => hubLocales.length && !hubLocales.includes(l)) ?? [];
      if (unknown.length) throw new Error(`AMPLIENCE_LOCALES contains locales the hub does not have: ${unknown.join(", ")}`);
      const master = opts.masterLocale ?? wanted[0]!;
      if (!wanted.includes(master)) throw new Error(`Master locale "${master}" is not one of the scanned locales (${wanted.join(", ")})`);
      const locales: LocaleInfo[] = wanted.map((code) => ({ code, name: code, fallbackLocale: null }));

      const all = await client.all<RawRepository>(`/hubs/${encodeURIComponent(hub.id)}/content-repositories`, "content-repositories");
      repos = opts.repositories?.length
        ? all.filter((r) => opts.repositories!.includes(r.name))
        : all.filter((r) => r.status !== "ARCHIVED" && (r.contentTypes?.length ?? 0) > 0 && (!r.itemLocales?.length || r.itemLocales.includes(master)));
      if (opts.repositories?.length && repos.length !== opts.repositories.length) {
        const missing = opts.repositories.filter((n) => !all.some((r) => r.name === n));
        throw new Error(`Content repositories not found in the hub: ${missing.join(", ")}`);
      }
      ctx = { hub: hub.name, hubId: hub.id, repositories: repos.map((r) => r.name), masterLocale: master, locales };
      return ctx;
    },

    async listContentTypes(): Promise<NormalizedContentType[]> {
      await adapter.getContext();
      const [schemas, types] = await Promise.all([
        client.all<RawSchema>(`/hubs/${encodeURIComponent(hubId!)}/content-type-schemas`, "content-type-schemas", { status: "ACTIVE" }),
        client.all<RawContentType>(`/hubs/${encodeURIComponent(hubId!)}/content-types`, "content-types", { status: "ACTIVE" }),
      ]);
      // Only registered content types count; their short ids must be unique (fall back to the full URI on a clash).
      const registered = types.filter((t) => schemas.some((s) => s.schemaId === t.contentTypeUri));
      const counts = new Map<string, number>();
      for (const t of registered) counts.set(shortTypeId(t.contentTypeUri), (counts.get(shortTypeId(t.contentTypeUri)) ?? 0) + 1);
      typeIds = new Map(registered.map((t) => [t.contentTypeUri, counts.get(shortTypeId(t.contentTypeUri))! > 1 ? t.contentTypeUri : shortTypeId(t.contentTypeUri)]));
      return registered.map((t) => {
        const s = schemas.find((x) => x.schemaId === t.contentTypeUri)!;
        const ct = normalizeContentType({ schemaId: s.schemaId, body: s.body, label: t.settings?.label });
        return { ...ct, uid: typeIds!.get(t.contentTypeUri)! };
      });
    },

    async listSourceItems({ contentTypeUid, cursor }): Promise<Page<NormalizedItem>> {
      const c = await adapter.getContext();
      const bySchema = await loadItems();
      const schemaId = [...(typeIds ?? new Map()).entries()].find(([, short]) => short === contentTypeUid)?.[0];
      const all = (schemaId ? bySchema.get(schemaId) : undefined) ?? [];
      const start = cursor ? Number(cursor) : 0;
      const slice = all.slice(start, start + 100);
      const items = await Promise.all(slice.map(async (raw) => project(raw, contentTypeUid, c.masterLocale, await isPublished(raw, c.masterLocale, c.masterLocale).catch(() => undefined))));
      const next = start + slice.length;
      return { items, total: all.length, cursor: next < all.length ? String(next) : undefined };
    },

    async getLocalePresence({ contentTypeUid, itemId }) {
      const raw = await findRaw(contentTypeUid, itemId);
      return raw ? [...localesPresent(raw.body)] : [];
    },

    async getLocalizedItem(p: ContentPointer) {
      const c = await adapter.getContext();
      const raw = await findRaw(p.contentTypeUid, p.itemId);
      if (!raw || !localesPresent(raw.body).has(p.locale)) return null;
      const published = await isPublished(raw, p.locale, c.masterLocale).catch(() => undefined);
      return project(raw, p.contentTypeUid, p.locale, published);
    },

    async getPublicationState(p: ContentPointer): Promise<Publication> {
      const e = await adapter.getLocalizedItem(p);
      if (!e || !e.publicationKnown) return "unknown";
      return e.published ? "published" : "unpublished";
    },
  };
  return adapter;
}

/** Fresh read of one item (bypasses the scan cache). Used by the writer before and after a write. */
export async function readItem(client: AmplienceClient, id: string): Promise<RawItem> {
  return client.get<RawItem>(`/content-items/${encodeURIComponent(id)}`);
}
