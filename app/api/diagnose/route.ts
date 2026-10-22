import { NextResponse } from "next/server";
import { AmplienceApiError } from "@/lib/adapters/amplience-client";
import { makeLiveAdapter, makeLiveClient } from "@/lib/server/sync";
import { guardMutation, isResponse } from "@/lib/security/request-guard";

export const dynamic = "force-dynamic";

type State = "connected" | "forbidden" | "wrong_hub_or_token" | "network_error" | "no_content_types" | "not_configured";

/** Connect & Diagnose: read-only calls, sanitized result. */
export async function POST(req: Request) {
  const guard = guardMutation(req);
  if (isResponse(guard)) return guard;
  const made = makeLiveClient();
  if ("error" in made) return NextResponse.json({ state: "not_configured" as State, message: made.error });
  const adapter = makeLiveAdapter(made.client);
  const started = Date.now();
  try {
    const ctx = await adapter.getContext();
    const types = await adapter.listContentTypes();
    const count = types.length;
    return NextResponse.json({
      state: (count === 0 ? "no_content_types" : "connected") as State,
      message: count === 0 ? "Connected, but the hub has no registered content types" : "Connected to Amplience (read-only)",
      hub: ctx.hub, repositories: ctx.repositories, contentTypes: count, latencyMs: Date.now() - started,
      locales: ctx.locales.map((l) => ({ code: l.code, master: l.code === ctx.masterLocale })),
    });
  } catch (err) {
    const e = err instanceof AmplienceApiError ? err : undefined;
    const state: State = !e
      ? err instanceof Error ? "wrong_hub_or_token" : "network_error"
      : e.kind === "network" || e.kind === "timeout" ? "network_error" : e.kind === "forbidden" ? "forbidden" : e.kind === "unauthorized" || e.kind === "bad_request" || e.kind === "not_found" ? "wrong_hub_or_token" : "network_error";
    return NextResponse.json({
      state, message: err instanceof Error ? err.message : "Network error",
      hint: state === "wrong_hub_or_token" ? "Check that AMPLIENCE_HUB_ID (or AMPLIENCE_HUB_NAME) names a hub this personal access token can read, and that AMPLIENCE_LOCALES / AMPLIENCE_REPOSITORIES exist in it." : state === "forbidden" ? "The token's user lacks permission on this hub or one of its repositories." : undefined,
    });
  }
}
