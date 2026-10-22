import type { ContentPointer, LocaleInfo, NormalizedContentType, NormalizedItem, Page, Publication } from "@/lib/domain/types";

export interface HubContext {
  /** Hub name (the `<name>` in `<name>.cdn.content.amplience.net`). */
  hub: string;
  hubId?: string;
  /** Content repositories scanned (names). */
  repositories: string[];
  masterLocale: string;
  locales: LocaleInfo[];
}

/** Read-only contract. Writes live in a separate, guarded writer (lib/security/write-policy + lib/adapters/live-writer). */
export interface ContentAdapter {
  kind: "demo" | "live";
  getContext(): Promise<HubContext>;
  listContentTypes(): Promise<NormalizedContentType[]>;
  /** Master-locale projection of the content items of one content type. */
  listSourceItems(input: { contentTypeUid: string; cursor?: string }): Promise<Page<NormalizedItem>>;
  /** Locales holding at least one localized value in the item (delivery fallback is NOT presence). */
  getLocalePresence(input: { contentTypeUid: string; itemId: string }): Promise<string[]>;
  /** Projection of the item to `pointer.locale`, without fallback. */
  getLocalizedItem(input: ContentPointer): Promise<NormalizedItem | null>;
  getPublicationState(input: ContentPointer): Promise<Publication>;
  /** Demo only: pre-existing approval baselines used to derive freshness. */
  getApprovalBaselines?(): Map<string, string>;
}

export type WriteResult =
  | { ok: true; readBackVerified: true; itemVersion: number }
  | { ok: false; code: "writes_disabled" | "conflict" | "forbidden" | "failed"; message: string };
