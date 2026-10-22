import type { ContentPointer, NormalizedContentType, NormalizedItem, Page, Publication } from "@/lib/domain/types";
import { buildDemoWorld, DEMO_CONTENT_TYPES, DEMO_HUB, DEMO_LOCALES, DEMO_MASTER } from "@/lib/demo/fixtures";
import type { ContentAdapter, HubContext } from "./content-adapter";

export function createDemoAdapter(): ContentAdapter {
  const world = buildDemoWorld();
  return {
    kind: "demo",
    async getContext(): Promise<HubContext> {
      return { hub: DEMO_HUB, repositories: ["content (sample)"], masterLocale: DEMO_MASTER, locales: DEMO_LOCALES };
    },
    async listContentTypes(): Promise<NormalizedContentType[]> {
      return DEMO_CONTENT_TYPES;
    },
    async listSourceItems({ contentTypeUid }): Promise<Page<NormalizedItem>> {
      const items = world.sourceItems.filter((e) => e.contentTypeUid === contentTypeUid);
      return { items, total: items.length };
    },
    async getLocalePresence({ contentTypeUid, itemId }) {
      return world.presence.get(`${contentTypeUid}/${itemId}`) ?? [];
    },
    async getLocalizedItem(p: ContentPointer) {
      return world.targets.get(`${p.contentTypeUid}/${p.itemId}/${p.locale}`) ?? null;
    },
    async getPublicationState(p: ContentPointer): Promise<Publication> {
      const t = world.targets.get(`${p.contentTypeUid}/${p.itemId}/${p.locale}`);
      return t?.published ? "published" : "unpublished";
    },
    getApprovalBaselines: () => world.baselines,
  };
}
