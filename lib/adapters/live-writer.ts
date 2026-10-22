import "server-only";
import { extractLeaves, normalizeContentType, projectLocale, type RawContentTypeSchema } from "@/lib/domain/normalizer";
import { fingerprint, normalizeText } from "@/lib/domain/fingerprint";
import { getLocalizedText, setLocalizedText } from "@/lib/domain/path";
import { effectiveText } from "@/lib/domain/review";
import type { TranslationProposal } from "@/lib/domain/types";
import { evaluateWritePolicy } from "@/lib/security/write-policy";
import type { Env } from "@/lib/security/env";
import type { WriteResult } from "./content-adapter";
import type { AmplienceClient } from "./amplience-client";
import { readItem } from "./live-adapter";

export interface WriterDeps {
  env: Pick<Env, "ENABLE_CMS_WRITES" | "AMPLIENCE_WRITE_PAT" | "CMS_WRITE_ALLOWED_ITEM_IDS">;
  mode: "live" | "demo";
  hubId: string;
  masterLocale: string;
  /** Read client (scan token): fresh reads before and after the write. */
  readClient: AmplienceClient;
  writeClient?: AmplienceClient;
}

/**
 * Guarded write of ONE reviewed text field: sets the target locale's value inside the field's
 * localized value and saves the content item. Never publishes (Content Delivery is untouched).
 * The PATCH carries the item version the checks ran against, so Amplience itself rejects the save
 * if anyone changed the item in between (server-side optimistic lock).
 */
export async function applyReviewedProposal(deps: WriterDeps, proposal: TranslationProposal, confirm: boolean): Promise<WriteResult> {
  const { pointer } = proposal;
  const policy = evaluateWritePolicy(deps.env, deps.mode, { itemId: pointer.itemId }, confirm);
  if (!policy.allowed) return { ok: false, code: policy.code, message: policy.reason };
  if (!deps.writeClient) return { ok: false, code: "writes_disabled", message: "No write client configured" };
  if (proposal.status !== "approved") return { ok: false, code: "forbidden", message: "Only approved proposals can be written" };

  try {
    // Fresh read of the item and of its content type schema.
    const item = await readItem(deps.readClient, pointer.itemId);
    if (item.status && item.status !== "ACTIVE") return { ok: false, code: "conflict", message: "The content item is archived or deleted; re-review required" };
    const schemaId = item.body?._meta?.schema;
    if (!schemaId) return { ok: false, code: "failed", message: "The content item has no schema" };
    const schemas = await deps.readClient.all<RawContentTypeSchema>(`/hubs/${encodeURIComponent(deps.hubId)}/content-type-schemas`, "content-type-schemas", { status: "ACTIVE" });
    const raw = schemas.find((s) => s.schemaId === schemaId);
    if (!raw) return { ok: false, code: "failed", message: "Content type schema not found" };
    const ct = normalizeContentType(raw);

    const sourceLeaf = extractLeaves(ct.schema, projectLocale(item.body, deps.masterLocale)).find((l) => l.path === pointer.fieldPath);
    if (!sourceLeaf || (sourceLeaf.kind !== "text" && sourceLeaf.kind !== "markdown")) return { ok: false, code: "failed", message: "Only localized text and markdown fields can be written" };
    if (sourceLeaf.nonLocalizable) return { ok: false, code: "forbidden", message: "The field is not localized (shared by every locale); it is never written from here" };
    if (fingerprint(sourceLeaf.text) !== proposal.sourceFingerprint) {
      return { ok: false, code: "conflict", message: "Source text changed since the proposal (409): re-review required" };
    }
    if (proposal.cmsVersionAtProposal !== undefined && item.version !== proposal.cmsVersionAtProposal) {
      return { ok: false, code: "conflict", message: `Content item is at version ${item.version}, proposal was made at ${proposal.cmsVersionAtProposal} (409): re-review required` };
    }

    const body = structuredClone(item.body);
    const text = effectiveText(proposal);
    if (!setLocalizedText(body, pointer.fieldPath, pointer.locale, text)) return { ok: false, code: "failed", message: "Could not resolve the field path in the content item body" };

    await deps.writeClient.patch(`/content-items/${encodeURIComponent(item.id)}`, { body, version: item.version, label: item.label });

    // Read-back verification.
    const after = await readItem(deps.readClient, pointer.itemId);
    const back = getLocalizedText(after.body, pointer.fieldPath, pointer.locale);
    if (back === undefined || normalizeText(back) !== normalizeText(text)) {
      return { ok: false, code: "failed", message: "Save returned success but read-back did not match the approved text" };
    }
    return { ok: true, readBackVerified: true, itemVersion: after.version };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 409) return { ok: false, code: "conflict", message: "Amplience rejected the save: the item changed since it was read (409). Re-review required." };
    return { ok: false, code: "failed", message: err instanceof Error ? err.message : "Write failed" };
  }
}
