import type { Env } from "./env";

export type WriteDecision = { allowed: true } | { allowed: false; code: "writes_disabled" | "forbidden"; reason: string };

/** Live CMS writes are off unless every condition holds. Publishing is never available. */
export function evaluateWritePolicy(
  env: Pick<Env, "ENABLE_CMS_WRITES" | "AMPLIENCE_WRITE_PAT" | "CMS_WRITE_ALLOWED_ITEM_IDS">,
  mode: "live" | "demo",
  target: { itemId: string },
  confirm: boolean,
): WriteDecision {
  if (mode !== "live") return { allowed: false, code: "writes_disabled", reason: "Demo mode never writes to Amplience" };
  if (!env.ENABLE_CMS_WRITES) return { allowed: false, code: "writes_disabled", reason: "ENABLE_CMS_WRITES is false (default). Live writes are disabled." };
  if (!env.AMPLIENCE_WRITE_PAT) return { allowed: false, code: "writes_disabled", reason: "No separate AMPLIENCE_WRITE_PAT is configured" };
  const allowed = (env.CMS_WRITE_ALLOWED_ITEM_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(target.itemId)) {
    return { allowed: false, code: "forbidden", reason: "Content item is not in CMS_WRITE_ALLOWED_ITEM_IDS (writes are limited to designated test items)" };
  }
  if (!confirm) return { allowed: false, code: "forbidden", reason: "Explicit confirmation is required" };
  return { allowed: true };
}
