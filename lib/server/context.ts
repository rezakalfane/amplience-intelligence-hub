import "server-only";
import { cache } from "react";
import { amplienceLinkBase, getEnv, publicIntegrationStatus } from "@/lib/security/env";
import { store } from "@/lib/store/store";
import { getView, liveConfigured, resolveMode } from "./data";

/** One load per request, shared by layout and page. */
export const loadContext = cache(async () => {
  const mode = await resolveMode();
  const data = await store.read(mode);
  const view = await getView(mode, data);
  return {
    mode,
    view,
    audit: data.audit,
    history: data.history ?? [],
    liveConfigured: liveConfigured(),
    // Deep links exist only for real data; demo items do not exist in any hub.
    links: mode === "live" ? amplienceLinkBase(getEnv(), data.snapshot?.hub) : null,
    status: publicIntegrationStatus(getEnv()),
    renderedAt: Date.now(),
  };
});
