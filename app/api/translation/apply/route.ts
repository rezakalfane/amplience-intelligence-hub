import { NextResponse } from "next/server";
import { z } from "zod";
import { AmplienceClient } from "@/lib/adapters/amplience-client";
import { applyReviewedProposal } from "@/lib/adapters/live-writer";
import { resolveMode } from "@/lib/server/data";
import { findProposal, ServiceError, stepProposal } from "@/lib/server/proposals";
import { makeLiveClient } from "@/lib/server/sync";
import { getSnapshot } from "@/lib/server/data";
import { getEnv } from "@/lib/security/env";
import { guardMutation, isResponse, jsonError } from "@/lib/security/request-guard";
import { evaluateWritePolicy } from "@/lib/security/write-policy";

export const dynamic = "force-dynamic";

const Body = z.object({ proposalId: z.string().min(1), target: z.enum(["demo", "cms"]), confirm: z.boolean().default(false) });

export async function POST(req: Request) {
  const guard = guardMutation(req);
  if (isResponse(guard)) return guard;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return jsonError("Invalid request", 400);
  const mode = await resolveMode();
  const env = getEnv();

  try {
    const proposal = await findProposal(mode, body.data.proposalId);

    if (body.data.target === "demo") {
      if (mode !== "demo") return jsonError("'Apply to demo' only exists in DEMO mode. Live data is never modified by this action.", 409);
      return NextResponse.json({ proposal: await stepProposal(mode, proposal.id, { type: "apply_to_demo", actorId: guard.actorId }) });
    }

    if (proposal.task === "seo") {
      return jsonError("Live CMS write is not available for SEO suggestions. Copy the approved text into Amplience.", 409, { code: "seo_write_unsupported" });
    }

    // target === "cms": disabled by default, separately authorised, saves the item, never publishes.
    const decision = evaluateWritePolicy(env, mode, { itemId: proposal.pointer.itemId }, body.data.confirm);
    if (!decision.allowed) return jsonError(decision.reason, 403, { code: decision.code });

    const read = makeLiveClient();
    const snapshot = await getSnapshot("live");
    const hubId = snapshot?.hubId ?? env.AMPLIENCE_HUB_ID;
    if ("error" in read || !env.AMPLIENCE_WRITE_PAT || !hubId || !snapshot) return jsonError("Write client could not be configured (run a live scan first)", 503);
    const writeClient = new AmplienceClient({ token: env.AMPLIENCE_WRITE_PAT });

    await stepProposal(mode, proposal.id, { type: "write_start", actorId: guard.actorId });
    const result = await applyReviewedProposal({ env, mode, hubId, masterLocale: snapshot.masterLocale, readClient: read.client, writeClient }, proposal, body.data.confirm);
    const updated = await stepProposal(mode, proposal.id, {
      type: "write_result", actorId: guard.actorId, ok: result.ok, readBackVerified: result.ok, error: result.ok ? undefined : result.message,
    });
    if (!result.ok) return jsonError(result.message, result.code === "conflict" ? 409 : 502, { code: result.code, proposal: updated });
    return NextResponse.json({ proposal: updated, itemVersion: result.itemVersion, note: "Content item saved. NOT published." });
  } catch (err) {
    if (err instanceof ServiceError) return jsonError(err.message, err.status, { code: err.code });
    return jsonError("Unexpected error", 500);
  }
}
